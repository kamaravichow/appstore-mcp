import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { AppStoreConnectTokenProvider } from "./auth.js";
import { AppStoreConnectClient } from "./client.js";
import {
  assertMutationsEnabled,
  loadConfig,
  type AppStoreConnectConfig,
} from "./config.js";
import { errorToSafeObject, SafetyError } from "./errors.js";
import { OpenApiCatalog } from "./openapi.js";
import type { HttpMethod, Query } from "./types.js";
import { AssetUploader } from "./upload.js";

export const SERVER_NAME = "app-store-connect";
export const SERVER_VERSION = "0.1.0";

const queryPrimitiveSchema = z.union([z.string(), z.number(), z.boolean()]);
const querySchema = z
  .record(
    z.string(),
    z.union([queryPrimitiveSchema, z.array(queryPrimitiveSchema), z.null()]),
  )
  .describe(
    "Query parameters keyed exactly as Apple documents them, such as filter[bundleId], fields[apps], include, sort, and limit.",
  );
const jsonObjectSchema = z.record(z.string(), z.unknown());
const paginationSchema = {
  paginate: z
    .boolean()
    .optional()
    .default(false)
    .describe("Follow JSON:API links.next automatically."),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum pages to collect; capped by ASC_MAX_PAGES."),
};

export interface CreateServerOptions {
  config?: AppStoreConnectConfig;
  tokenProvider?: AppStoreConnectTokenProvider;
  client?: AppStoreConnectClient;
  catalog?: OpenApiCatalog;
  uploader?: AssetUploader;
}

export interface AppStoreConnectRuntime {
  config: AppStoreConnectConfig;
  tokenProvider: AppStoreConnectTokenProvider;
  client: AppStoreConnectClient;
  catalog: OpenApiCatalog;
  uploader: AssetUploader;
}

export function createAppStoreConnectRuntime(
  config = loadConfig(),
): AppStoreConnectRuntime {
  const tokenProvider = new AppStoreConnectTokenProvider(config);
  const client = new AppStoreConnectClient(config, tokenProvider);
  const catalog = new OpenApiCatalog();
  const uploader = new AssetUploader(config, client);
  return { config, tokenProvider, client, catalog, uploader };
}

function serializeForText(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2) ?? String(value);
  const limit = 50_000;
  if (serialized.length <= limit) return serialized;
  return `${serialized.slice(0, limit)}\n\n[Text rendering truncated at ${limit} characters; inspect structuredContent or narrow the query.]`;
}

function successResult(result: unknown, message?: string): CallToolResult {
  const structuredContent = { ok: true, result };
  return {
    content: [
      { type: "text", text: message ?? serializeForText(structuredContent) },
    ],
    structuredContent,
  };
}

function failureResult(error: unknown): CallToolResult {
  const safeError = errorToSafeObject(error);
  return {
    content: [{ type: "text", text: serializeForText(safeError) }],
    structuredContent: { ok: false, error: safeError },
    isError: true,
  };
}

async function safely<T>(operation: () => Promise<T>): Promise<CallToolResult> {
  try {
    return successResult(await operation());
  } catch (error) {
    return failureResult(error);
  }
}

function asQuery(value: Record<string, unknown> | undefined): Query | undefined {
  return value as Query | undefined;
}

function mergeQuery(
  explicit: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
): Query {
  return { ...asQuery(extra), ...asQuery(explicit) };
}

