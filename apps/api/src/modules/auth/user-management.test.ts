import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;
const createdUserIds: string[] = [];

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;
});

after(async () => {
  await prisma.auditLog.deleteMany({ where: { entityType: "user", entityId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function adminFetch(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}/api/v1/auth${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-dev-user": "admin@titan.dev", ...init?.headers },
  });
}

test("POST /users/invite sin permiso (Sales) → 403", async () => {
  const res = await fetch(`${baseUrl}/api/v1/auth/users/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dev-user": "sales@titan.dev" },
    body: JSON.stringify({ email: "nope@example.com", roleId: "irrelevant" }),
  });
  assert.equal(res.status, 403);
});

test("POST /users/invite: roleId inválido/de otro tenant → 400, no crea nada", async () => {
  const res = await adminFetch("/users/invite", {
    method: "POST",
    body: JSON.stringify({ email: "f49-invite-badrole@example.com", roleId: "role-does-not-exist" }),
  });
  assert.equal(res.status, 400);
  const found = await prisma.user.findFirst({ where: { email: "f49-invite-badrole@example.com" } });
  assert.equal(found, null);
});

test("POST /users/invite: camino feliz crea un User real PENDING sin clerkId (dev-bypass, sin llamar a Clerk)", async () => {
  const roles = await adminFetch("/roles").then((r) => r.json() as Promise<Array<{ id: string; name: string }>>);
  const recruiterRole = roles.find((r) => r.name === "Recruiter");
  assert.ok(recruiterRole, "seed debe tener un rol Recruiter");

  const res = await adminFetch("/users/invite", {
    method: "POST",
    body: JSON.stringify({ email: "f49-invite-real@example.com", roleId: recruiterRole!.id }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { userId: string };
  createdUserIds.push(body.userId);

  const user = await prisma.user.findUnique({ where: { id: body.userId } });
  assert.equal(user?.email, "f49-invite-real@example.com");
  assert.equal(user?.invitationStatus, "PENDING");
  assert.equal(user?.clerkId, null);
  assert.equal(user?.isActive, true);

  const auditRow = await prisma.auditLog.findFirst({ where: { entityId: body.userId, action: "auth.invitation_sent" } });
  assert.ok(auditRow, "debe quedar un AuditLog real de auth.invitation_sent");
  assert.equal(auditRow?.actorType, "HUMAN");
  assert.ok(auditRow?.actorId); // el User.id real de admin@titan.dev, nunca vacío
});

test("POST /users/invite: email duplicado en el mismo tenant → 400", async () => {
  const roles = await adminFetch("/roles").then((r) => r.json() as Promise<Array<{ id: string; name: string }>>);
  const roleId = roles[0]!.id;

  const first = await adminFetch("/users/invite", {
    method: "POST",
    body: JSON.stringify({ email: "f49-invite-dup@example.com", roleId }),
  });
  assert.equal(first.status, 201);
  const { userId } = (await first.json()) as { userId: string };
  createdUserIds.push(userId);

  const second = await adminFetch("/users/invite", {
    method: "POST",
    body: JSON.stringify({ email: "f49-invite-dup@example.com", roleId }),
  });
  assert.equal(second.status, 400);
});

test("PATCH /users/:id/status desactiva y reactiva un User real", async () => {
  const roles = await adminFetch("/roles").then((r) => r.json() as Promise<Array<{ id: string; name: string }>>);
  const roleId = roles[0]!.id;
  const invited = await adminFetch("/users/invite", {
    method: "POST",
    body: JSON.stringify({ email: "f49-status-toggle@example.com", roleId }),
  }).then((r) => r.json() as Promise<{ userId: string }>);
  createdUserIds.push(invited.userId);

  const disable = await adminFetch(`/users/${invited.userId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(disable.status, 204);
  let user = await prisma.user.findUnique({ where: { id: invited.userId } });
  assert.equal(user?.isActive, false);
  assert.ok(await prisma.auditLog.findFirst({ where: { entityId: invited.userId, action: "auth.user_disabled" } }));

  const enable = await adminFetch(`/users/${invited.userId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ isActive: true }),
  });
  assert.equal(enable.status, 204);
  user = await prisma.user.findUnique({ where: { id: invited.userId } });
  assert.equal(user?.isActive, true);
  assert.ok(await prisma.auditLog.findFirst({ where: { entityId: invited.userId, action: "auth.user_enabled" } }));
});

test("PATCH /users/:id/role cambia el rol real; roleId de otro tenant se rechaza", async () => {
  const roles = await adminFetch("/roles").then((r) => r.json() as Promise<Array<{ id: string; name: string }>>);
  const roleA = roles.find((r) => r.name === "Sales")!;
  const roleB = roles.find((r) => r.name === "Compliance")!;

  const invited = await adminFetch("/users/invite", {
    method: "POST",
    body: JSON.stringify({ email: "f49-role-change@example.com", roleId: roleA.id }),
  }).then((r) => r.json() as Promise<{ userId: string }>);
  createdUserIds.push(invited.userId);

  const changed = await adminFetch(`/users/${invited.userId}/role`, {
    method: "PATCH",
    body: JSON.stringify({ roleId: roleB.id }),
  });
  assert.equal(changed.status, 204);
  const user = await prisma.user.findUnique({ where: { id: invited.userId } });
  assert.equal(user?.roleId, roleB.id);

  const auditRow = await prisma.auditLog.findFirst({ where: { entityId: invited.userId, action: "auth.role_changed" } });
  assert.ok(auditRow);
  assert.deepEqual(auditRow?.before, { roleId: roleA.id, roleName: roleA.name });
  assert.deepEqual(auditRow?.after, { roleId: roleB.id, roleName: roleB.name });

  const rejected = await adminFetch(`/users/${invited.userId}/role`, {
    method: "PATCH",
    body: JSON.stringify({ roleId: "role-does-not-exist" }),
  });
  assert.equal(rejected.status, 400);
});

test("POST /users/:id/revoke-sessions en dev-bypass (AUTH_MODE≠clerk) es un no-op seguro, nunca falla", async () => {
  const roles = await adminFetch("/roles").then((r) => r.json() as Promise<Array<{ id: string; name: string }>>);
  const invited = await adminFetch("/users/invite", {
    method: "POST",
    body: JSON.stringify({ email: "f49-revoke-sessions@example.com", roleId: roles[0]!.id }),
  }).then((r) => r.json() as Promise<{ userId: string }>);
  createdUserIds.push(invited.userId);

  const res = await adminFetch(`/users/${invited.userId}/revoke-sessions`, { method: "POST" });
  assert.equal(res.status, 204);
});

test("GET /users/:id devuelve el detalle real (lastLoginAt/mfaEnabled/invitationStatus/activeSessionCount)", async () => {
  const roles = await adminFetch("/roles").then((r) => r.json() as Promise<Array<{ id: string; name: string }>>);
  const invited = await adminFetch("/users/invite", {
    method: "POST",
    body: JSON.stringify({ email: "f49-user-detail@example.com", roleId: roles[0]!.id }),
  }).then((r) => r.json() as Promise<{ userId: string }>);
  createdUserIds.push(invited.userId);

  const res = await adminFetch(`/users/${invited.userId}`);
  assert.equal(res.status, 200);
  const detail = (await res.json()) as {
    invitationStatus: string;
    mfaEnabled: boolean;
    lastLoginAt: string | null;
    activeSessionCount: number;
  };
  assert.equal(detail.invitationStatus, "PENDING");
  assert.equal(detail.mfaEnabled, false);
  assert.equal(detail.lastLoginAt, null);
  assert.equal(detail.activeSessionCount, 0); // dev-bypass, sin Clerk: siempre 0, nunca inventado
});
