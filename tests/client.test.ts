import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppStoreConnectClient } from "../src/client.js";
import { SafetyError } from "../src/errors.js";
import { testConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function tokenProvider() {
  return { getToken: async () => "signed-token" };
}

describe("AppStoreConnectClient", () => {
  it("serializes Apple-style query parameters and authorization", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.searchParams.get("filter[id]")).toBe("one,two");
      expect(url.searchParams.get("limit")).toBe("5");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer signed-token");
      return Response.json({ data: [] }, { headers: { "x-rate-limit": "user-hour-lim:3500;user-hour-rem:3499;" } });
    }) as typeof fetch;
    const client = new AppStoreConnectClient(testConfig(), tokenProvider(), {
      fetch: fetchMock,
    });

    const response = await client.request({
      method: "GET",
      path: "/v1/apps",
      query: { "filter[id]": ["one", "two"], limit: 5 },
    });

    expect(response.metadata.rateLimit).toMatchObject({ limit: 3500, remaining: 3499 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("collects JSON:API pages and reports truncation", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "1" }],
          links: { next: "https://api.appstoreconnect.apple.com/v1/apps?cursor=next" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: "2" }], links: { next: null } }),
      );
    const client = new AppStoreConnectClient(testConfig(), tokenProvider(), {
      fetch: fetchMock,
    });

    const response = await client.request<{ data: { id: string }[] }>({
      method: "GET",
      path: "/v1/apps",
      paginate: true,
      maxPages: 2,
    });

    expect(response.body.data.map(({ id }) => id)).toEqual(["1", "2"]);
    expect(response.pagesFetched).toBe(2);
    expect(response.paginationTruncated).toBe(false);
  });

  it("retries rate limits for safe requests", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const client = new AppStoreConnectClient(testConfig(), tokenProvider(), {
      fetch: fetchMock,
      sleep,
    });

    await client.request({ method: "GET", path: "/v1/apps" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("surfaces Apple's structured errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        { errors: [{ status: "403", code: "FORBIDDEN", detail: "Role cannot access this resource" }] },
        { status: 403 },
      ),
    );
    const client = new AppStoreConnectClient(testConfig(), tokenProvider(), {
      fetch: fetchMock,
    });

    await expect(client.request({ method: "GET", path: "/v1/apps" })).rejects.toMatchObject({
      status: 403,
      errors: [{ code: "FORBIDDEN" }],
    });
  });

  it("rejects pagination links on another origin", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ data: [], links: { next: "https://example.com/v1/apps" } }),
    );
    const client = new AppStoreConnectClient(testConfig(), tokenProvider(), {
      fetch: fetchMock,
    });
    await expect(
      client.request({ method: "GET", path: "/v1/apps", paginate: true }),
    ).rejects.toBeInstanceOf(SafetyError);
  });

  it("streams downloads beneath the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-client-test-"));
    temporaryDirectories.push(root);
    const config = testConfig({ ASC_DOWNLOAD_ROOT: "downloads" }, root);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new TextEncoder().encode("report-data"), {
        headers: { "content-type": "application/a-gzip" },
      }),
    );
    const client = new AppStoreConnectClient(config, tokenProvider(), { fetch: fetchMock });

    const result = await client.download(
      "/v1/salesReports",
      { "filter[vendorNumber]": "123" },
      "sales/report.gz",
    );
    expect(result.bytes).toBe(11);
    expect(await readFile(result.path, "utf8")).toBe("report-data");
  });

  it("never overwrites an existing download", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-client-test-"));
    temporaryDirectories.push(root);
    const config = testConfig({ ASC_DOWNLOAD_ROOT: "." }, root);
    await writeFile(join(root, "existing.txt"), "keep-me");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("replacement"));
    const client = new AppStoreConnectClient(config, tokenProvider(), { fetch: fetchMock });

    await expect(
      client.download("/v1/salesReports", undefined, "existing.txt"),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("keep-me");
  });
});
