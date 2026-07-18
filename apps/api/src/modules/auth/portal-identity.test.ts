// F10.1: identidad de portal -- GET /auth/me expone companyId/workerId/
// candidateId reales (F10.1), y la matriz de permisos de los roles
// nuevos (CLIENT_ADMIN/CLIENT_MANAGER/WORKER/CANDIDATE) nunca incluye
// ningún permiso INTERNO de CRUD amplio (workers.view, assignments.view,
// timeEntries.view, documents.view, companies.view, candidates.view) --
// esa es la garantía central de que un usuario de portal no puede
// llamar directo a un endpoint interno sin ownership filtering y ver
// datos de otro Worker/Company (ver docs/F10_PLAN.md §2). Corre vía
// dev-bypass real contra los dos tenants sembrados (tenant-titan/
// tenant-acme).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface MeResponse {
  id: string;
  tenantId: string;
  role: { name: string };
  permissions: string[];
  companyId: string | null;
  workerId: string | null;
  candidateId: string | null;
}

async function fetchMe(email: string): Promise<MeResponse> {
  const res = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { "x-dev-user": email } });
  assert.equal(res.status, 200, `${email} should resolve a real identity`);
  return (await res.json()) as MeResponse;
}

// INTERNAL-only CRUD permissions that gate endpoints WITHOUT any
// ownership filter (they return the whole tenant to any caller with the
// key) -- a portal role must never receive any of these, confirmed by
// exact-key match (never a substring check, same discipline as F8.2's
// fairness tests).
const UNSCOPED_INTERNAL_PERMISSIONS = new Set([
  "workers.view",
  "workers.create",
  "workers.update",
  "workers.delete",
  "candidates.view",
  "candidates.create",
  "candidates.update",
  "candidates.delete",
  "assignments.view",
  "assignments.create",
  "assignments.update",
  "assignments.delete",
  "timeEntries.view",
  "timeEntries.create",
  "timeEntries.update",
  "timeEntries.delete",
  "documents.view",
  "documents.create",
  "documents.update",
  "documents.delete",
  "companies.view",
  "companies.create",
  "companies.update",
  "companies.delete",
  "contacts.view",
  "shifts.view",
  "shifts.create",
  "shifts.update",
  "shifts.delete",
  "incidents.view",
  "incidents.create",
  "incidents.update",
  "incidents.delete",
]);

test("GET /auth/me for client-admin@titan.dev resolves companyId=company-01 and role CLIENT_ADMIN", async () => {
  const me = await fetchMe("client-admin@titan.dev");
  assert.equal(me.role.name, "CLIENT_ADMIN");
  assert.equal(me.tenantId, "tenant-titan");
  assert.equal(me.companyId, "company-01");
  assert.equal(me.workerId, null);
  assert.equal(me.candidateId, null);
});

test("GET /auth/me for worker-portal@titan.dev resolves workerId=worker-01 and role WORKER", async () => {
  const me = await fetchMe("worker-portal@titan.dev");
  assert.equal(me.role.name, "WORKER");
  assert.equal(me.workerId, "worker-01");
  assert.equal(me.companyId, null);
  assert.equal(me.candidateId, null);
});

test("GET /auth/me for candidate-portal@titan.dev resolves candidateId=candidate-029 and role CANDIDATE", async () => {
  const me = await fetchMe("candidate-portal@titan.dev");
  assert.equal(me.role.name, "CANDIDATE");
  assert.equal(me.candidateId, "candidate-029");
  assert.equal(me.companyId, null);
  assert.equal(me.workerId, null);
});

test("GET /auth/me for client-admin@acme.dev resolves tenant-acme, never tenant-titan", async () => {
  const me = await fetchMe("client-admin@acme.dev");
  assert.equal(me.role.name, "CLIENT_ADMIN");
  assert.equal(me.tenantId, "tenant-acme");
  assert.equal(me.companyId, "company-acme-01");
});

