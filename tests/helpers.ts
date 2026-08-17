import { generateKeyPairSync } from "node:crypto";

import { loadConfig, type Environment } from "../src/config.js";

export function privateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

export function testConfig(
  overrides: Environment = {},
  workingDirectory = process.cwd(),
) {
  return loadConfig(
    {
      ASC_KEY_ID: "TESTKEY123",
      ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000001",
      ASC_PRIVATE_KEY: privateKeyPem(),
      ...overrides,
    },
    workingDirectory,
  );
}
