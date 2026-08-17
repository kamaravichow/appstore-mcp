import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";

import type { AppStoreConnectClient } from "./client.js";
import type { AppStoreConnectConfig } from "./config.js";
import { AssetUploadError, SafetyError } from "./errors.js";
import { resolveInputFile } from "./fs-safety.js";
import type {
  JsonApiDocument,
  UploadedPart,
  UploadOperation,
} from "./types.js";

export interface UploadPartsOptions {
  filePath: string;
  operations: UploadOperation[];
}

export interface UploadPartsResult {
  filePath: string;
  fileSize: number;
  md5: string;
  parts: UploadedPart[];
}

export interface UploadAssetOptions {
  filePath: string;
  reservationPath: string;
  resourceType: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
}

export interface UploadAssetResult extends UploadPartsResult {
  reservationId: string;
  resourceType: string;
  reservation: unknown;
  commit: unknown;
}

export interface AssetUploaderOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function headerObject(operation: UploadOperation): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of operation.requestHeaders ?? []) {
    const name = header.name.trim();
    if (/^(authorization|cookie|host)$/i.test(name)) {
      throw new SafetyError(`Upload operation contains forbidden header ${name}`);
    }
    headers[name] = header.value;
  }
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) {
    headers["content-length"] = String(operation.length);
  }
  return headers;
}

function extractUploadOperations(document: unknown): UploadOperation[] {
  const operations = (
    document as {
      data?: { attributes?: { uploadOperations?: unknown } };
    }
  )?.data?.attributes?.uploadOperations;
  if (!Array.isArray(operations)) {
    throw new SafetyError(
      "The reservation response did not contain data.attributes.uploadOperations",
    );
  }
  return operations as UploadOperation[];
}

function extractResource(document: unknown): { id: string; type: string } {
  const data = (document as { data?: { id?: unknown; type?: unknown } })?.data;
  if (typeof data?.id !== "string" || typeof data.type !== "string") {
    throw new SafetyError("The reservation response did not contain a resource ID and type");
  }
  return { id: data.id, type: data.type };
}

