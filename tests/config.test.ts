import { describe, expect, it } from "vitest";

import { ConfigurationError, SafetyError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("infers team keys and keeps mutations disabled by default", () => {
    const config = loadConfig({
      ASC_KEY_ID: "ABC123",
      ASC_ISSUER_ID: "issuer",
      ASC_PRIVATE_KEY: "line1\\nline2",
    });

    expect(config.keyType).toBe("team");
    expect(config.privateKey).toBe("line1\nline2");
    expect(config.enableMutations).toBe(false);
    expect(config.apiBaseUrl.href).toBe("https://api.appstoreconnect.apple.com/");
  });

  it("infers an individual key when issuer ID is absent", () => {
    const config = loadConfig({
      ASC_KEY_ID: "ABC123",
      ASC_PRIVATE_KEY: "private-key",
    });
    expect(config.keyType).toBe("individual");
  });

  it("parses mutation opt-in and token scope", () => {
    const config = loadConfig({
      ASC_ENABLE_MUTATIONS: "true",
      ASC_TOKEN_SCOPE: '["GET /v1/apps"]',
    });
    expect(config.enableMutations).toBe(true);
    expect(config.tokenScope).toEqual(["GET /v1/apps"]);
  });

  it("rejects invalid numeric settings", () => {
    expect(() => loadConfig({ ASC_TOKEN_TTL_SECONDS: "1201" })).toThrow(
      ConfigurationError,
    );
  });

  it("rejects insecure base URLs by default", () => {
    expect(() =>
      loadConfig({ ASC_API_BASE_URL: "http://localhost:9999" }),
    ).toThrow(SafetyError);
  });
});
