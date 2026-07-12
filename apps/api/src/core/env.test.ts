import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// F4.9: env.ts llama a process.exit() al detectar una combinación
// insegura — no se puede probar importando el módulo en el mismo
// proceso (mataría al test runner). Se spawnea un proceso Node real,
// exactamente como arrancaría el server de verdad.
function runEnv(overrides: Record<string, string>) {
  return spawnSync("node", ["--import", "tsx", "-e", "import('./src/core/env.ts')"], {
    cwd: apiRoot,
    env: { ...process.env, ...overrides },
    encoding: "utf-8",
  });
}

test("env: NODE_ENV=production + AUTH_MODE=dev-bypass se niega a arrancar", () => {
  const result = runEnv({ NODE_ENV: "production", AUTH_MODE: "dev-bypass" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AUTH_MODE=dev-bypass is not allowed when NODE_ENV=production/);
});

test("env: NODE_ENV=production + AUTH_MODE=clerk sin claves se niega a arrancar", () => {
  const result = runEnv({
    NODE_ENV: "production",
    AUTH_MODE: "clerk",
    CLERK_SECRET_KEY: "",
    CLERK_PUBLISHABLE_KEY: "",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AUTH_MODE=clerk requires CLERK_SECRET_KEY/);
});

test("env: NODE_ENV=production + AUTH_MODE=clerk con claves arranca", () => {
  const result = runEnv({
    NODE_ENV: "production",
    AUTH_MODE: "clerk",
    CLERK_SECRET_KEY: "sk_test_fake",
    CLERK_PUBLISHABLE_KEY: "pk_test_fake",
  });
  assert.equal(result.status, 0);
});

test("env: NODE_ENV=development + AUTH_MODE=dev-bypass arranca normalmente", () => {
  const result = runEnv({ NODE_ENV: "development", AUTH_MODE: "dev-bypass" });
  assert.equal(result.status, 0);
});
