import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createApp } from "../../app";
import { getWorkerDetail } from "./service";

let server: Server;
let baseUrl: string;

const CEO_HEADERS = { "x-dev-user": "ceo@titan.dev", "content-type": "application/json" };
const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };
const OPERATIONS_HEADERS = { "x-dev-user": "operations@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };

const REAL_CATEGORY_ID = "category-general-labor";
const REAL_FORKLIFT_CATEGORY_ID = "category-forklift-operator";
const REAL_COMPANY_ID = "company-01";

const createdCandidateIds: string[] = [];
const createdWorkerIds: string[] = [];
const createdJobOrderIds: string[] = [];

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
  // F9.1: WorkerOnboarding tiene FKs ON DELETE RESTRICT hacia Candidate/
  // JobOrder, así que debe borrarse primero (mismo patrón que
  // CandidateQualification en F8.5).
  if (createdCandidateIds.length > 0 || createdJobOrderIds.length > 0) {
    await prisma.workerOnboarding.deleteMany({
      where: { OR: [{ candidateId: { in: createdCandidateIds } }, { jobOrderId: { in: createdJobOrderIds } }] },
    });
    await prisma.placementReadiness.deleteMany({
      where: { OR: [{ candidateId: { in: createdCandidateIds } }, { jobOrderId: { in: createdJobOrderIds } }] },
    });
  }
  if (createdWorkerIds.length > 0) {
    await prisma.worker.deleteMany({ where: { id: { in: createdWorkerIds } } });
  }
  if (createdCandidateIds.length > 0) {
    await prisma.candidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  }
  if (createdJobOrderIds.length > 0) {
    await prisma.jobOrder.deleteMany({ where: { id: { in: createdJobOrderIds } } });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createValidJobOrder(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      companyId: REAL_COMPANY_ID,
      categoryId: REAL_FORKLIFT_CATEGORY_ID,
      title: "F9.1 test — Forklift Operator",
      workersNeeded: 2,
      billRate: 30,
      payRate: 20,
      startDate: new Date().toISOString(),
      requirements: ["forklift_cert"],
      ...overrides,
    }),
  });
  const body = (await res.json()) as { id: string };
  if (res.status === 201) createdJobOrderIds.push(body.id);
  return body;
}

/** F9.1: onboarding exige una PlacementReadiness YA evaluada -- se genera vía el endpoint real de F8.10, nunca un fixture inventado. */
async function ensurePlacementReadiness(candidateId: string, jobOrderId: string) {
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement-readiness/${jobOrderId}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  return (await res.json()) as { readinessStatus: string };
}

// F5.3: crea un Candidate real y lo mueve hasta QUALIFIED, listo para
// convertir — mismo fixture pattern que talent.test.ts.
async function createQualifiedCandidate(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/v1/candidates`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({
      firstName: "F5.3test",
      lastName: `Candidate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `f53test.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`,
      city: "Denver",
      state: "CO",
      categoryIds: [REAL_CATEGORY_ID],
      ...overrides,
    }),
  });
  const body = (await res.json()) as { id: string };
  createdCandidateIds.push(body.id);

  await fetch(`${baseUrl}/api/v1/candidates/${body.id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "SCREENING" }),
  });
  await fetch(`${baseUrl}/api/v1/candidates/${body.id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "QUALIFIED" }),
  });

  return body.id;
}

async function createRealWorker(overrides: Record<string, unknown> = {}) {
  const candidateId = await createQualifiedCandidate();
  const res = await fetch(`${baseUrl}/api/v1/workers`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ candidateId, employmentType: "W2", defaultPayRate: 18, ...overrides }),
  });
  const body = (await res.json()) as { id: string };
  if (res.status === 201) createdWorkerIds.push(body.id);
  return { res, body, candidateId };
}

// ---- GET /workers (list) ----

test("GET /workers as sales@titan.dev returns 403 (no workers.view)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/workers`, { headers: SALES_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /workers as recruiter@titan.dev returns 200 with real seeded data", async () => {
  const res = await fetch(`${baseUrl}/api/v1/workers?limit=5`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ id: string; candidateName: string }> };
  assert.ok(body.items.length > 0);
  assert.ok(body.items[0]!.candidateName.length > 0);
});

test("GET /workers supports filtering by status", async () => {
  const res = await fetch(`${baseUrl}/api/v1/workers?status=ASSIGNED&limit=50`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ status: string }> };
  for (const item of body.items) {
    assert.equal(item.status, "ASSIGNED");
  }
});

