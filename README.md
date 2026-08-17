# App Store Connect MCP

A production-conscious Model Context Protocol server for Apple's App Store Connect API, built with Node.js, TypeScript, and the MCP TypeScript SDK v2 (`2026-07-28`). It exposes focused tools for apps and product catalogs, plus a schema-aware request layer that reaches every operation in Apple's OpenAPI specification.

The bundled App Store Connect API `4.4.1` specification contains **1,263 operations across 966 paths**. Coverage includes app metadata and versions, in-app purchases, subscriptions and pricing, TestFlight, builds, reviews, users and invitations, provisioning, Game Center, Xcode Cloud, analytics and reports, webhooks, App Clips, and alternative distribution.

## Why the tool surface is hybrid

Creating 1,263 MCP tools would overwhelm clients and models. This server instead provides:

- focused tools for common app, in-app purchase, and subscription reads;
- local OpenAPI search and operation-description tools with exact request schemas;
- generic, validated GET/POST/PATCH/DELETE tools for the complete API surface;
- dedicated streaming downloads and Apple's multi-part asset upload workflow.

Unknown endpoints are rejected by default. Run `npm run sync:openapi` when Apple publishes an update.

## Requirements

- Node.js 20 or newer
- An App Store Connect team or individual API key
- The App Store Connect role(s) required by the operations you plan to call

Apple only lets you download a `.p8` private key once. Keep it outside the repository and never put it in client-side code.

## Install and build

```bash
npm install
npm run build
```

Copy `.env.example` into your own secret-management workflow. The server reads environment variables directly; it does not automatically load `.env` files.

### Team key

```bash
export ASC_KEY_ID="ABC123DEFG"
export ASC_ISSUER_ID="00000000-0000-0000-0000-000000000000"
export ASC_PRIVATE_KEY_PATH="/absolute/path/AuthKey_ABC123DEFG.p8"
```

### Individual key

```bash
export ASC_KEY_ID="ABC123DEFG"
export ASC_KEY_TYPE="individual"
export ASC_PRIVATE_KEY_PATH="/absolute/path/AuthKey_ABC123DEFG.p8"
```

Individual keys use the permissions of their user and cannot access some areas, including provisioning and Sales and Finance. Team keys require `ASC_ISSUER_ID`.

## Run over stdio

```bash
npm start
```

Use an absolute build path in an MCP client's configuration:

```json
{
  "mcpServers": {
    "app-store-connect": {
      "command": "node",
      "args": ["/absolute/path/appstore-mcp/build/index.js"],
      "env": {
        "ASC_KEY_ID": "ABC123DEFG",
        "ASC_ISSUER_ID": "00000000-0000-0000-0000-000000000000",
        "ASC_PRIVATE_KEY_PATH": "/absolute/path/AuthKey_ABC123DEFG.p8"
      }
    }
  }
}
```

The protocol uses stdout. Diagnostics are written only to stderr.

## Run over Streamable HTTP

```bash
export MCP_BEARER_TOKEN="a-long-random-secret"
npm run start:http
```

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Health endpoint: `http://127.0.0.1:3000/health`

Set `ASC_HTTP_HOST` and `ASC_HTTP_PORT` to change the listener. A bearer token is mandatory when binding to a non-loopback address. This transport is intentionally single-tenant: for a public or multi-user deployment, terminate TLS and implement standards-compliant MCP OAuth in a gateway rather than sharing one Apple credential among unrelated users.

## Tools