export function createAppStoreConnectServer(
  options: CreateServerOptions = {},
): McpServer {
  const config = options.config ?? loadConfig();
  const tokenProvider =
    options.tokenProvider ?? new AppStoreConnectTokenProvider(config);
  const client =
    options.client ?? new AppStoreConnectClient(config, tokenProvider);
  const catalog = options.catalog ?? new OpenApiCatalog();
  const uploader = options.uploader ?? new AssetUploader(config, client);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Use asc_search_operations then asc_describe_operation before calling an unfamiliar endpoint. Prefer the focused read tools for apps and products. App Store Connect is production: read current state before a write, preserve JSON:API type/id fields, and use mutation tools only when the user explicitly requested the change. Writes require ASC_ENABLE_MUTATIONS=true; deletes additionally require confirm=true. Use asc_download for reports or other binary responses and asc_upload_asset for Apple's reserve/upload/commit asset workflow.",
    },
  );

  const ensureDocumented = async (
    method: HttpMethod,
    path: string,
  ): Promise<void> => {
    if (config.allowUndocumentedEndpoints) return;
    if (!(await catalog.findOperation(method, path))) {
      throw new SafetyError(
        `${method} ${path} is not in the bundled Apple OpenAPI specification. Search operations, run npm run sync:openapi if Apple added it recently, or explicitly set ASC_ALLOW_UNDOCUMENTED_ENDPOINTS=true.`,
      );
    }
  };

  server.registerTool(
    "asc_auth_status",
    {
      title: "Check App Store Connect authentication",
      description:
        "Show non-secret credential configuration and safety settings. Optionally make a minimal API request to verify the key and role.",
      inputSchema: z.object({
        verify: z
          .boolean()
          .optional()
          .default(false)
          .describe("Call GET /v1/apps?limit=1 to verify authentication."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ verify }) =>
      safely(async () => {
        const status = {
          ...tokenProvider.getStatus(),
          apiBaseUrl: config.apiBaseUrl.toString(),
          mutationsEnabled: config.enableMutations,
          uploadRoot: config.uploadRoot,
          downloadRoot: config.downloadRoot,
          undocumentedEndpointsAllowed: config.allowUndocumentedEndpoints,
        };
        if (!verify) return status;
        const response = await client.request({
          method: "GET",
          path: "/v1/apps",
          query: { limit: 1 },
        });
        return {
          ...status,
          verification: {
            ok: true,
            status: response.status,
            metadata: response.metadata,
          },
        };
      }),
  );

  server.registerTool(
    "asc_search_operations",
    {
      title: "Search App Store Connect operations",
      description:
        "Search all operations in Apple's bundled OpenAPI specification by capability, resource, operation ID, path, tag, or HTTP method.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Terms such as screenshots, TestFlight beta groups, finance, or users."),
        method: z.enum(["GET", "POST", "PATCH", "DELETE"]).optional(),
        tag: z.string().optional().describe("Exact OpenAPI tag, case-insensitive."),
        limit: z.number().int().min(1).max(100).optional().default(20),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => safely(() => catalog.search(args)),
  );

  server.registerTool(
    "asc_describe_operation",
    {
      title: "Describe an App Store Connect operation",
      description:
        "Return exact parameters, JSON body schema, response types, and referenced component schemas for one Apple OpenAPI operation. Identify it by operationId or by method plus templated path.",
      inputSchema: z
        .object({
          operationId: z.string().optional(),
          method: z.enum(["GET", "POST", "PATCH", "DELETE"]).optional(),
          path: z
            .string()
            .optional()
            .describe("Templated OpenAPI path, for example /v1/apps/{id}."),
          includeResponseSchemas: z.boolean().optional().default(false),
        })
        .refine(
          (value) => Boolean(value.operationId || (value.method && value.path)),
          "Provide operationId, or provide both method and path",
        ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      safely(async () => {
        const description = await catalog.describe(args);
        if (!description) throw new SafetyError("OpenAPI operation not found");
        return description;
      }),
  );

  server.registerTool(
    "asc_list_apps",
    {
      title: "List App Store Connect apps",
      description:
        "List apps with common filters and optional related resources. Use asc_api_get for advanced fields and relationship limits.",
      inputSchema: z.object({
        name: z.string().optional(),
        bundleId: z.string().optional(),
        sku: z.string().optional(),
        platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).optional(),
        appVersionState: z.string().optional(),
        ids: z.array(z.string()).optional(),
        fields: z.array(z.string()).optional(),
        include: z.array(z.string()).optional(),
        sort: z.enum(["name", "-name", "bundleId", "-bundleId", "sku", "-sku"]).optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
        ...paginationSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      safely(async () => {
        const query = mergeQuery(
          {
            "filter[name]": args.name,
            "filter[bundleId]": args.bundleId,
            "filter[sku]": args.sku,
            "filter[appStoreVersions.platform]": args.platform,
            "filter[appStoreVersions.appVersionState]": args.appVersionState,
            "filter[id]": args.ids,
            "fields[apps]": args.fields,
            include: args.include,
            sort: args.sort,
            limit: args.limit,
          },
          undefined,
        );
        return client.request({
          method: "GET",
          path: "/v1/apps",
          query,
          paginate: args.paginate,
          ...(args.maxPages === undefined ? {} : { maxPages: args.maxPages }),
        });
      }),
  );

  server.registerTool(
    "asc_get_app",
    {
      title: "Get an App Store Connect app",
      description: "Get one app by App Store Connect resource ID.",
      inputSchema: z.object({
        appId: z.string().min(1),
        fields: z.array(z.string()).optional(),
        include: z.array(z.string()).optional(),
        query: querySchema.optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ appId, fields, include, query }) =>
      safely(() =>
        client.request({
          method: "GET",
          path: `/v1/apps/${encodeURIComponent(appId)}`,
          query: mergeQuery(
            { "fields[apps]": fields, include },
            query as Record<string, unknown> | undefined,
          ),
        }),
      ),
  );

  server.registerTool(
    "asc_list_in_app_purchases",
    {
      title: "List in-app purchase products",
      description:
        "List an app's current in-app purchase products (the V2 relationship), with product ID, name, type, and state filters.",
      inputSchema: z.object({
        appId: z.string().min(1),
        productId: z.string().optional(),
        name: z.string().optional(),
        state: z.string().optional(),
        inAppPurchaseType: z
          .enum(["CONSUMABLE", "NON_CONSUMABLE", "NON_RENEWING_SUBSCRIPTION"])
          .optional(),
        fields: z.array(z.string()).optional(),
        include: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
        ...paginationSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      safely(() =>
        client.request({
          method: "GET",
          path: `/v1/apps/${encodeURIComponent(args.appId)}/inAppPurchasesV2`,
          query: {
            "filter[productId]": args.productId,
            "filter[name]": args.name,
            "filter[state]": args.state,
            "filter[inAppPurchaseType]": args.inAppPurchaseType,
            "fields[inAppPurchases]": args.fields,
            include: args.include,
            limit: args.limit,
          },
          paginate: args.paginate,
          ...(args.maxPages === undefined ? {} : { maxPages: args.maxPages }),
        }),
      ),
  );

  server.registerTool(
    "asc_list_subscription_groups",
    {
      title: "List subscription groups",
      description: "List an app's auto-renewable subscription groups.",
      inputSchema: z.object({
        appId: z.string().min(1),
        referenceName: z.string().optional(),
        fields: z.array(z.string()).optional(),
        include: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
        ...paginationSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      safely(() =>
        client.request({
          method: "GET",
          path: `/v1/apps/${encodeURIComponent(args.appId)}/subscriptionGroups`,
          query: {
            "filter[referenceName]": args.referenceName,
            "fields[subscriptionGroups]": args.fields,
            include: args.include,
            limit: args.limit,
          },
          paginate: args.paginate,
          ...(args.maxPages === undefined ? {} : { maxPages: args.maxPages }),
        }),
      ),
  );

  server.registerTool(
    "asc_list_subscriptions",
    {
      title: "List subscriptions",
      description: "List the auto-renewable subscriptions in a subscription group.",
      inputSchema: z.object({
        subscriptionGroupId: z.string().min(1),
        productId: z.string().optional(),
        name: z.string().optional(),
        state: z.string().optional(),
        fields: z.array(z.string()).optional(),
        include: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
        ...paginationSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      safely(() =>
        client.request({
          method: "GET",
          path: `/v1/subscriptionGroups/${encodeURIComponent(args.subscriptionGroupId)}/subscriptions`,
          query: {
            "filter[productId]": args.productId,
            "filter[name]": args.name,
            "filter[state]": args.state,
            "fields[subscriptions]": args.fields,
            include: args.include,
            limit: args.limit,
          },
          paginate: args.paginate,
          ...(args.maxPages === undefined ? {} : { maxPages: args.maxPages }),
        }),
      ),
  );

  server.registerTool(
    "asc_api_get",
    {
      title: "Call any App Store Connect GET operation",
      description:
        "Read any documented App Store Connect endpoint. Search and describe the operation first so path, filters, fields, includes, and limits match Apple's schema.",
      inputSchema: z.object({
        path: z.string().startsWith("/v"),
        query: querySchema.optional(),
        ...paginationSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, query, paginate, maxPages }) =>
      safely(async () => {
        await ensureDocumented("GET", path);
        return client.request({
          method: "GET",
          path,
          query: asQuery(query),
          paginate,
          ...(maxPages === undefined ? {} : { maxPages }),
        });
      }),
  );

  server.registerTool(
    "asc_api_post",
    {
      title: "Call any App Store Connect POST operation",
      description:
        "Create or submit a resource through any documented App Store Connect POST endpoint. Body must be Apple's complete JSON:API request document.",
      inputSchema: z.object({
        path: z.string().startsWith("/v"),
        query: querySchema.optional(),
        body: jsonObjectSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path, query, body }) =>
      safely(async () => {
        assertMutationsEnabled(config);
        await ensureDocumented("POST", path);
        return client.request({ method: "POST", path, query: asQuery(query), body });
      }),
  );

  server.registerTool(
    "asc_api_patch",
    {
      title: "Call any App Store Connect PATCH operation",
      description:
        "Update a resource through any documented App Store Connect PATCH endpoint. Read it first and send Apple's complete JSON:API update document, including matching type and id.",
      inputSchema: z.object({
        path: z.string().startsWith("/v"),
        query: querySchema.optional(),
        body: jsonObjectSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, query, body }) =>
      safely(async () => {
        assertMutationsEnabled(config);
        await ensureDocumented("PATCH", path);
        return client.request({ method: "PATCH", path, query: asQuery(query), body });
      }),
  );

  server.registerTool(
    "asc_api_delete",
    {
      title: "Call any App Store Connect DELETE operation",
      description:
        "Permanently delete a resource through a documented endpoint. Requires both mutation opt-in and the literal confirm=true argument.",
      inputSchema: z.object({
        path: z.string().startsWith("/v"),
        query: querySchema.optional(),
        confirm: z.literal(true).describe("Must be true after confirming the exact resource."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, query }) =>
      safely(async () => {
        assertMutationsEnabled(config);
        await ensureDocumented("DELETE", path);
        return client.request({ method: "DELETE", path, query: asQuery(query) });
      }),
  );

  server.registerTool(
    "asc_download",
    {
      title: "Download an App Store Connect report or file",
      description:
        "Download a documented GET endpoint response to a file under ASC_DOWNLOAD_ROOT. Use for sales, finance, analytics, diagnostics, profiles, certificates, and other binary or compressed responses.",
      inputSchema: z.object({
        path: z.string().startsWith("/v"),
        query: querySchema.optional(),
        outputPath: z
          .string()
          .min(1)
          .describe("Path relative to ASC_DOWNLOAD_ROOT, such as reports/sales.csv.gz."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path, query, outputPath }) =>
      safely(async () => {
        await ensureDocumented("GET", path);
        return client.download(path, asQuery(query), outputPath);
      }),
  );

  const uploadOperationSchema = z.object({
    method: z.string(),
    url: z.string().url(),
    length: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    requestHeaders: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
    partNumber: z.number().int().positive().optional(),
  });

  server.registerTool(
    "asc_upload_parts",
    {
      title: "Upload reserved App Store Connect file parts",
      description:
        "Upload a local file using the time-limited uploadOperations returned by an Apple reservation. Returns the whole-file MD5 and any part ETags for a later commit. File access and upload hosts are constrained by configuration.",
      inputSchema: z.object({
        filePath: z.string().min(1).describe("Path under ASC_UPLOAD_ROOT."),
        operations: z.array(uploadOperationSchema).min(1),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ filePath, operations }) =>
      safely(async () => {
        assertMutationsEnabled(config);
        return uploader.uploadParts({ filePath, operations });
      }),
  );

  server.registerTool(
    "asc_upload_asset",
    {
      title: "Reserve, upload, and commit an App Store Connect asset",
      description:
        "Run Apple's complete four-step asset flow for screenshots, previews, review attachments, routing coverage, App Clip images, Game Center images, and IAP/subscription images. This reserves the asset, uploads all byte ranges, and commits it with an MD5 checksum; poll the returned resource separately until processing is COMPLETE.",
      inputSchema: z.object({
        filePath: z.string().min(1).describe("Path under ASC_UPLOAD_ROOT."),
        reservationPath: z
          .string()
          .startsWith("/v")
          .describe("Documented POST collection path, for example /v1/appScreenshots."),
        resourceType: z
          .string()
          .min(1)
          .describe("JSON:API type, for example appScreenshots."),
        attributes: jsonObjectSchema
          .optional()
          .describe("Additional reservation attributes; fileName and fileSize are derived."),
        relationships: jsonObjectSchema.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      safely(async () => {
        assertMutationsEnabled(config);
        await ensureDocumented("POST", args.reservationPath);
        await ensureDocumented(
          "PATCH",
          `${args.reservationPath.replace(/\/$/, "")}/reserved-resource-id`,
        );
        return uploader.uploadAsset(args);
      }),
  );

  server.registerResource(
    "openapi-summary",
    "appstore://openapi/summary",
    {
      title: "App Store Connect OpenAPI summary",
      description: "Version, coverage, methods, and resource tags in the bundled Apple specification.",
      mimeType: "application/json",
      cacheHint: { ttlMs: 86_400_000, cacheScope: "public" },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await catalog.summary(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "server-configuration",
    "appstore://server/configuration",
    {
      title: "App Store Connect MCP configuration",
      description: "Non-secret runtime configuration and safety boundaries.",
      mimeType: "application/json",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              ...tokenProvider.getStatus(),
              apiBaseUrl: config.apiBaseUrl.toString(),
              mutationsEnabled: config.enableMutations,
              uploadRoot: config.uploadRoot,
              downloadRoot: config.downloadRoot,
              maxPages: config.maxPages,
              uploadHostSuffixes: config.uploadHostSuffixes,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}
