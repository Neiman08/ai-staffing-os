import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { AppError } from "../errors";
import { runWithTenancyContext } from "../tenancy/context";
import { requirePermission } from "./require-permission";

function runMiddleware(permission: Parameters<typeof requirePermission>[0]): Promise<unknown> {
  return new Promise((resolve) => {
    requirePermission(permission)({} as Request, {} as Response, (err?: unknown) => resolve(err));
  });
}

test("permiso no sensible: nunca lo bloquea el gate de MFA aunque mfaEnforced=true y mfaVerified=false", async () => {
  const err = await runWithTenancyContext(
    { tenantId: "t1", userId: "u1", permissions: ["companies.view"], mfaEnforced: true, mfaVerified: false },
    () => runMiddleware("companies.view"),
  );
  assert.equal(err, undefined);
});

test("permiso sensible (settings.manage): mfaEnforced=false nunca bloquea, sin importar mfaVerified", async () => {
  const err = await runWithTenancyContext(
    { tenantId: "t1", userId: "u1", permissions: ["settings.manage"], mfaEnforced: false, mfaVerified: false },
    () => runMiddleware("settings.manage"),
  );
  assert.equal(err, undefined);
});

test("permiso sensible + mfaEnforced=true + mfaVerified=false → 403 MFA_REQUIRED", async () => {
  const err = await runWithTenancyContext(
    { tenantId: "t1", userId: "u1", permissions: ["settings.manage"], mfaEnforced: true, mfaVerified: false },
    () => runMiddleware("settings.manage"),
  );
  assert.ok(err instanceof AppError);
  assert.equal((err as AppError).code, "MFA_REQUIRED");
  assert.equal((err as AppError).status, 403);
});

test("permiso sensible + mfaEnforced=true + mfaVerified=true → pasa", async () => {
  const err = await runWithTenancyContext(
    { tenantId: "t1", userId: "u1", permissions: ["settings.manage"], mfaEnforced: true, mfaVerified: true },
    () => runMiddleware("settings.manage"),
  );
  assert.equal(err, undefined);
});

test("contexto sintético sin mfaEnforced/mfaVerified (scheduler/agentes) nunca activa el gate", async () => {
  const err = await runWithTenancyContext(
    { tenantId: "t1", userId: "u1", permissions: ["settings.manage"] },
    () => runMiddleware("settings.manage"),
  );
  assert.equal(err, undefined);
});

test("falta el permiso de base → 403 FORBIDDEN, nunca llega a evaluar MFA", async () => {
  const err = await runWithTenancyContext(
    { tenantId: "t1", userId: "u1", permissions: [], mfaEnforced: true, mfaVerified: false },
    () => runMiddleware("settings.manage"),
  );
  assert.ok(err instanceof AppError);
  assert.equal((err as AppError).code, "FORBIDDEN");
});
