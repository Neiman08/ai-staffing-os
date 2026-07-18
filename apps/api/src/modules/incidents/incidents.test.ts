import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const CEO_HEADERS = { "x-dev-user": "ceo@titan.dev", "content-type": "application/json" };
const OPERATIONS_HEADERS = { "x-dev-user": "operations@titan.dev", "content-type": "application/json" };
const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };

const REAL_COMPANY_ID = "company-01";
const REAL_CATEGORY_ID = "category-general-labor";

const createdCandidateIds: string[] = [];
const createdWorkerIds: string[] = [];
const createdIncidentIds: string[] = [];

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
  if (createdIncidentIds.length > 0) {
    await prisma.operationalIncident.deleteMany({ where: { id: { in: createdIncidentIds } } });
  }
  if (createdWorkerIds.length > 0) {
    await prisma.worker.deleteMany({ where: { id: { in: createdWorkerIds } } });
  }
  if (createdCandidateIds.length > 0) {
    await prisma.candidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createRealWorker(): Promise<string> {
  const candRes = await fetch(`${baseUrl}/api/v1/candidates`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({
      firstName: "F9.10test",
      lastName: `Worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `f910test.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`,
      categoryIds: [REAL_CATEGORY_ID],
    }),
  });
  const candidate = (await candRes.json()) as { id: string };
  createdCandidateIds.push(candidate.id);

  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "SCREENING" }),
  });
  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "QUALIFIED" }),
  });

  const convertRes = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/convert-to-worker`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ employmentType: "W2", defaultPayRate: 20 }),
  });
  const worker = (await convertRes.json()) as { worker: { id: string } };
  createdWorkerIds.push(worker.worker.id);
  return worker.worker.id;
}

async function createIncident(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/v1/incidents`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      type: "OTHER",
      description: "Test incident",
      occurredAt: new Date().toISOString(),
      ...overrides,
    }),
  });
  const body = (await res.json()) as { id: string };
  if (res.status === 201) createdIncidentIds.push(body.id);
  return { res, body };
}

// ---- Creación ----

test("POST /incidents as sales@titan.dev returns 403 (no incidents.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/incidents`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ type: "OTHER", description: "x", occurredAt: new Date().toISOString() }),
  });
  assert.equal(res.status, 403);
});

test("POST /incidents rejects a type other than OTHER with no relation at all -- never a contextless incident", async () => {
  const res = await fetch(`${baseUrl}/api/v1/incidents`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ type: "SAFETY", description: "Something happened", occurredAt: new Date().toISOString() }),
  });
  assert.equal(res.status, 400);
});

test("POST /incidents with type OTHER and no relation at all succeeds", async () => {
  const { res, body } = (await createIncident()) as unknown as { res: Response; body: { status: string; type: string } };
  assert.equal(res.status, 201);
  assert.equal(body.status, "OPEN");
  assert.equal(body.type, "OTHER");
});

test("POST /incidents against a real Company links it correctly (CLIENT_COMPLAINT)", async () => {
  const { res, body } = (await createIncident({ type: "CLIENT_COMPLAINT", companyId: REAL_COMPANY_ID })) as unknown as {
    res: Response;
    body: { companyId: string; companyName: string | null };
  };
  assert.equal(res.status, 201);
  assert.equal(body.companyId, REAL_COMPANY_ID);
  assert.ok(body.companyName);
});

test("POST /incidents rejects an unknown workerId", async () => {
  const res = await fetch(`${baseUrl}/api/v1/incidents`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ type: "NO_SHOW", description: "x", occurredAt: new Date().toISOString(), workerId: "worker-does-not-exist" }),
  });
  assert.equal(res.status, 400);
});

test("POST /incidents against a real Worker creates it linked, with reportedById from the real dev-bypass session", async () => {
  const workerId = await createRealWorker();
  const { res, body } = (await createIncident({ type: "NO_SHOW", workerId })) as unknown as {
    res: Response;
    body: { id: string; workerId: string; workerName: string | null };
  };
  assert.equal(res.status, 201);
  assert.equal(body.workerId, workerId);
  assert.ok(body.workerName);

  const row = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: body.id } });
  assert.ok(row.reportedById, "reportedById must come from the real tenancy context, never the body");
});

// ---- Tenancy ----

test("an Incident created under one tenant is invisible under another tenant context", async () => {
  const { body } = await createIncident();
  const incident = body as { id: string };

  await runWithTenancyContext({ tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] }, async () => {
    const found = await prisma.operationalIncident.findFirst({ where: { id: incident.id, tenantId: "tenant-does-not-exist" } });
    assert.equal(found, null);
  });
});

// ---- Listado ----

test("GET /incidents supports filtering by type and status", async () => {
  await createIncident({ type: "OTHER" });

  const res = await fetch(`${baseUrl}/api/v1/incidents?type=OTHER&status=OPEN`, { headers: OPERATIONS_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ type: string; status: string }> };
  assert.ok(body.items.length > 0);
  for (const item of body.items) {
    assert.equal(item.type, "OTHER");
    assert.equal(item.status, "OPEN");
  }
});

