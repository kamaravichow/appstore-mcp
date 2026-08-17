export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | QueryPrimitive[] | null | undefined;
export type Query = Record<string, QueryValue>;

export interface RateLimitInfo {
  raw?: string;
  limit?: number;
  remaining?: number;
}

export interface ResponseMetadata {
  contentType?: string;
  requestId?: string;
  rateLimit?: RateLimitInfo;
  retryAfter?: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  metadata: ResponseMetadata;
  pagesFetched?: number;
  paginationTruncated?: boolean;
}

export interface AppleErrorSource {
  pointer?: string;
  parameter?: string;
}

export interface AppleApiError {
  id?: string;
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
  source?: AppleErrorSource;
}

export interface AppleErrorDocument {
  errors?: AppleApiError[];
}

export interface JsonApiDocument {
  data?: unknown;
  included?: unknown[];
  links?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  errors?: AppleApiError[];
  [key: string]: unknown;
}

export interface UploadRequestHeader {
  name: string;
  value: string;
}

export interface UploadOperation {
  method: string;
  url: string;
  length: number;
  offset: number;
  requestHeaders?: UploadRequestHeader[];
  partNumber?: number;
}

export interface UploadedPart {
  index: number;
  offset: number;
  length: number;
  status: number;
  entityTag?: string;
}
