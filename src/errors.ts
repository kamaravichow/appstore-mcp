import type { AppleApiError, ResponseMetadata } from "./types.js";

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

export class SafetyError extends Error {
  override readonly name = "SafetyError";
}

export class AppStoreConnectError extends Error {
  override readonly name = "AppStoreConnectError";

  constructor(
    message: string,
    readonly status: number,
    readonly errors: AppleApiError[] = [],
    readonly metadata: ResponseMetadata = {},
  ) {
    super(message);
  }
}

export class AssetUploadError extends Error {
  override readonly name = "AssetUploadError";

  constructor(
    message: string,
    readonly stage: "reservation" | "upload" | "commit",
    readonly reservationId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function errorToSafeObject(error: unknown): Record<string, unknown> {
  if (error instanceof AppStoreConnectError) {
    return {
      type: error.name,
      message: error.message,
      status: error.status,
      errors: error.errors,
      metadata: error.metadata,
    };
  }

  if (error instanceof AssetUploadError) {
    return {
      type: error.name,
      message: error.message,
      stage: error.stage,
      ...(error.reservationId === undefined
        ? {}
        : { reservationId: error.reservationId }),
      ...(error.cause === undefined ? {} : { cause: errorToSafeObject(error.cause) }),
    };
  }

  if (error instanceof Error) {
    return { type: error.name, message: error.message };
  }

  return { type: "UnknownError", message: String(error) };
}
