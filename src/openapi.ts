import { readFile } from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

import type { HttpMethod } from "./types.js";

const gunzipAsync = promisify(gunzip);
const HTTP_METHODS = new Set(["get", "post", "patch", "delete", "put"]);

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  [key: string]: unknown;
}

interface OpenApiPathItem {
  parameters?: unknown[];
  [key: string]: unknown;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; [key: string]: unknown };
  servers?: { url: string }[];
  paths: Record<string, OpenApiPathItem>;
  components?: Record<string, Record<string, unknown>>;
}

export interface OperationSummary {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  tags: string[];
  deprecated: boolean;
}

export interface OperationSearchOptions {
  query?: string;
  method?: HttpMethod;
  tag?: string;
  limit?: number;
}

export interface OperationDescriptionOptions {
  operationId?: string;
  method?: HttpMethod;
  path?: string;
  includeResponseSchemas?: boolean;
}

function operationSummary(
  path: string,
  method: string,
  operation: OpenApiOperation,
): OperationSummary {
  return {
    operationId: operation.operationId ?? `${method}_${path}`,
    method: method.toUpperCase() as HttpMethod,
    path,
    ...(operation.summary ? { summary: operation.summary } : {}),
    tags: operation.tags ?? [],
    deprecated: operation.deprecated ?? false,
  };
}

function pointerValue(document: unknown, reference: string): unknown {
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = document;
  for (const encodedPart of reference.slice(2).split("/")) {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof current !== "object" || current === null || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveOuterReference(document: OpenApiDocument, value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof (value as { $ref: unknown }).$ref === "string"
  ) {
    return pointerValue(document, (value as { $ref: string }).$ref) ?? value;
  }
  return value;
}

function responseSummary(
  document: OpenApiDocument,
  responses: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(responses ?? {}).map(([status, unresolved]) => {
      const response = resolveOuterReference(document, unresolved) as
        | Record<string, unknown>
        | undefined;
      const content = response?.content;
      return [
        status,
        {
          ...(typeof response?.description === "string"
            ? { description: response.description }
            : {}),
          contentTypes:
            typeof content === "object" && content !== null
              ? Object.keys(content)
              : [],
        },
      ];
    }),
  );
}

function pathMatches(template: string, actual: string): boolean {
  const templateParts = template.split("/");
  const actualParts = actual.split("/");
  if (templateParts.length !== actualParts.length) return false;
  return templateParts.every(
    (part, index) =>
      (part.startsWith("{") && part.endsWith("}")) || part === actualParts[index],
  );
}

export class OpenApiCatalog {
  private documentPromise?: Promise<OpenApiDocument>;
  private operationsPromise?: Promise<OperationSummary[]>;

  constructor(
    private readonly specificationUrl = new URL(
      "../data/app-store-connect-openapi.json.gz",
      import.meta.url,
    ),
  ) {}

  async summary(): Promise<Record<string, unknown>> {
    const document = await this.document();
    const operations = await this.operations();
    const tags = [...new Set(operations.flatMap((operation) => operation.tags))].sort();
    const methods = Object.fromEntries(
      ["GET", "POST", "PATCH", "DELETE"].map((method) => [
        method,
        operations.filter((operation) => operation.method === method).length,
      ]),
    );
    return {
      title: document.info.title,
      version: document.info.version,
      openapi: document.openapi,
      servers: document.servers,
      paths: Object.keys(document.paths).length,
      operations: operations.length,
      methods,
      tags,
    };
  }