| Tool | Purpose | Write guard |
| --- | --- | --- |
| `asc_auth_status` | Inspect non-secret configuration and optionally verify credentials | Read-only |
| `asc_search_operations` | Search all bundled Apple operations | Local, read-only |
| `asc_describe_operation` | Get exact parameters, body schema, responses, and referenced schemas | Local, read-only |
| `asc_list_apps` | List apps with common filters, includes, fields, and pagination | Read-only |
| `asc_get_app` | Get one app | Read-only |
| `asc_list_in_app_purchases` | List an app's in-app purchase products | Read-only |
| `asc_list_subscription_groups` | List an app's subscription groups | Read-only |
| `asc_list_subscriptions` | List subscriptions in a group | Read-only |
| `asc_api_get` | Call any documented GET operation | Read-only |
| `asc_api_post` | Call any documented POST operation | `ASC_ENABLE_MUTATIONS=true` |
| `asc_api_patch` | Call any documented PATCH operation | `ASC_ENABLE_MUTATIONS=true` |
| `asc_api_delete` | Call any documented DELETE operation | Mutation opt-in and `confirm=true` |
| `asc_download` | Stream a report or binary response under the download root | Read-only API call; local file write |
| `asc_upload_parts` | Upload byte ranges from an existing Apple reservation | Mutation opt-in |
| `asc_upload_asset` | Reserve, upload, and commit a conventional App Store asset | Mutation opt-in |

The server also exposes `appstore://openapi/summary` and `appstore://server/configuration` as MCP resources.

## Recommended agent workflow

For an unfamiliar operation:

1. Call `asc_search_operations` with the user's intent, such as `app screenshot create` or `beta tester invite`.
2. Call `asc_describe_operation` with the returned `operationId`.
3. Read the current resource state with the focused tool or `asc_api_get`.
4. Build the exact JSON:API body from the described request schema.
5. Only when the user requested the change, call `asc_api_post`, `asc_api_patch`, or `asc_api_delete`.
6. Re-read the resource to verify the resulting state.

Query keys are passed exactly as Apple names them. Arrays become comma-separated values:

```json
{
  "path": "/v1/apps",
  "query": {
    "filter[bundleId]": ["com.example.one", "com.example.two"],
    "fields[apps]": ["name", "bundleId", "sku"],
    "include": ["appStoreVersions"],
    "limit": 50
  },
  "paginate": true,
  "maxPages": 5
}
```

POST and PATCH bodies are not synthesized or rewritten. Pass Apple's complete JSON:API document, including `data.type` and—on updates—`data.id`.

## Asset uploads

`asc_upload_asset` implements Apple's reserve → upload parts → commit flow for screenshots, previews, App Review attachments, routing coverage, App Clip and Game Center images, and in-app purchase/subscription images. It derives the filename and byte size, uploads every Apple-specified range, calculates the whole-file MD5, and commits the reservation.

Example arguments for a screenshot:

```json
{
  "filePath": "screenshots/iphone-home.png",
  "reservationPath": "/v1/appScreenshots",
  "resourceType": "appScreenshots",
  "relationships": {
    "appScreenshotSet": {
      "data": {
        "type": "appScreenshotSets",
        "id": "SCREENSHOT_SET_ID"
      }
    }
  }
}
```

The file must be under `ASC_UPLOAD_ROOT`. Upload URLs must match `ASC_UPLOAD_HOST_SUFFIXES` (default `.apple.com`). For newer delivery workflows such as build-upload parts, use `asc_upload_parts`, then construct the resource-specific commit body described by the OpenAPI operation.

## Reports and downloads

Report endpoints often return gzip or other binary content. `asc_download` streams the response instead of placing it in model context. `outputPath` is always relative to `ASC_DOWNLOAD_ROOT`; traversal and symlink escapes are rejected. Files are written with mode `0600` through a temporary file and published atomically. An existing destination is never overwritten.

## Safety defaults

- Writes are off until `ASC_ENABLE_MUTATIONS=true`.
- Deletes also require a literal `confirm=true` tool argument.
- Generic requests must match the bundled OpenAPI document unless `ASC_ALLOW_UNDOCUMENTED_ENDPOINTS=true`.
- API requests cannot switch origin or use unversioned paths.
- Pagination links must remain on the configured API origin.
- Upload reads and download writes are restricted to configured roots.
- Pre-signed upload hosts are allowlisted and sensitive headers are rejected.
- GETs retry HTTP 429/502/503/504 with backoff; non-idempotent POST/PATCH requests are not automatically retried.
- JSON response and download sizes are bounded.
- JWTs use ES256, last at most 20 minutes, and are cached only until shortly before expiry.

