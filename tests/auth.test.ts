import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";

import { AppStoreConnectTokenProvider } from "../src/auth.js";
import { testConfig } from "./helpers.js";

describe("AppStoreConnectTokenProvider", () => {
  it("creates and caches a team-key JWT", async () => {
    const now = 1_800_000_000_000;
    const provider = new AppStoreConnectTokenProvider(testConfig(), { now: () => now });

    const first = await provider.getToken();
    const second = await provider.getToken();
    const header = decodeProtectedHeader(first);
    const payload = decodeJwt(first);

    expect(second).toBe(first);
    expect(header).toMatchObject({ alg: "ES256", typ: "JWT", kid: "TESTKEY123" });
    expect(payload.iss).toBe("00000000-0000-0000-0000-000000000001");
    expect(payload.aud).toBe("appstoreconnect-v1");
    expect(payload.exp! - payload.iat!).toBe(600);
  });

  it("uses sub=user for an individual key", async () => {
    const config = testConfig({ ASC_ISSUER_ID: undefined, ASC_KEY_TYPE: "individual" });
    const provider = new AppStoreConnectTokenProvider(config);
    const payload = decodeJwt(await provider.getToken());

    expect(payload.sub).toBe("user");
    expect(payload.iss).toBeUndefined();
  });

  it("adds an explicit scope claim", async () => {
    const provider = new AppStoreConnectTokenProvider(testConfig());
    const payload = decodeJwt(await provider.getToken(["GET /v1/apps"]));
    expect(payload.scope).toEqual(["GET /v1/apps"]);
  });
});
