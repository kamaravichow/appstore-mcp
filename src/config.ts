import { resolve } from "node:path";

import { ConfigurationError, SafetyError } from "./errors.js";

export type AppStoreConnectKeyType = "team" | "individual";

export interface AppStoreConnectConfig {
  apiBaseUrl: URL;
  keyId?: string;
  issuerId?: string;
  privateKey?: string;
  privateKeyPath?: string;
  keyType: AppStoreConnectKeyType;
  tokenTtlSeconds: number;
  tokenScope?: string[];
  requestTimeoutMs: number;
  maxRetries: number;
  maxPages: number;
  maxJsonResponseBytes: number;
  maxDownloadBytes: number;
  enableMutations: boolean;
  allowUndocumentedEndpoints: boolean;
  uploadRoot: string;
  downloadRoot: string;
  uploadConcurrency: number;
  uploadHostSuffixes: string[];
  allowInsecureBaseUrl: boolean;
}

export type Environment = Record<string, string | undefined>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new ConfigurationError(`Expected a boolean value, received: ${value}`);
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseScope(value: string | undefined): string[] | undefined {
  if (!optional(value)) return undefined;
  try {
    const parsed: unknown = JSON.parse(value as string);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("scope must be a JSON string array");
    }
    return parsed;
  } catch (error) {
    throw new ConfigurationError(
      `ASC_TOKEN_SCOPE must be a JSON array of strings: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseBaseUrl(
  value: string | undefined,
  allowInsecure: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(value ?? "https://api.appstoreconnect.apple.com/");
  } catch {
    throw new ConfigurationError("ASC_API_BASE_URL must be a valid URL");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(
      "ASC_API_BASE_URL cannot contain credentials, a query, or a fragment",
    );
  }
  if (url.protocol !== "https:" && !allowInsecure) {
    throw new SafetyError(
      "ASC_API_BASE_URL must use HTTPS unless ASC_ALLOW_INSECURE_BASE_URL=true",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function loadConfig(
  env: Environment = process.env,
  workingDirectory = process.cwd(),
): AppStoreConnectConfig {
  const allowInsecureBaseUrl = parseBoolean(
    env.ASC_ALLOW_INSECURE_BASE_URL,
    false,
  );
  const issuerId = optional(env.ASC_ISSUER_ID);
  const configuredKeyType = optional(env.ASC_KEY_TYPE) ?? "auto";
  if (!["auto", "team", "individual"].includes(configuredKeyType)) {
    throw new ConfigurationError(
      "ASC_KEY_TYPE must be auto, team, or individual",
    );
  }
  const keyType: AppStoreConnectKeyType =
    configuredKeyType === "auto"
      ? issuerId
        ? "team"
        : "individual"
      : (configuredKeyType as AppStoreConnectKeyType);

  return {
    apiBaseUrl: parseBaseUrl(env.ASC_API_BASE_URL, allowInsecureBaseUrl),
    keyId: optional(env.ASC_KEY_ID),
    issuerId,
    privateKey: optional(env.ASC_PRIVATE_KEY)?.replaceAll("\\n", "\n"),
    privateKeyPath: optional(env.ASC_PRIVATE_KEY_PATH),
    keyType,
    tokenTtlSeconds: parseInteger(
      env.ASC_TOKEN_TTL_SECONDS,
      600,
      "ASC_TOKEN_TTL_SECONDS",
      30,
      1_200,
    ),
    tokenScope: parseScope(env.ASC_TOKEN_SCOPE),
    requestTimeoutMs: parseInteger(
      env.ASC_REQUEST_TIMEOUT_MS,
      30_000,
      "ASC_REQUEST_TIMEOUT_MS",
      1_000,
      300_000,
    ),
    maxRetries: parseInteger(
      env.ASC_MAX_RETRIES,
      3,
      "ASC_MAX_RETRIES",
      0,
      10,
    ),
    maxPages: parseInteger(
      env.ASC_MAX_PAGES,
      10,
      "ASC_MAX_PAGES",
      1,
      100,
    ),
    maxJsonResponseBytes: parseInteger(
      env.ASC_MAX_JSON_RESPONSE_BYTES,
      10 * 1024 * 1024,
      "ASC_MAX_JSON_RESPONSE_BYTES",
      1_024,
      100 * 1024 * 1024,
    ),
    maxDownloadBytes: parseInteger(
      env.ASC_MAX_DOWNLOAD_BYTES,
      2 * 1024 * 1024 * 1024,
      "ASC_MAX_DOWNLOAD_BYTES",
      1_024,
      Number.MAX_SAFE_INTEGER,
    ),
    enableMutations: parseBoolean(env.ASC_ENABLE_MUTATIONS, false),
    allowUndocumentedEndpoints: parseBoolean(
      env.ASC_ALLOW_UNDOCUMENTED_ENDPOINTS,
      false,
    ),
    uploadRoot: resolve(workingDirectory, env.ASC_UPLOAD_ROOT ?? "."),
    downloadRoot: resolve(
      workingDirectory,
      env.ASC_DOWNLOAD_ROOT ?? "./downloads",
    ),
    uploadConcurrency: parseInteger(
      env.ASC_UPLOAD_CONCURRENCY,
      4,
      "ASC_UPLOAD_CONCURRENCY",
      1,
      16,
    ),
    uploadHostSuffixes: (env.ASC_UPLOAD_HOST_SUFFIXES ?? ".apple.com")
      .split(",")
      .map((suffix) => suffix.trim().toLowerCase())
      .filter(Boolean),
    allowInsecureBaseUrl,
  };
}

export function assertCredentialsConfigured(
  config: AppStoreConnectConfig,
): asserts config is AppStoreConnectConfig & { keyId: string } {
  if (!config.keyId) {
    throw new ConfigurationError("ASC_KEY_ID is required for API calls");
  }
  if (!config.privateKey && !config.privateKeyPath) {
    throw new ConfigurationError(
      "Set ASC_PRIVATE_KEY or ASC_PRIVATE_KEY_PATH for API calls",
    );
  }
  if (config.privateKey && config.privateKeyPath) {
    throw new ConfigurationError(
      "Set only one of ASC_PRIVATE_KEY and ASC_PRIVATE_KEY_PATH",
    );
  }
  if (config.keyType === "team" && !config.issuerId) {
    throw new ConfigurationError("ASC_ISSUER_ID is required for a team key");
  }
}

export function assertMutationsEnabled(config: AppStoreConnectConfig): void {
  if (!config.enableMutations) {
    throw new SafetyError(
      "Mutating tools are disabled. Set ASC_ENABLE_MUTATIONS=true and restart the server to enable production writes.",
    );
  }
}