async function md5File(path: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class AssetUploader {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly config: AppStoreConnectConfig,
    private readonly client: Pick<AppStoreConnectClient, "request">,
    options: AssetUploaderOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? sleep;
  }

  async uploadParts(options: UploadPartsOptions): Promise<UploadPartsResult> {
    const filePath = await resolveInputFile(this.config.uploadRoot, options.filePath);
    const file = await stat(filePath);
    if (!file.isFile()) throw new SafetyError("Upload path must reference a regular file");
    this.validateOperations(options.operations, file.size);

    const checksumPromise = md5File(filePath);
    const results: UploadedPart[] = new Array(options.operations.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= options.operations.length) return;
        const operation = options.operations[index];
        if (!operation) return;
        results[index] = await this.uploadOperation(filePath, operation, index);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.config.uploadConcurrency, options.operations.length) },
        worker,
      ),
    );

    return {
      filePath,
      fileSize: file.size,
      md5: await checksumPromise,
      parts: results,
    };
  }

  async uploadAsset(options: UploadAssetOptions): Promise<UploadAssetResult> {
    const filePath = await resolveInputFile(this.config.uploadRoot, options.filePath);
    const file = await stat(filePath);
    if (!file.isFile()) throw new SafetyError("Upload path must reference a regular file");

    let reservation: JsonApiDocument;
    try {
      reservation = (
        await this.client.request<JsonApiDocument>({
          method: "POST",
          path: options.reservationPath,
          body: {
            data: {
              type: options.resourceType,
              attributes: {
                ...(options.attributes ?? {}),
                fileName: basename(filePath),
                fileSize: file.size,
              },
              ...(options.relationships
                ? { relationships: options.relationships }
                : {}),
            },
          },
        })
      ).body;
    } catch (error) {
      throw new AssetUploadError("Asset reservation failed", "reservation", undefined, {
        cause: error,
      });
    }

    const resource = extractResource(reservation);
    if (resource.type !== options.resourceType) {
      throw new AssetUploadError(
        `Reservation returned resource type ${resource.type}, expected ${options.resourceType}`,
        "reservation",
        resource.id,
      );
    }

    let uploaded: UploadPartsResult;
    try {
      uploaded = await this.uploadParts({
        filePath,
        operations: extractUploadOperations(reservation),
      });
    } catch (error) {
      throw new AssetUploadError("Asset part upload failed", "upload", resource.id, {
        cause: error,
      });
    }

    const commitPath = `${options.reservationPath.replace(/\/$/, "")}/${encodeURIComponent(resource.id)}`;
    let commit: JsonApiDocument;
    try {
      commit = (
        await this.client.request<JsonApiDocument>({
          method: "PATCH",
          path: commitPath,
          body: {
            data: {
              type: options.resourceType,
              id: resource.id,
              attributes: {
                uploaded: true,
                sourceFileChecksum: uploaded.md5,
              },
            },
          },
        })
      ).body;
    } catch (error) {
      throw new AssetUploadError("Asset commit failed", "commit", resource.id, {
        cause: error,
      });
    }

    return {
      ...uploaded,
      reservationId: resource.id,
      resourceType: resource.type,
      reservation,
      commit,
    };
  }

  private validateOperations(operations: UploadOperation[], fileSize: number): void {
    if (!operations.length) throw new SafetyError("At least one upload operation is required");
    const sorted = [...operations].sort((left, right) => left.offset - right.offset);
    let expectedOffset = 0;
    for (const operation of sorted) {
      if (
        !Number.isSafeInteger(operation.offset) ||
        !Number.isSafeInteger(operation.length) ||
        operation.offset < 0 ||
        operation.length <= 0
      ) {
        throw new SafetyError("Upload offsets and lengths must be positive safe integers");
      }
      if (operation.offset !== expectedOffset) {
        throw new SafetyError(
          `Upload operations do not cover the file contiguously at byte ${expectedOffset}`,
        );
      }
      expectedOffset += operation.length;
      this.assertUploadUrl(operation.url);
      if (!/^(PUT|POST)$/i.test(operation.method)) {
        throw new SafetyError(
          `Upload operation method ${operation.method} is not allowed`,
        );
      }
    }
    if (expectedOffset !== fileSize) {
      throw new SafetyError(
        `Upload operations cover ${expectedOffset} bytes, but the file is ${fileSize} bytes`,
      );
    }
  }

  private assertUploadUrl(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new SafetyError("Upload operation URL is invalid");
    }
    if (url.username || url.password) {
      throw new SafetyError("Upload operation URL cannot contain credentials");
    }
    if (url.protocol !== "https:" && !this.config.allowInsecureBaseUrl) {
      throw new SafetyError("Upload operation URL must use HTTPS");
    }
    const host = url.hostname.toLowerCase();
    const allowed = this.config.uploadHostSuffixes.some((suffix) => {
      const normalized = suffix.toLowerCase();
      return normalized.startsWith(".")
        ? host.endsWith(normalized) && host.length > normalized.length
        : host === normalized || host.endsWith(`.${normalized}`);
    });
    if (!allowed) {
      throw new SafetyError(
        `Upload host ${host} is not allowed by ASC_UPLOAD_HOST_SUFFIXES`,
      );
    }
    return url;
  }

  private async uploadOperation(
    filePath: string,
    operation: UploadOperation,
    index: number,
  ): Promise<UploadedPart> {
    const url = this.assertUploadUrl(operation.url);
    for (let attempt = 0; ; attempt += 1) {
      const nodeStream = createReadStream(filePath, {
        start: operation.offset,
        end: operation.offset + operation.length - 1,
      });
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: operation.method.toUpperCase(),
          headers: headerObject(operation),
          body: Readable.toWeb(nodeStream) as ReadableStream,
          // Required by Node's fetch implementation for a streaming request body.
          duplex: "half",
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        } as RequestInit & { duplex: "half" });
      } catch (error) {
        nodeStream.destroy();
        if (attempt >= this.config.maxRetries) throw error;
        await this.sleep(Math.min(30_000, 500 * 2 ** attempt));
        continue;
      }
      if (response.ok) {
        await response.body?.cancel();
        const entityTag = response.headers.get("etag") ?? undefined;
        return {
          index,
          offset: operation.offset,
          length: operation.length,
          status: response.status,
          ...(entityTag ? { entityTag } : {}),
        };
      }
      await response.body?.cancel();
      if (attempt >= this.config.maxRetries || response.status < 500) {
        throw new Error(`Upload part ${index + 1} returned HTTP ${response.status}`);
      }
      await this.sleep(Math.min(30_000, 500 * 2 ** attempt));
    }
  }
}
