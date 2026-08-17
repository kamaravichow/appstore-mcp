import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createAppStoreConnectServer } from "../src/server.js";

describe("MCP server", () => {
  let client: Client;
  let server: ReturnType<typeof createAppStoreConnectServer>;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createAppStoreConnectServer({ config: loadConfig({}) });
    client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("advertises focused and comprehensive tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("asc_list_apps");
    expect(names).toContain("asc_list_in_app_purchases");
    expect(names).toContain("asc_api_get");
    expect(names).toContain("asc_api_post");
    expect(names).toContain("asc_download");
    expect(names).toContain("asc_upload_asset");
  });

  it("calls local OpenAPI discovery without credentials", async () => {
    const result = await client.callTool({
      name: "asc_search_operations",
      arguments: { query: "beta groups", method: "GET", limit: 5 },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("betaGroups");
  });

  it("blocks writes unless mutations are explicitly enabled", async () => {
    const result = await client.callTool({
      name: "asc_api_post",
      arguments: {
        path: "/v1/betaGroups",
        body: { data: { type: "betaGroups" } },
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("ASC_ENABLE_MUTATIONS");
  });
});
