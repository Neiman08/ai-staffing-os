import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };
const OPERATIONS_HEADERS = { "x-dev-user": "operations@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };

const REAL_COMPANY_ID = "company-01";
const REAL_CATEGORY_ID = "category-general-labor";

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
  // F9.4: Placement tiene FKs ON DELETE RESTRICT hacia Candidate/
  // JobOrder, así que debe borrarse primero (mismo patrón que
  // CandidateQualification, F8.5).
  if (createdCandidateIds.length > 0 || createdJobOrderIds.length > 0) {
    await prisma.placement.deleteMany({
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
      categoryId: REAL_CATEGORY_ID,
      title: "F9.4 test — General Labor",
      workersNeeded: 2,
      billRate: 30,
      payRate: 20,
      startDate: new Date().toISOString(),
      requirements: [],
      ...overrides,
    }),
  });
  const body = (await res.json()) as { id: string };
  if (res.status === 201) createdJobOrderIds.push(body.id);
  return body;
}

async function createQualifiedCandidate(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/v1/candidates`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({
      firstName: "F9.4test",
      lastName: `Candidate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `f94test.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`,
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

async function ensurePlacementReadiness(candidateId: string, jobOrderId: string) {
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement-readiness/${jobOrderId}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  return (await res.json()) as { readinessStatus: string };
}

// ---------- F9.4: Placement ----------

test("POST placement as sales@titan.dev returns 403 (no assignments.create)", async () => {
  const candidateId = await createQualifiedCandidate();
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrder.id}`, {
    method: "POST",
    headers: SALES_HEADERS,
  });
  assert.equal(res.status, 403);
});

test("POST placement returns 400 when no Placement Readiness was evaluated yet", async () => {
  const candidateId = await createQualifiedCandidate();
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  assert.equal(res.status, 400);
});

test("POST placement creates a real DRAFT with a compensation blocker when payRate/billRate are omitted, never changes Candidate.status", async () => {
  const candidateId = await createQualifiedCandidate();
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { status: string; payRate: string | null; billRate: string | null; blockers: string[] };
  assert.equal(body.status, "DRAFT");
  assert.equal(body.payRate, null);
  assert.equal(body.billRate, null);
  assert.ok(body.blockers.some((b) => b.includes("payRate")));

  const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });
  assert.equal(candidate.status, "QUALIFIED", "creating a placement must never change Candidate.status");
});

test("POST placement is idempotent: re-running returns the same record, never creates a duplicate", async () => {
  const candidateId = await createQualifiedCandidate();
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);

  const first = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  const firstBody = (await first.json()) as { id: string };
  const second = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  const secondBody = (await second.json()) as { id: string };
  assert.equal(firstBody.id, secondBody.id);

  const count = await prisma.placement.count({ where: { candidateId, jobOrderId: jobOrder.id } });
  assert.equal(count, 1);
});

test("PATCH status: PENDING_APPROVAL is rejected without compensation, succeeds once payRate/billRate are set", async () => {
  const candidateId = await createQualifiedCandidate();
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);
  const createRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  const placement = (await createRes.json()) as { id: string };

  const blockedRes = await fetch(`${baseUrl}/api/v1/placements/${placement.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "PENDING_APPROVAL" }),
  });
  assert.equal(blockedRes.status, 400, "compensation must never be inferred silently");

  await fetch(`${baseUrl}/api/v1/placements/${placement.id}`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ payRate: 20, billRate: 30 }),
  });

  const okRes = await fetch(`${baseUrl}/api/v1/placements/${placement.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "PENDING_APPROVAL" }),
  });
  assert.equal(okRes.status, 200);
});

test("PATCH status: cannot skip straight from DRAFT to ACTIVE -- placement is never activated automatically", async () => {
  const candidateId = await createQualifiedCandidate();
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);
  const createRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  const placement = (await createRes.json()) as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/placements/${placement.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "ACTIVE" }),
  });
  assert.equal(res.status, 400);
});

test("PATCH status: full path DRAFT -> PENDING_APPROVAL -> APPROVED -> READY_FOR_ONBOARDING -> ACTIVE -> COMPLETED succeeds and records approverId/approvedAt", async () => {
  const candidateId = await createQualifiedCandidate();
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);
  const createRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ payRate: 20, billRate: 30 }),
  });
  const placement = (await createRes.json()) as { id: string };

  for (const status of ["PENDING_APPROVAL", "APPROVED", "READY_FOR_ONBOARDING", "ACTIVE", "COMPLETED"]) {
    const res = await fetch(`${baseUrl}/api/v1/placements/${placement.id}/status`, {
      method: "PATCH",
      headers: OPERATIONS_HEADERS,
      body: JSON.stringify({ status }),
    });
    assert.equal(res.status, 200, `expected 200 moving to ${status}`);
  }

  const final = await prisma.placement.findUniqueOrThrow({ where: { id: placement.id } });
  assert.equal(final.status, "COMPLETED");
  assert.ok(final.approverId);
  assert.ok(final.approvedAt);
});

test("PATCH status: CANCELLED is reachable and reversible to DRAFT -- never a permanent rejection", async () => {
  const candidateId = await createQualifiedCandidate();
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);
  const createRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  const placement = (await createRes.json()) as { id: string };

  const cancelRes = await fetch(`${baseUrl}/api/v1/placements/${placement.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "CANCELLED" }),
  });
  assert.equal(cancelRes.status, 200);

  const reopenRes = await fetch(`${baseUrl}/api/v1/placements/${placement.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "DRAFT" }),
  });
  assert.equal(reopenRes.status, 200);
});

test("GET placement by candidate+jobOrder and by id return the real persisted record; creating and changing status write AuditLog entries", async () => {
  const candidateId = await createQualifiedCandidate();
  const jobOrder = await createValidJobOrder();
  await ensurePlacementReadiness(candidateId, jobOrder.id);
  const createRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrder.id}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ payRate: 20, billRate: 30 }),
  });
  const placement = (await createRes.json()) as { id: string };

  const byPairRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrder.id}`, { headers: OPERATIONS_HEADERS });
  assert.equal(byPairRes.status, 200);
  const byIdRes = await fetch(`${baseUrl}/api/v1/placements/${placement.id}`, { headers: OPERATIONS_HEADERS });
  assert.equal(byIdRes.status, 200);

  await fetch(`${baseUrl}/api/v1/placements/${placement.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "PENDING_APPROVAL" }),
  });

  const createdAudit = await prisma.auditLog.findFirst({ where: { action: "placement.created", entityType: "placement", entityId: placement.id } });
  const statusAudit = await prisma.auditLog.findFirst({ where: { action: "placement.status_changed", entityType: "placement", entityId: placement.id } });
  assert.ok(createdAudit);
  assert.ok(statusAudit);
});