Apple changes made through the API affect production App Store Connect data. Role permissions still apply, and Apple does not expose every web-console action through the API. For example, Apple's Apps documentation states that creating a new app record is done in the App Store Connect website rather than the API.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `ASC_KEY_ID` | — | Apple API key ID |
| `ASC_ISSUER_ID` | — | Required for a team key; omit for individual |
| `ASC_KEY_TYPE` | `auto` | `auto`, `team`, or `individual` |
| `ASC_PRIVATE_KEY_PATH` | — | Path to the `.p8` private key |
| `ASC_PRIVATE_KEY` | — | Inline PEM, supporting literal `\n`; use instead of the path |
| `ASC_TOKEN_TTL_SECONDS` | `600` | JWT lifetime, 30–1200 seconds |
| `ASC_TOKEN_SCOPE` | — | Optional JSON array of Apple JWT scope strings |
| `ASC_ENABLE_MUTATIONS` | `false` | Enables POST, PATCH, DELETE, and uploads |
| `ASC_API_BASE_URL` | Apple's production API | Override primarily for testing |
| `ASC_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout |
| `ASC_MAX_RETRIES` | `3` | Retry count for safe API reads and upload parts |
| `ASC_MAX_PAGES` | `10` | Server-wide pagination ceiling |
| `ASC_MAX_JSON_RESPONSE_BYTES` | `10485760` | Maximum in-context response size |
| `ASC_MAX_DOWNLOAD_BYTES` | `2147483648` | Maximum streamed download size |
| `ASC_UPLOAD_ROOT` | Current directory | Root containing uploadable files |
| `ASC_DOWNLOAD_ROOT` | `./downloads` | Root receiving downloads |
| `ASC_UPLOAD_CONCURRENCY` | `4` | Parallel upload parts, 1–16 |
| `ASC_UPLOAD_HOST_SUFFIXES` | `.apple.com` | Comma-separated pre-signed upload host allowlist |
| `ASC_ALLOW_UNDOCUMENTED_ENDPOINTS` | `false` | Bypass OpenAPI endpoint matching |
| `ASC_HTTP_HOST` | `127.0.0.1` | HTTP listener host |
| `ASC_HTTP_PORT` | `3000` | HTTP listener port |
| `MCP_BEARER_TOKEN` | — | HTTP transport bearer token |

## Container

```bash
docker build -t app-store-connect-mcp .
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -e ASC_HTTP_HOST=0.0.0.0 \
  -e MCP_BEARER_TOKEN="a-long-random-secret" \
  -e ASC_KEY_ID="ABC123DEFG" \
  -e ASC_ISSUER_ID="00000000-0000-0000-0000-000000000000" \
  -e ASC_PRIVATE_KEY_PATH="/run/secrets/AuthKey.p8" \
  -v /absolute/path/AuthKey_ABC123DEFG.p8:/run/secrets/AuthKey.p8:ro \
  app-store-connect-mcp
```

Mount separate upload and download directories when file tools are needed.

## Update Apple's OpenAPI document

```bash
npm run sync:openapi
npm test
```

The sync script downloads Apple's official ZIP, validates its identity, and stores a deterministic gzip copy in `data/`. Search and endpoint validation then use the updated document without network access at runtime.

## Development

```bash
npm run typecheck
npm test
npm run build
```

To inspect the stdio server interactively:

```bash
npx @modelcontextprotocol/inspector node build/index.js
```

## Scope

This project wraps the **App Store Connect API** at `api.appstoreconnect.apple.com`. Apple's separate App Store Server API for transaction history, subscription status, refunds, and server notifications uses different endpoints and authentication semantics and is intentionally outside this server's current scope.
