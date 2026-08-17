import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppStoreConnectClient } from "../src/client.js";
import { SafetyError } from "../src/errors.js";
import { AssetUploader } from "../src/upload.js";
import { testConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AssetUploader", () => {
  it("uploads exact byte ranges and computes the whole-file MD5", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-upload-test-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "asset.bin"), "abcdefghij");
    const config = testConfig(
      {
        ASC_UPLOAD_ROOT: ".",
        ASC_ALLOW_INSECURE_BASE_URL: "true",
        ASC_API_BASE_URL: "http://api.local/",
        ASC_UPLOAD_HOST_SUFFIXES: "uploads.local",
      },
      root,
    );
    const chunks: string[] = [];
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      chunks.push(await new Response(init?.body).text());
      return new Response(null, { status: 200, headers: { etag: `part-${chunks.length}` } });
    }) as typeof fetch;
    const request = vi.fn() as unknown as AppStoreConnectClient["request"];
    const uploader = new AssetUploader(config, { request }, { fetch: fetchMock });

    const result = await uploader.uploadParts({
      filePath: "asset.bin",
      operations: [
        { method: "PUT", url: "http://uploads.local/one", offset: 0, length: 4 },
        { method: "PUT", url: "http://uploads.local/two", offset: 4, length: 6 },
      ],
    });

    expect(chunks.sort()).toEqual(["abcd", "efghij"]);
    expect(result.md5).toBe(createHash("md5").update("abcdefghij").digest("hex"));
    expect(result.parts.map((part) => part.entityTag).sort()).toEqual(["part-1", "part-2"]);
  });

  it("rejects gaps in upload operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-upload-test-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "asset.bin"), "abcdefghij");
    const config = testConfig(
      {
        ASC_UPLOAD_ROOT: ".",
        ASC_ALLOW_INSECURE_BASE_URL: "true",
        ASC_API_BASE_URL: "http://api.local/",
        ASC_UPLOAD_HOST_SUFFIXES: "uploads.local",
      },
      root,
    );
    const request = vi.fn() as unknown as AppStoreConnectClient["request"];
    const uploader = new AssetUploader(config, { request });

    await expect(
      uploader.uploadParts({
        filePath: "asset.bin",
        operations: [
          { method: "PUT", url: "http://uploads.local/one", offset: 1, length: 9 },
        ],
      }),
    ).rejects.toBeInstanceOf(SafetyError);
  });

  it("rejects upload hosts outside the allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-upload-test-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "asset.bin"), "abc");
    const config = testConfig({ ASC_UPLOAD_ROOT: "." }, root);
    const request = vi.fn() as unknown as AppStoreConnectClient["request"];
    const uploader = new AssetUploader(config, { request });

    await expect(
      uploader.uploadParts({
        filePath: "asset.bin",
        operations: [
          { method: "PUT", url: "https://example.com/upload", offset: 0, length: 3 },
        ],
      }),
    ).rejects.toBeInstanceOf(SafetyError);
  });

  it("does not retry a rejected 4xx upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-upload-test-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "asset.bin"), "abc");
    const config = testConfig(
      {
        ASC_UPLOAD_ROOT: ".",
        ASC_ALLOW_INSECURE_BASE_URL: "true",
        ASC_API_BASE_URL: "http://api.local/",
        ASC_UPLOAD_HOST_SUFFIXES: "uploads.local",
      },
      root,
    );
    const request = vi.fn() as unknown as AppStoreConnectClient["request"];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("expired", { status: 403 }));
    const uploader = new AssetUploader(config, { request }, { fetch: fetchMock });

    await expect(
      uploader.uploadParts({
        filePath: "asset.bin",
        operations: [
          { method: "PUT", url: "http://uploads.local/one", offset: 0, length: 3 },
        ],
      }),
    ).rejects.toThrow("HTTP 403");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
