#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { strFromU8, unzipSync } from "fflate";

const SOURCE_URL =
  "https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const dataDirectory = resolve(projectRoot, "data");
const outputPath = resolve(dataDirectory, "app-store-connect-openapi.json.gz");
const metadataPath = resolve(dataDirectory, "openapi-meta.json");

function getInputArgument() {
  const index = process.argv.indexOf("--input");
  return index === -1 ? undefined : process.argv[index + 1];
}

async function loadSpecification() {
  const input = getInputArgument();
  if (input) return readFile(resolve(process.cwd(), input), "utf8");

  const response = await fetch(SOURCE_URL, {
    headers: { "user-agent": "app-store-connect-mcp-openapi-sync" },
  });
  if (!response.ok) {
    throw new Error(`OpenAPI download failed with HTTP ${response.status}`);
  }
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const specificationEntry = Object.entries(archive).find(
    ([name]) => !name.startsWith("__MACOSX/") && name.endsWith(".json"),
  );
  if (!specificationEntry) throw new Error("The archive contains no JSON file");
  return strFromU8(specificationEntry[1]);
}

function operationCount(document) {
  const methods = new Set(["get", "post", "patch", "delete", "put"]);
  return Object.values(document.paths ?? {}).reduce(
    (total, pathItem) =>
      total +
      Object.keys(pathItem).filter((method) => methods.has(method)).length,
    0,
  );
}

const source = await loadSpecification();
const document = JSON.parse(source);
if (
  document?.openapi !== "3.0.1" ||
  document?.info?.title !== "App Store Connect API" ||
  typeof document?.info?.version !== "string"
) {
  throw new Error("Downloaded file is not the expected App Store Connect OpenAPI document");
}

const normalized = `${JSON.stringify(document)}\n`;
const metadata = {
  title: document.info.title,
  version: document.info.version,
  openapi: document.openapi,
  paths: Object.keys(document.paths ?? {}).length,
  operations: operationCount(document),
  source: SOURCE_URL,
  file: "app-store-connect-openapi.json.gz",
};

await mkdir(dataDirectory, { recursive: true });
await writeFile(outputPath, gzipSync(normalized, { level: 9 }));
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
process.stderr.write(
  `Stored App Store Connect API ${metadata.version}: ${metadata.operations} operations across ${metadata.paths} paths.\n`,
);