test("GET /workers supports filtering by employmentType and complianceStatus", async () => {
  const res = await fetch(`${baseUrl}/api/v1/workers?employmentType=W2&complianceStatus=COMPLIANT&limit=50`, {
    headers: RECRUITER_HEADERS,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ employmentType: string; complianceStatus: string }> };
  for (const item of body.items) {
    assert.equal(item.employmentType, "W2");
    assert.equal(item.complianceStatus, "COMPLIANT");
  }
});

test("GET /workers supports search by candidate name", async () => {
  const { candidateId } = await createRealWorker();
  const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });

  const res = await fetch(`${baseUrl}/api/v1/workers?search=${encodeURIComponent(candidate.lastName)}`, {
    headers: RECRUITER_HEADERS,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ candidateId: string }> };
  assert.ok(body.items.some((i) => i.candidateId === candidateId));
});

// ---- POST /workers (creación) ----

test("POST /workers as recruiter@titan.dev returns 403 (has candidates.update but not workers.create)", async () => {
  const candidateId = await createQualifiedCandidate();
  const res = await fetch(`${baseUrl}/api/v1/workers`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ candidateId, employmentType: "W2", defaultPayRate: 18 }),
  });
  assert.equal(res.status, 403);
});

test("POST /workers as operations@titan.dev returns 403 (has workers.update but not workers.create)", async () => {
  const candidateId = await createQualifiedCandidate();
  const res = await fetch(`${baseUrl}/api/v1/workers`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ candidateId, employmentType: "W2", defaultPayRate: 18 }),
  });
  assert.equal(res.status, 403);
});

test("POST /workers as ceo@titan.dev creates a real Worker from a QUALIFIED Candidate", async () => {
  const { res, body, candidateId } = await createRealWorker({ employmentType: "C1099", defaultPayRate: 24.5 });
  assert.equal(res.status, 201);
  const worker = body as { id: string; employmentType: string; defaultPayRate: string; status: string; complianceStatus: string };
  assert.equal(worker.employmentType, "C1099");
  assert.equal(Number(worker.defaultPayRate), 24.5);
  assert.equal(worker.status, "AVAILABLE");
  assert.equal(worker.complianceStatus, "PENDING");

  const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });
  assert.equal(candidate.status, "PLACED", "the Candidate must be moved to PLACED as a side effect");
});

test("POST /workers rejects a Candidate that is not QUALIFIED", async () => {
  const res1 = await fetch(`${baseUrl}/api/v1/candidates`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({
      firstName: "F5.3test",
      lastName: `NotQualified-${Date.now()}`,
      email: `f53.notqualified.${Date.now()}@example.com`,
    }),
  });
  const candidate = (await res1.json()) as { id: string };
  createdCandidateIds.push(candidate.id);

  const res = await fetch(`${baseUrl}/api/v1/workers`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ candidateId: candidate.id, employmentType: "W2", defaultPayRate: 18 }),
  });
  assert.equal(res.status, 400);
});

test("POST /workers rejects an unknown candidateId", async () => {
  const res = await fetch(`${baseUrl}/api/v1/workers`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ candidateId: "candidate-does-not-exist", employmentType: "W2", defaultPayRate: 18 }),
  });
  assert.equal(res.status, 400);
});

test("POST /workers returns 409 for a Candidate that already has a Worker (not idempotent like convert-to-worker)", async () => {
  const { candidateId } = await createRealWorker();
  const res = await fetch(`${baseUrl}/api/v1/workers`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ candidateId, employmentType: "W2", defaultPayRate: 18 }),
  });
  assert.equal(res.status, 409);

  const workerCount = await prisma.worker.count({ where: { candidateId } });
  assert.equal(workerCount, 1, "must never create a second Worker for the same Candidate");
});

test("POST /workers rejects defaultPayRate <= 0", async () => {
  const candidateId = await createQualifiedCandidate();
  const res = await fetch(`${baseUrl}/api/v1/workers`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ candidateId, employmentType: "W2", defaultPayRate: 0 }),
  });
  assert.equal(res.status, 400);
});

test("the body cannot set status/complianceStatus/tenantId on creation — those fields simply don't exist in the input contract", async () => {
  const { res, body } = await createRealWorker({ status: "TERMINATED", complianceStatus: "BLOCKED", tenantId: "other" });
  assert.equal(res.status, 201);
  const worker = body as unknown as { status: string; complianceStatus: string };
  assert.equal(worker.status, "AVAILABLE");
  assert.equal(worker.complianceStatus, "PENDING");
});

// ---- Tenancy ----

test("a Worker created under one tenant is invisible/not-found under another tenant context", async () => {
  const { body } = await createRealWorker();
  const worker = body as { id: string };

  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      await assert.rejects(() => getWorkerDetail(worker.id), /Worker not found/);
    },
  );
});

