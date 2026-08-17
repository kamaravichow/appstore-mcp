import { describe, expect, it } from "vitest";

import { OpenApiCatalog } from "../src/openapi.js";

const catalog = new OpenApiCatalog();

describe("OpenApiCatalog", () => {
  it("loads Apple's bundled API metadata", async () => {
    const summary = await catalog.summary();
    expect(summary).toMatchObject({
      title: "App Store Connect API",
      version: "4.4.1",
      paths: 966,
      operations: 1263,
    });
  });

  it("searches operations by intent and method", async () => {
    const matches = await catalog.search({
      query: "apps collection",
      method: "GET",
      limit: 10,
    });
    expect(matches.some((operation) => operation.operationId === "apps_getCollection")).toBe(true);
  });

  it("describes request parameters and referenced schemas", async () => {
    const operation = await catalog.describe({ operationId: "apps_getCollection" });
    expect(operation).toMatchObject({
      operationId: "apps_getCollection",
      method: "GET",
      path: "/v1/apps",
    });
    expect(operation?.parameters).toBeInstanceOf(Array);
  });

  it("matches concrete request paths to templated operations", async () => {
    const operation = await catalog.findOperation("GET", "/v1/apps/12345");
    expect(operation?.operationId).toBe("apps_getInstance");
  });
});
