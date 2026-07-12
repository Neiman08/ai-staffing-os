import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { deriveMfaVerified, bumpLastLoginAndMaybeAudit } from "./clerk.provider";

test("deriveMfaVerified: sin sessionClaims → false", () => {
  assert.equal(deriveMfaVerified(undefined), false);
  assert.equal(deriveMfaVerified(null), false);
});

test("deriveMfaVerified: sin claim fva → false (nunca asume verificado)", () => {
  assert.equal(deriveMfaVerified({}), false);
});

test("deriveMfaVerified: fva con segundo factor en -1 (nunca verificado en esta sesión) → false", () => {
  assert.equal(deriveMfaVerified({ fva: [5, -1] }), false);
});

test("deriveMfaVerified: fva con segundo factor verificado (edad >= 0) → true", () => {
  assert.equal(deriveMfaVerified({ fva: [5, 0] }), true);
  assert.equal(deriveMfaVerified({ fva: [5, 12] }), true);
});

test("deriveMfaVerified: fva mal formado (no es array de 2) → false", () => {
  assert.equal(deriveMfaVerified({ fva: "not-an-array" }), false);
  assert.equal(deriveMfaVerified({ fva: [5] }), false);
});

let tenantId: string;
let userId: string;

before(async () => {
  const tenant = await prisma.tenant.create({ data: { name: "F4.9 login-audit test", slug: "f49-login-audit-test" } });
  tenantId = tenant.id;
  const role = await prisma.role.create({ data: { tenantId, name: "F4.9 login-audit role" } });
  const user = await prisma.user.create({
    data: { tenantId, roleId: role.id, email: "f49-login-audit@example.com", firstName: "Login", lastName: "Audit" },
  });
  userId = user.id;
});

after(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { tenantId } });
  await prisma.role.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
});

test("bumpLastLoginAndMaybeAudit: primer login (lastLoginAt null) → audita auth.login y actualiza lastLoginAt", async () => {
  await bumpLastLoginAndMaybeAudit(userId, tenantId);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  assert.ok(user?.lastLoginAt);

  const auditRow = await prisma.auditLog.findFirst({ where: { entityId: userId, action: "auth.login" } });
  assert.ok(auditRow, "el primer login siempre se audita");
});

test("bumpLastLoginAndMaybeAudit: segundo llamado inmediato (misma sesión activa) NO duplica el auth.login", async () => {
  const before = await prisma.auditLog.count({ where: { entityId: userId, action: "auth.login" } });
  await bumpLastLoginAndMaybeAudit(userId, tenantId);
  const after = await prisma.auditLog.count({ where: { entityId: userId, action: "auth.login" } });
  assert.equal(after, before, "dentro de la ventana de debounce, no es un login nuevo");
});

test("bumpLastLoginAndMaybeAudit: lastLoginAt viejo (fuera de la ventana) SÍ audita de nuevo", async () => {
  const old = new Date(Date.now() - 40 * 60 * 1000); // 40 min atrás > debounce de 30 min
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: old } });

  const before = await prisma.auditLog.count({ where: { entityId: userId, action: "auth.login" } });
  await bumpLastLoginAndMaybeAudit(userId, tenantId);
  const after = await prisma.auditLog.count({ where: { entityId: userId, action: "auth.login" } });
  assert.equal(after, before + 1);
});