// ---- GET /workers/:id (detalle) ----

test("GET /workers/:id for a nonexistent id returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/v1/workers/does-not-exist`, { headers: CEO_HEADERS });
  assert.equal(res.status, 404);
});

test("GET /workers/:id returns the full detail: contact/location/languages/categories from the Candidate, never duplicated", async () => {
  const { body } = await createRealWorker();
  const worker = body as { id: string };

  const detailRes = await fetch(`${baseUrl}/api/v1/workers/${worker.id}`, { headers: CEO_HEADERS });
  assert.equal(detailRes.status, 200);
  const detail = (await detailRes.json()) as {
    city: string | null;
    state: string | null;
    categoryNames: string[];
    email: string | null;
    languages: string[];
    updatedAt: string;
  };
  assert.equal(detail.city, "Denver");
  assert.equal(detail.state, "CO");
  assert.deepEqual(detail.categoryNames, ["General Labor"]);
  assert.ok(detail.email);
  assert.ok(detail.updatedAt);
});

// ---- PATCH /workers/:id (edición) ----

test("PATCH /workers/:id edits allowed fields", async () => {
  const { body } = await createRealWorker();
  const worker = body as { id: string };

  const patchRes = await fetch(`${baseUrl}/api/v1/workers/${worker.id}`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ defaultPayRate: 30, employmentType: "C1099" }),
  });
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()) as { defaultPayRate: string; employmentType: string };
  assert.equal(Number(updated.defaultPayRate), 30);
  assert.equal(updated.employmentType, "C1099");
});

test("PATCH /workers/:id silently ignores status/complianceStatus/candidateId — protected fields never change", async () => {
  const { body, candidateId } = await createRealWorker();
  const worker = body as { id: string; status: string; complianceStatus: string };

  const patchRes = await fetch(`${baseUrl}/api/v1/workers/${worker.id}`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ status: "TERMINATED", complianceStatus: "BLOCKED", candidateId: "hijacked" }),
  });
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()) as { status: string; complianceStatus: string; candidateId: string };
  assert.equal(updated.status, "AVAILABLE", "status must never change via the general PATCH");
  assert.equal(updated.complianceStatus, "PENDING", "complianceStatus is Compliance's domain, never editable here");
  assert.equal(updated.candidateId, candidateId, "candidateId must never change");
});

test("PATCH /workers/:id for a nonexistent id returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/v1/workers/does-not-exist`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ defaultPayRate: 25 }),
  });
  assert.equal(res.status, 404);
});

// ---- PATCH /workers/:id/status (transición) ----

test("valid transition AVAILABLE -> ON_LEAVE succeeds and is recorded", async () => {
  const { body } = await createRealWorker();
  const worker = body as { id: string };

  const statusRes = await fetch(`${baseUrl}/api/v1/workers/${worker.id}/status`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ status: "ON_LEAVE" }),
  });
  assert.equal(statusRes.status, 200);
  assert.equal(((await statusRes.json()) as { status: string }).status, "ON_LEAVE");
});

test("invalid transition AVAILABLE -> ASSIGNED is rejected (manual moves to ASSIGNED are never allowed)", async () => {
  const { body } = await createRealWorker();
  const worker = body as { id: string };

  const statusRes = await fetch(`${baseUrl}/api/v1/workers/${worker.id}/status`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ status: "ASSIGNED" }),
  });
  assert.equal(statusRes.status, 400);
});

test("a seeded Worker already ASSIGNED can transition out to ON_LEAVE/TERMINATED, just never back into ASSIGNED manually", async () => {
  const seededAssigned = await prisma.worker.findFirstOrThrow({ where: { status: "ASSIGNED" } });

  const toOnLeave = await fetch(`${baseUrl}/api/v1/workers/${seededAssigned.id}/status`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ status: "ON_LEAVE" }),
  });
  assert.equal(toOnLeave.status, 200);

  const backToAssigned = await fetch(`${baseUrl}/api/v1/workers/${seededAssigned.id}/status`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ status: "ASSIGNED" }),
  });
  assert.equal(backToAssigned.status, 400, "re-entering ASSIGNED manually must never be allowed");

  // Restaura el estado original del seed para no dejar el fixture alterado.
  await prisma.worker.update({ where: { id: seededAssigned.id }, data: { status: "ASSIGNED" } });
});