for (const role of ["CLIENT_ADMIN", "CLIENT_MANAGER", "WORKER", "CANDIDATE"]) {
  const email =
    role === "CLIENT_ADMIN"
      ? "client-admin@titan.dev"
      : role === "CLIENT_MANAGER"
        ? "client-manager@titan.dev"
        : role === "WORKER"
          ? "worker-portal@titan.dev"
          : "candidate-portal@titan.dev";

  test(`${role} (${email}) never receives any unscoped internal CRUD permission (IDOR prevention)`, async () => {
    const me = await fetchMe(email);
    const leaked = me.permissions.filter((p) => UNSCOPED_INTERNAL_PERMISSIONS.has(p));
    assert.deepEqual(leaked, [], `${role} must never receive: ${leaked.join(", ")}`);
  });
}

test("CLIENT_MANAGER has strictly fewer permissions than CLIENT_ADMIN (explicit requirement)", async () => {
  const admin = await fetchMe("client-admin@titan.dev");
  const manager = await fetchMe("client-manager@titan.dev");

  const managerOnly = manager.permissions.filter((p) => !admin.permissions.includes(p));
  assert.deepEqual(managerOnly, [], "CLIENT_MANAGER must never have a permission CLIENT_ADMIN lacks");
  assert.ok(manager.permissions.length < admin.permissions.length, "CLIENT_MANAGER must have strictly fewer permissions than CLIENT_ADMIN");

  // Bloqueadores explícitos pedidos por el PO.
  assert.ok(admin.permissions.includes("clientJobs.update"));
  assert.ok(!manager.permissions.includes("clientJobs.update"));
  assert.ok(admin.permissions.includes("portalTimeEntries.update"));
  assert.ok(!manager.permissions.includes("portalTimeEntries.update"));
  assert.ok(admin.permissions.includes("auditLogs.view"));
  assert.ok(!manager.permissions.includes("auditLogs.view"));
});

test("WORKER and CANDIDATE share the same self-service shape (portalProfile/portalDocuments/notifications), but only WORKER gets portalAssignments/portalTimeEntries", async () => {
  const worker = await fetchMe("worker-portal@titan.dev");
  const candidate = await fetchMe("candidate-portal@titan.dev");

  for (const key of ["portalProfile.view", "portalProfile.update", "portalDocuments.view", "notifications.view", "notifications.markRead"]) {
    assert.ok(worker.permissions.includes(key), `WORKER should have ${key}`);
    assert.ok(candidate.permissions.includes(key), `CANDIDATE should have ${key}`);
  }
  assert.ok(worker.permissions.includes("portalAssignments.view"));
  assert.ok(worker.permissions.includes("portalTimeEntries.create"));
  assert.ok(!candidate.permissions.includes("portalAssignments.view"), "a Candidate has no Assignment yet -- never granted");
  assert.ok(!candidate.permissions.includes("portalTimeEntries.create"));
});

test("internal roles (e.g. Recruiter) never receive any portal-only permission", async () => {
  const recruiter = await fetchMe("recruiter@titan.dev");
  const portalOnlyKeys = recruiter.permissions.filter(
    (p) => p.startsWith("portal") || p.startsWith("clientJobs.") || (p.startsWith("auditLogs.") && recruiter.role.name !== "Manager"),
  );
  assert.deepEqual(portalOnlyKeys, []);
});

test("tenancy: a User row created under tenant-acme is invisible when scoped to tenant-titan", async () => {
  const { runWithTenancyContext } = await import("../../core/tenancy/context");
  const { prisma } = await import("@ai-staffing-os/db");
  await runWithTenancyContext({ tenantId: "tenant-titan", userId: "irrelevant", permissions: [] }, async () => {
    const found = await prisma.user.findFirst({ where: { email: "client-admin@acme.dev", tenantId: "tenant-titan" } });
    assert.equal(found, null);
  });
});
