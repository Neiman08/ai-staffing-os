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

// ---------- F17: Microsoft Graph -- credenciales completas o ninguna, MAIL_FROM del dominio propio ----------

test("env: Microsoft Graph con solo AZURE_TENANT_ID (configuración parcial) se niega a arrancar", () => {
  const result = runEnv({ AZURE_TENANT_ID: "fake-tenant", AZURE_CLIENT_ID: "", AZURE_CLIENT_SECRET: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Microsoft Graph requires AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET together/);
});

test("env: Microsoft Graph con 2 de 3 credenciales (configuración parcial) se niega a arrancar", () => {
  const result = runEnv({ AZURE_TENANT_ID: "fake-tenant", AZURE_CLIENT_ID: "fake-client", AZURE_CLIENT_SECRET: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Microsoft Graph requires AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET together/);
});

test("env: Microsoft Graph con las 3 credenciales arranca normalmente", () => {
  const result = runEnv({
    AZURE_TENANT_ID: "fake-tenant",
    AZURE_CLIENT_ID: "fake-client",
    AZURE_CLIENT_SECRET: "fake-secret",
  });
  assert.equal(result.status, 0);
});

test("env: sin ninguna credencial de Microsoft Graph arranca normalmente (proveedor simplemente no configurado)", () => {
  const result = runEnv({ AZURE_TENANT_ID: "", AZURE_CLIENT_ID: "", AZURE_CLIENT_SECRET: "" });
  assert.equal(result.status, 0);
});

test("env: MAIL_FROM en un dominio ajeno a BUSINESS_DOMAIN se niega a arrancar", () => {
  const result = runEnv({ MAIL_FROM: "hello@otro-dominio.com" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MAIL_FROM \("hello@otro-dominio\.com"\) must be an address on BUSINESS_DOMAIN/);
});

test("env: MAIL_FROM en el propio BUSINESS_DOMAIN arranca normalmente", () => {
  const result = runEnv({ MAIL_FROM: "hello@dreistaff.com", BUSINESS_DOMAIN: "dreistaff.com" });
  assert.equal(result.status, 0);
});