test("invalid transition TERMINATED -> AVAILABLE is rejected (terminal, no reopening requested)", async () => {
  const { body } = await createRealWorker();
  const worker = body as { id: string };
  await fetch(`${baseUrl}/api/v1/workers/${worker.id}/status`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ status: "TERMINATED" }),
  });

  const reopenRes = await fetch(`${baseUrl}/api/v1/workers/${worker.id}/status`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ status: "AVAILABLE" }),
  });
  assert.equal(reopenRes.status, 400);
});

test("status transition is idempotent: requesting the current status again succeeds without error", async () => {
  const { body } = await createRealWorker();
  const worker = body as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/workers/${worker.id}/status`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ status: "AVAILABLE" }),
  });
  assert.equal(res.status, 200);
});

test("PATCH /workers/:id/status as sales@titan.dev returns 403 (no workers.update)", async () => {
  const { body } = await createRealWorker();
  const worker = body as { id: string };
  const res = await fetch(`${baseUrl}/api/v1/workers/${worker.id}/status`, {
    method: "PATCH",
    headers: SALES_HEADERS,
    body: JSON.stringify({ status: "ON_LEAVE" }),
  });
  assert.equal(res.status, 403);
});

// ---- Activity + AuditLog ----

test("creating a Worker writes Activity + AuditLog on both the Worker and the Candidate sides", async () => {
  const { body, candidateId } = await createRealWorker();
  const worker = body as { id: string };

  const workerActivity = await prisma.activity.findFirst({ where: { entityType: "worker", entityId: worker.id } });
  assert.ok(workerActivity, "Activity row for worker.created must exist");
  const workerAudit = await prisma.auditLog.findFirst({ where: { entityType: "worker", entityId: worker.id, action: "worker.created" } });
  assert.ok(workerAudit, "AuditLog row for worker.created must exist");

  const candidateAudit = await prisma.auditLog.findFirst({
    where: { entityType: "candidate", entityId: candidateId, action: "candidate.converted_to_worker" },
  });
  assert.ok(candidateAudit, "the Candidate side must also be audited as converted_to_worker");
});

test("a status transition writes Activity + AuditLog with before/after", async () => {
  const { body } = await createRealWorker();
  const worker = body as { id: string };

  await fetch(`${baseUrl}/api/v1/workers/${worker.id}/status`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ status: "TERMINATED" }),
  });

  const audit = await prisma.auditLog.findFirst({
    where: { entityType: "worker", entityId: worker.id, action: "worker.status_changed" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(audit);
  assert.deepEqual(audit?.before, { status: "AVAILABLE" });
  assert.deepEqual(audit?.after, { status: "TERMINATED" });
});

test("editing a Worker writes Activity + AuditLog with before/after", async () => {
  const { body } = await createRealWorker({ defaultPayRate: 20 });
  const worker = body as { id: string };

  await fetch(`${baseUrl}/api/v1/workers/${worker.id}`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ defaultPayRate: 35 }),
  });

  const audit = await prisma.auditLog.findFirst({
    where: { entityType: "worker", entityId: worker.id, action: "worker.updated" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(audit);
  assert.equal((audit?.before as { defaultPayRate: string }).defaultPayRate, "20");
  assert.equal((audit?.after as { defaultPayRate: string }).defaultPayRate, "35");
});

// ---------- F9.1: Worker Onboarding ----------

test("POST /candidates/:candidateId/onboarding/:jobOrderId as sales@titan.dev returns 403 (no workers.update)", async () => {
  const candidateId = await createQualifiedCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, {
    method: "POST",
    headers: SALES_HEADERS,
  });
  assert.equal(res.status, 403);
});

test("POST returns 400 when no Placement Readiness was evaluated yet (enforces pipeline order)", async () => {
  const candidateId = await createQualifiedCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  assert.equal(res.status, 400);
});

test("POST starts a real onboarding at INVITED, consumes Placement Readiness as a signal, never changes Candidate.status", async () => {
  const candidateId = await createQualifiedCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { status: string; progress: number; workerId: string | null; requiresApproval: boolean };
  assert.equal(body.status, "INVITED");
  assert.equal(body.progress, 10);
  assert.equal(body.workerId, null, "candidate has no Worker yet -- must never be auto-created");
  assert.equal(body.requiresApproval, true);

  const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });
  assert.equal(candidate.status, "QUALIFIED", "starting onboarding must never change Candidate.status");
});

test("POST is idempotent: re-running returns the same onboarding record, never creates a second one", async () => {
  const candidateId = await createQualifiedCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);

  const first = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  const firstBody = (await first.json()) as { id: string };
  const second = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  const secondBody = (await second.json()) as { id: string };
  assert.equal(firstBody.id, secondBody.id);

  const count = await prisma.workerOnboarding.count({ where: { candidateId, jobOrderId: jobOrder.id } });
  assert.equal(count, 1);
});

test("GET returns 404 before onboarding started, 200 with real data after", async () => {
  const candidateId = await createQualifiedCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  const notYet = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, { headers: OPERATIONS_HEADERS });
  assert.equal(notYet.status, 404);

  await ensurePlacementReadiness(candidateId, jobOrder.id);
  await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, { method: "POST", headers: OPERATIONS_HEADERS });

  const afterRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, { headers: OPERATIONS_HEADERS });
  assert.equal(afterRes.status, 200);
});

test("PATCH status: full path INVITED -> IN_PROGRESS -> DOCUMENTS_PENDING -> COMPLIANCE_REVIEW -> READY succeeds; skipping a stage is rejected with 400", async () => {
  const candidateId = await createQualifiedCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);
  await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, { method: "POST", headers: OPERATIONS_HEADERS });

  for (const status of ["IN_PROGRESS", "DOCUMENTS_PENDING", "COMPLIANCE_REVIEW"]) {
    const res = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}/status`, {
      method: "PATCH",
      headers: OPERATIONS_HEADERS,
      body: JSON.stringify({ status }),
    });
    assert.equal(res.status, 200, `expected 200 moving to ${status}`);
  }

  const skipRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "ACTIVE" }),
  });
  assert.equal(skipRes.status, 400, "COMPLIANCE_REVIEW -> ACTIVE skips READY, must be rejected");
});

