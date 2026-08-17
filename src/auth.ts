import { readFile } from "node:fs/promises";

import { importPKCS8, SignJWT } from "jose";

import {
  assertCredentialsConfigured,
  type AppStoreConnectConfig,
} from "./config.js";

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface TokenProviderOptions {
  now?: () => number;
}

export class AppStoreConnectTokenProvider {
  private readonly now: () => number;
  private keyPromise?: Promise<CryptoKey>;
  private readonly tokens = new Map<string, CachedToken>();

  constructor(
    private readonly config: AppStoreConnectConfig,
    options: TokenProviderOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  async getToken(scope = this.config.tokenScope): Promise<string> {
    assertCredentialsConfigured(this.config);
    const cacheKey = JSON.stringify(scope ?? []);
    const nowSeconds = Math.floor(this.now() / 1_000);
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt - 30 > nowSeconds) return cached.token;

    const key = await this.getKey();
    const expiresAt = nowSeconds + this.config.tokenTtlSeconds;
    let signer = new SignJWT(scope ? { scope } : {})
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId, typ: "JWT" })
      .setIssuedAt(nowSeconds)
      .setExpirationTime(expiresAt)
      .setAudience("appstoreconnect-v1");

    signer =
      this.config.keyType === "team"
        ? signer.setIssuer(this.config.issuerId as string)
        : signer.setSubject("user");

    const token = await signer.sign(key);
    this.tokens.set(cacheKey, { token, expiresAt });
    return token;
  }

  getStatus(): Record<string, unknown> {
    const credentialSource = this.config.privateKey
      ? "environment"
      : this.config.privateKeyPath
        ? "file"
        : "missing";
    const missing = [
      ...(this.config.keyId ? [] : ["ASC_KEY_ID"]),
      ...(credentialSource === "missing"
        ? ["ASC_PRIVATE_KEY or ASC_PRIVATE_KEY_PATH"]
        : []),
      ...(this.config.keyType === "team" && !this.config.issuerId
        ? ["ASC_ISSUER_ID"]
        : []),
    ];

    return {
      configured: missing.length === 0,
      keyType: this.config.keyType,
      keyId: this.config.keyId ?? null,
      issuerIdConfigured: Boolean(this.config.issuerId),
      credentialSource,
      tokenTtlSeconds: this.config.tokenTtlSeconds,
      scopedToken: Boolean(this.config.tokenScope?.length),
      missing,
    };
  }

  clear(): void {
    this.tokens.clear();
    this.keyPromise = undefined;
  }

  private getKey(): Promise<CryptoKey> {
    this.keyPromise ??= this.loadKey();
    return this.keyPromise;
  }

  private async loadKey(): Promise<CryptoKey> {
    assertCredentialsConfigured(this.config);
    const pem =
      this.config.privateKey ??
      (await readFile(this.config.privateKeyPath as string, "utf8"));
    return importPKCS8(pem.trim(), "ES256");
  }
}