  async search(options: OperationSearchOptions): Promise<OperationSummary[]> {
    const query = options.query?.trim().toLowerCase() ?? "";
    const tag = options.tag?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const terms = query.split(/\s+/).filter(Boolean);

    return (await this.operations())
      .filter(
        (operation) =>
          (!options.method || operation.method === options.method) &&
          (!tag || operation.tags.some((value) => value.toLowerCase() === tag)),
      )
      .map((operation) => {
        const id = operation.operationId.toLowerCase();
        const path = operation.path.toLowerCase();
        const summary = operation.summary?.toLowerCase() ?? "";
        const tags = operation.tags.join(" ").toLowerCase();
        const searchable = `${id} ${path} ${summary} ${tags}`;
        const matches = terms.every((term) => searchable.includes(term));
        const score = terms.reduce(
          (total, term) =>
            total +
            (id === term ? 20 : id.includes(term) ? 10 : 0) +
            (path.includes(term) ? 6 : 0) +
            (tags.includes(term) ? 4 : 0) +
            (summary.includes(term) ? 2 : 0),
          0,
        );
        return { operation, matches, score };
      })
      .filter(({ matches }) => terms.length === 0 || matches)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.operation.operationId.localeCompare(right.operation.operationId),
      )
      .slice(0, limit)
      .map(({ operation }) => operation);
  }

  async describe(
    options: OperationDescriptionOptions,
  ): Promise<Record<string, unknown> | undefined> {
    const document = await this.document();
    const match = this.findRawOperation(document, options);
    if (!match) return undefined;
    const { path, method, pathItem, operation } = match;
    const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map(
      (parameter) => resolveOuterReference(document, parameter),
    );
    const requestBody = resolveOuterReference(document, operation.requestBody);
    const responses = options.includeResponseSchemas
      ? Object.fromEntries(
          Object.entries(operation.responses ?? {}).map(([status, response]) => [
            status,
            resolveOuterReference(document, response),
          ]),
        )
      : responseSummary(document, operation.responses);

    const core = {
      ...operationSummary(path, method, operation),
      ...(operation.description ? { description: operation.description } : {}),
      parameters,
      ...(requestBody === undefined ? {} : { requestBody }),
      responses,
    };
    const referencedComponents = this.collectReferencedComponents(
      document,
      options.includeResponseSchemas
        ? core
        : { ...core, responses: undefined },
    );
    return { ...core, referencedComponents };
  }

  async findOperation(
    method: HttpMethod,
    actualPath: string,
  ): Promise<OperationSummary | undefined> {
    return (await this.operations()).find(
      (operation) =>
        operation.method === method && pathMatches(operation.path, actualPath),
    );
  }

  private document(): Promise<OpenApiDocument> {
    this.documentPromise ??= this.loadDocument();
    return this.documentPromise;
  }

  private operations(): Promise<OperationSummary[]> {
    this.operationsPromise ??= this.loadOperations();
    return this.operationsPromise;
  }

  private async loadDocument(): Promise<OpenApiDocument> {
    const compressed = await readFile(this.specificationUrl);
    const source = await gunzipAsync(compressed);
    return JSON.parse(source.toString("utf8")) as OpenApiDocument;
  }

  private async loadOperations(): Promise<OperationSummary[]> {
    const document = await this.document();
    const operations: OperationSummary[] = [];
    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const [method, candidate] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method) || typeof candidate !== "object" || !candidate) {
          continue;
        }
        operations.push(
          operationSummary(path, method, candidate as OpenApiOperation),
        );
      }
    }
    return operations;
  }

  private findRawOperation(
    document: OpenApiDocument,
    options: OperationDescriptionOptions,
  ):
    | {
        path: string;
        method: string;
        pathItem: OpenApiPathItem;
        operation: OpenApiOperation;
      }
    | undefined {
    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const [method, candidate] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method) || typeof candidate !== "object" || !candidate) {
          continue;
        }
        const operation = candidate as OpenApiOperation;
        const idMatches =
          options.operationId && operation.operationId === options.operationId;
        const pathMatchesOptions =
          options.path === path &&
          (!options.method || options.method.toLowerCase() === method);
        if (idMatches || pathMatchesOptions) {
          return { path, method, pathItem, operation };
        }
      }
    }
    return undefined;
  }

  private collectReferencedComponents(
    document: OpenApiDocument,
    root: unknown,
  ): Record<string, unknown> {
    const collected: Record<string, unknown> = {};
    const visited = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (typeof record.$ref === "string" && record.$ref.startsWith("#/components/")) {
        const reference = record.$ref;
        if (!visited.has(reference) && visited.size < 200) {
          visited.add(reference);
          const resolved = pointerValue(document, reference);
          if (resolved !== undefined) {
            collected[reference.replace("#/components/", "")] = resolved;
            visit(resolved);
          }
        }
      }
      Object.values(record).forEach(visit);
    };
    visit(root);
    return collected;
  }
}