test("PATCH status: moving to ACTIVE without an existing Worker is rejected with 400 -- never auto-creates or auto-activates a Worker", async () => {
  const candidateId = await createQualifiedCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);
  await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, { method: "POST", headers: OPERATIONS_HEADERS });

  for (const status of ["IN_PROGRESS", "DOCUMENTS_PENDING", "COMPLIANCE_REVIEW", "READY"]) {
    await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}/status`, {
      method: "PATCH",
      headers: OPERATIONS_HEADERS,
      body: JSON.stringify({ status }),
    });
  }

  const activateRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "ACTIVE" }),
  });
  assert.equal(activateRes.status, 400);

  const worker = await prisma.worker.findUnique({ where: { candidateId } });
  assert.equal(worker, null, "no Worker must ever be created as a side effect of onboarding status changes");
});

test("PATCH status: ACTIVE succeeds once a real Worker exists (converted via the existing, separate F5.2 flow), and workerId gets linked", async () => {
  const candidateId = await createQualifiedCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);
  await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, { method: "POST", headers: OPERATIONS_HEADERS });

  for (const status of ["IN_PROGRESS", "DOCUMENTS_PENDING", "COMPLIANCE_REVIEW", "READY"]) {
    await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}/status`, {
      method: "PATCH",
      headers: OPERATIONS_HEADERS,
      body: JSON.stringify({ status }),
    });
  }

  // Conversión real vía el endpoint YA EXISTENTE de F5.2 -- nunca duplicado acá.
  const convertRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/convert-to-worker`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ employmentType: "W2", defaultPayRate: 20 }),
  });
  const convertBody = (await convertRes.json()) as { worker: { id: string } };
  createdWorkerIds.push(convertBody.worker.id);

  const activateRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "ACTIVE" }),
  });
  assert.equal(activateRes.status, 200);
  const body = (await activateRes.json()) as { status: string; workerId: string | null; progress: number };
  assert.equal(body.status, "ACTIVE");
  assert.equal(body.workerId, convertBody.worker.id);
  assert.equal(body.progress, 100);
});

test("PATCH status: BLOCKED is reachable and reversible to IN_PROGRESS -- never a permanent rejection", async () => {
  const candidateId = await createQualifiedCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);
  await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, { method: "POST", headers: OPERATIONS_HEADERS });

  const blockRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "BLOCKED" }),
  });
  assert.equal(blockRes.status, 200);

  const reopenRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "IN_PROGRESS" }),
  });
  assert.equal(reopenRes.status, 200);
});

test("starting onboarding and changing its status write AuditLog entries", async () => {
  const candidateId = await createQualifiedCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);

  const startRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  const startBody = (await startRes.json()) as { id: string };

  await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/onboarding/${jobOrder.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "IN_PROGRESS" }),
  });

  const startedAudit = await prisma.auditLog.findFirst({
    where: { action: "worker.onboarding_started", entityType: "worker_onboarding", entityId: startBody.id },
  });
  const statusAudit = await prisma.auditLog.findFirst({
    where: { action: "worker.onboarding_status_changed", entityType: "worker_onboarding", entityId: startBody.id },
  });
  assert.ok(startedAudit);
  assert.ok(statusAudit);
});