test("GET /incidents/:id returns the real persisted record", async () => {
  const { body } = await createIncident();
  const incident = body as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/incidents/${incident.id}`, { headers: OPERATIONS_HEADERS });
  assert.equal(res.status, 200);
  const detail = (await res.json()) as { id: string };
  assert.equal(detail.id, incident.id);
});

// ---- Edición ----

test("PATCH /incidents/:id edits description/occurredAt but never type/status", async () => {
  const { body } = await createIncident();
  const incident = body as { id: string };

  const patchRes = await fetch(`${baseUrl}/api/v1/incidents/${incident.id}`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ description: "Updated description", type: "SAFETY", status: "CLOSED" }),
  });
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()) as { description: string; type: string; status: string };
  assert.equal(updated.description, "Updated description");
  assert.equal(updated.type, "OTHER", "type must never change via the generic PATCH");
  assert.equal(updated.status, "OPEN", "status must never change via the generic PATCH");
});

// ---- Transiciones de estado ----

test("PATCH /incidents/:id/status: invalid transition OPEN -> CLOSED (skipping resolution) is rejected", async () => {
  const { body } = await createIncident();
  const incident = body as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/incidents/${incident.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "CLOSED" }),
  });
  assert.equal(res.status, 400);
});

test("PATCH /incidents/:id/status: RESOLVED requires resolutionNotes", async () => {
  const { body } = await createIncident();
  const incident = body as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/incidents/${incident.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "RESOLVED" }),
  });
  assert.equal(res.status, 400);
});

test("full path OPEN -> UNDER_REVIEW -> ACTION_REQUIRED -> RESOLVED -> CLOSED succeeds and records resolvedById/resolvedAt", async () => {
  const { body } = await createIncident();
  const incident = body as { id: string };

  for (const status of ["UNDER_REVIEW", "ACTION_REQUIRED"]) {
    const res = await fetch(`${baseUrl}/api/v1/incidents/${incident.id}/status`, {
      method: "PATCH",
      headers: OPERATIONS_HEADERS,
      body: JSON.stringify({ status }),
    });
    assert.equal(res.status, 200, `expected 200 moving to ${status}`);
  }

  const resolveRes = await fetch(`${baseUrl}/api/v1/incidents/${incident.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "RESOLVED", resolutionNotes: "Talked to the worker, resolved verbally." }),
  });
  assert.equal(resolveRes.status, 200);

  const closeRes = await fetch(`${baseUrl}/api/v1/incidents/${incident.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "CLOSED" }),
  });
  assert.equal(closeRes.status, 200);

  const final = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident.id } });
  assert.equal(final.status, "CLOSED");
  assert.ok(final.resolvedById);
  assert.ok(final.resolvedAt);
  assert.equal(final.resolutionNotes, "Talked to the worker, resolved verbally.");
});

test("RESOLVED reopened to UNDER_REVIEW clears resolvedById/resolvedAt/resolutionNotes -- never a stale resolution", async () => {
  const { body } = await createIncident();
  const incident = body as { id: string };

  await fetch(`${baseUrl}/api/v1/incidents/${incident.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "RESOLVED", resolutionNotes: "First resolution attempt." }),
  });

  const reopenRes = await fetch(`${baseUrl}/api/v1/incidents/${incident.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "UNDER_REVIEW" }),
  });
  assert.equal(reopenRes.status, 200);

  const reopened = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident.id } });
  assert.equal(reopened.resolvedById, null);
  assert.equal(reopened.resolvedAt, null);
  assert.equal(reopened.resolutionNotes, null);
});

test("a CLOSED incident cannot be edited via the generic PATCH -- must reopen via status first", async () => {
  const { body } = await createIncident();
  const incident = body as { id: string };

  await fetch(`${baseUrl}/api/v1/incidents/${incident.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "RESOLVED", resolutionNotes: "Done." }),
  });
  await fetch(`${baseUrl}/api/v1/incidents/${incident.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "CLOSED" }),
  });

  const res = await fetch(`${baseUrl}/api/v1/incidents/${incident.id}`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ description: "Trying to edit a closed incident" }),
  });
  assert.equal(res.status, 400);
});

// ---- AuditLog ----

test("creating an Incident and changing its status write AuditLog entries", async () => {
  const { body } = await createIncident();
  const incident = body as { id: string };

  await fetch(`${baseUrl}/api/v1/incidents/${incident.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "UNDER_REVIEW" }),
  });

  const createdAudit = await prisma.auditLog.findFirst({ where: { action: "incident.created", entityType: "operationalIncident", entityId: incident.id } });
  const statusAudit = await prisma.auditLog.findFirst({ where: { action: "incident.status_changed", entityType: "operationalIncident", entityId: incident.id } });
  assert.ok(createdAudit);
  assert.ok(statusAudit);
});
