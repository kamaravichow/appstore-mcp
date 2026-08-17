#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import {
  createAppStoreConnectRuntime,
  createAppStoreConnectServer,
} from "./server.js";

const runtime = createAppStoreConnectRuntime();
void serveStdio(() => createAppStoreConnectServer(runtime));
console.error("App Store Connect MCP server running on stdio");

export {
  createAppStoreConnectRuntime,
  createAppStoreConnectServer,
} from "./server.js";
export { AppStoreConnectClient } from "./client.js";
export { AppStoreConnectTokenProvider } from "./auth.js";
export { OpenApiCatalog } from "./openapi.js";
export { AssetUploader } from "./upload.js";
export { loadConfig } from "./config.js";
