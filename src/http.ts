#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import {
  createAppStoreConnectRuntime,
  createAppStoreConnectServer,
} from "./server.js";

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ASC_HTTP_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function secretsMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

const host = process.env.ASC_HTTP_HOST ?? "127.0.0.1";
const port = parsePort(process.env.ASC_HTTP_PORT);
const bearerToken = process.env.MCP_BEARER_TOKEN?.trim();
if (!isLoopback(host) && !bearerToken) {
  throw new Error(
    "MCP_BEARER_TOKEN is required when ASC_HTTP_HOST is not loopback. This is a single-tenant transport; put a standards-compliant OAuth gateway in front of it for multi-user deployments.",
  );
}

const runtime = createAppStoreConnectRuntime();
const mcpHandler = createMcpHandler(() => createAppStoreConnectServer(runtime));
const nodeHandler = toNodeHandler(mcpHandler);
const httpServer = createHttpServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/health" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "app-store-connect-mcp" }));
    return;
  }
  if (url.pathname !== "/mcp") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  if (bearerToken) {
    const authorization = request.headers.authorization ?? "";
    const expected = `Bearer ${bearerToken}`;
    if (!secretsMatch(authorization, expected)) {
      response.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }
  try {
    await nodeHandler(request, response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Internal server error" }));
      return;
    }
    response.end();
  }
});

httpServer.listen(port, host, () => {
  console.error(`App Store Connect MCP server listening on http://${host}:${port}/mcp`);
});

async function shutdown(): Promise<void> {
  httpServer.close();
  await mcpHandler.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
