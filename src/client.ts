import { createWriteStream } from "node:fs";
import { link, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { AppStoreConnectConfig } from "./config.js";
import { AppStoreConnectError, SafetyError } from "./errors.js";
import { resolveOutputFile } from "./fs-safety.js";
import type {
  ApiResponse,
  AppleApiError,
  HttpMethod,
  JsonApiDocument,
  Query,
  ResponseMetadata,
} from "./types.js";
import type { AppStoreConnectTokenProvider } from "./auth.js";

export interface ApiRequestOptions {
  method: HttpMethod;
  path: string;
  query?: Query;
  body?: Record<string, unknown>;
  paginate?: boolean;
  maxPages?: number;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  status: number;
  metadata: ResponseMetadata;
}

export interface AppStoreConnectClientOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function parseRateLimit(raw: string | null): ResponseMetadata["rateLimit"] {
  if (!raw) return undefined;
  const values = new Map<string, number>();
  for (const part of raw.split(";")) {
    const [key, rawValue] = part.split(":", 2);
    const value = Number(rawValue);
    if (key && Number.isFinite(value)) values.set(key.trim(), value);
  }
  return {
    raw,
    ...(values.has("user-hour-lim")
      ? { limit: values.get("user-hour-lim") }
      : {}),
    ...(values.has("user-hour-rem")
      ? { remaining: values.get("user-hour-rem") }
      : {}),
  };
}

function responseMetadata(response: Response): ResponseMetadata {
  const contentType = response.headers.get("content-type") ?? undefined;
  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("x-apple-request-uuid") ??
    undefined;
  const retryAfter = response.headers.get("retry-after") ?? undefined;
  const rateLimit = parseRateLimit(response.headers.get("x-rate-limit"));
  return {
    ...(contentType ? { contentType } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    ...(rateLimit ? { rateLimit } : {}),
  };
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function asAppleErrors(body: unknown): AppleApiError[] {
  if (
    typeof body === "object" &&
    body !== null &&
    "errors" in body &&
    Array.isArray((body as { errors?: unknown }).errors)
  ) {
    return (body as { errors: AppleApiError[] }).errors;
  }
  return [];
}

function apiErrorMessage(status: number, errors: AppleApiError[]): string {
  const details = errors
    .map((error) => error.detail ?? error.title ?? error.code)
    .filter((value): value is string => Boolean(value));
  return details.length
    ? `App Store Connect API returned HTTP ${status}: ${details.join("; ")}`
    : `App Store Connect API returned HTTP ${status}`;
}

function serializeQuery(url: URL, query: Query | undefined): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const serialized = Array.isArray(value)
      ? value.map(String).join(",")
      : String(value);
    url.searchParams.set(key, serialized);
  }
}

function isJson(contentType: string | null): boolean {
  return Boolean(contentType?.includes("json"));
}

export class AppStoreConnectClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly config: AppStoreConnectConfig,
    private readonly tokenProvider: Pick<AppStoreConnectTokenProvider, "getToken">,
    options: AppStoreConnectClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request<T = unknown>(
    options: ApiRequestOptions,
  ): Promise<ApiResponse<T>> {
    const firstUrl = this.buildApiUrl(options.path, options.query);
    const first = await this.requestOne<T>(
      options.method,
      firstUrl,
      options.body,
    );
    if (!options.paginate || options.method !== "GET") return first;
    return this.collectPages(first, options.maxPages ?? this.config.maxPages);
  }

  async download(
    path: string,
    query: Query | undefined,
    outputPath: string,
  ): Promise<DownloadResult> {
    const url = this.buildApiUrl(path, query);
    const response = await this.fetchApi(
      "GET",
      url,
      undefined,
      "application/a-gzip, application/octet-stream, application/json;q=0.9, */*;q=0.8",
    );
    const metadata = responseMetadata(response);
    if (!response.ok) {
      const body = await this.readBody(response);
      const errors = asAppleErrors(body);
      throw new AppStoreConnectError(
        apiErrorMessage(response.status, errors),
        response.status,
        errors,
        metadata,
      );
    }
    if (!response.body) {
      throw new AppStoreConnectError(
        "The download response did not contain a body",
        response.status,
        [],
        metadata,
      );
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > this.config.maxDownloadBytes
    ) {
      await response.body.cancel();
      throw new SafetyError(
        `Download is ${contentLength} bytes, exceeding ASC_MAX_DOWNLOAD_BYTES`,
      );
    }

    const destination = await resolveOutputFile(
      this.config.downloadRoot,
      outputPath,
    );
    const temporary = `${destination}.part-${process.pid}-${Date.now()}`;
    let bytes = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.byteLength;
        if (bytes > this.config.maxDownloadBytes) {
          callback(
            new SafetyError(
              `Download exceeded ASC_MAX_DOWNLOAD_BYTES (${this.config.maxDownloadBytes})`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        limiter,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      // A hard link makes publishing atomic and refuses to overwrite an existing file.
      await link(temporary, destination);
      await unlink(temporary);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }

    return { path: destination, bytes, status: response.status, metadata };
  }

  buildApiUrl(path: string, query?: Query): URL {
    if (!path.startsWith("/")) {
      throw new SafetyError("API paths must start with /");
    }
    if (path.includes("?") || path.includes("#")) {
      throw new SafetyError(
        "Put query parameters in the query object, not in the API path",
      );
    }
    if (!/^\/v\d+(?:\/|$)/.test(path)) {
      throw new SafetyError("Only versioned App Store Connect API paths are allowed");
    }
    if (path.split("/").some((segment) => segment === ".." || segment === ".")) {
      throw new SafetyError("Relative path segments are not allowed");
    }
    const url = new URL(path.slice(1), this.config.apiBaseUrl);
    this.assertApiOrigin(url);
    serializeQuery(url, query);
    return url;
  }

  private async requestOne<T>(
    method: HttpMethod,
    url: URL,
    body?: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    const response = await this.fetchApi(method, url, body);
    const metadata = responseMetadata(response);
    const parsed = await this.readBody(response);
    if (!response.ok) {
      const errors = asAppleErrors(parsed);
      throw new AppStoreConnectError(
        apiErrorMessage(response.status, errors),
        response.status,
        errors,
        metadata,
      );
    }
    return { status: response.status, body: parsed as T, metadata };
  }

  private async fetchApi(
    method: HttpMethod,
    url: URL,
    body?: Record<string, unknown>,
    accept = "application/json",
  ): Promise<Response> {
    const token = await this.tokenProvider.getToken();
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const canRetry = method === "GET" || method === "DELETE";

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept,
            ...(serializedBody === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(serializedBody === undefined ? {} : { body: serializedBody }),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (error) {
        if (!canRetry || attempt >= this.config.maxRetries) throw error;
        await this.sleep(Math.min(30_000, 500 * 2 ** attempt));
        continue;
      }

      const retryableStatus =
        response.status === 429 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;
      if (!canRetry || !retryableStatus || attempt >= this.config.maxRetries) {
        return response;
      }
      await response.body?.cancel();
      await this.sleep(retryDelayMs(response, attempt));
    }
  }

  private async readBody(response: Response): Promise<unknown> {
    if (response.status === 204) return null;
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.config.maxJsonResponseBytes
    ) {
      await response.body?.cancel();
      throw new SafetyError(
        `Response is ${declaredLength} bytes, exceeding ASC_MAX_JSON_RESPONSE_BYTES. Use asc_download for binary or report responses.`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.config.maxJsonResponseBytes) {
      throw new SafetyError(
        `Response exceeded ASC_MAX_JSON_RESPONSE_BYTES (${this.config.maxJsonResponseBytes})`,
      );
    }
    if (bytes.byteLength === 0) return null;
    const text = new TextDecoder().decode(bytes);
    if (isJson(response.headers.get("content-type"))) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new AppStoreConnectError(
          "App Store Connect returned invalid JSON",
          response.status,
          [],
          responseMetadata(response),
        );
      }
    }
    return text;
  }

  private async collectPages<T>(
    first: ApiResponse<T>,
    maxPages: number,
  ): Promise<ApiResponse<T>> {
    if (maxPages < 1 || maxPages > this.config.maxPages) {
      throw new SafetyError(
        `maxPages must be between 1 and ${this.config.maxPages}`,
      );
    }
    const body = first.body as JsonApiDocument;
    if (!Array.isArray(body?.data)) return { ...first, pagesFetched: 1 };

    const mergedData = [...body.data];
    const mergedIncluded = Array.isArray(body.included) ? [...body.included] : [];
    let next = this.nextLink(body);
    let pagesFetched = 1;
    let latestLinks = body.links;
    let latestMeta = body.meta;

    while (next && pagesFetched < maxPages) {
      const nextUrl = new URL(next);
      this.assertApiOrigin(nextUrl);
      const page = await this.requestOne<JsonApiDocument>("GET", nextUrl);
      if (!Array.isArray(page.body.data)) break;
      mergedData.push(...page.body.data);
      if (Array.isArray(page.body.included)) {
        mergedIncluded.push(...page.body.included);
      }
      latestLinks = page.body.links;
      latestMeta = page.body.meta;
      next = this.nextLink(page.body);
      pagesFetched += 1;
    }

    const merged: JsonApiDocument = {
      ...body,
      data: mergedData,
      ...(mergedIncluded.length ? { included: mergedIncluded } : {}),
      ...(latestLinks ? { links: latestLinks } : {}),
      ...(latestMeta ? { meta: latestMeta } : {}),
    };
    return {
      ...first,
      body: merged as T,
      pagesFetched,
      paginationTruncated: Boolean(next),
    };
  }

  private nextLink(body: JsonApiDocument): string | undefined {
    const next = body.links?.next;
    return typeof next === "string" && next ? next : undefined;
  }

  private assertApiOrigin(url: URL): void {
    if (url.origin !== this.config.apiBaseUrl.origin) {
      throw new SafetyError(
        `Refusing an App Store Connect request to unexpected origin ${url.origin}`,
      );
    }
    const basePath = this.config.apiBaseUrl.pathname;
    if (basePath !== "/" && !url.pathname.startsWith(basePath)) {
      throw new SafetyError(
        `Request path is outside the configured API base path ${basePath}`,
      );
    }
  }
}
