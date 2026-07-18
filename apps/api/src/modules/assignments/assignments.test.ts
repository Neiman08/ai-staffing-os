import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createApp } from "../../app";
import { getAssignmentDetail } from "./service";

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
const createdJobOrderIds: string[] = [];
const createdAssignmentIds: string[] = [];

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
  // F9.4/F9.5: Assignment.placementId y Placement tienen FKs que exigen
  // borrar Assignment antes que Placement/PlacementReadiness antes que
  // Candidate/JobOrder.
  if (createdAssignmentIds.length > 0) {
    await prisma.assignment.deleteMany({ where: { id: { in: createdAssignmentIds } } });
  }
  if (createdCandidateIds.length > 0 || createdJobOrderIds.length > 0) {
    await prisma.placement.deleteMany({
      where: { OR: [{ candidateId: { in: createdCandidateIds } }, { jobOrderId: { in: createdJobOrderIds } }] },
    });
    await prisma.placementReadiness.deleteMany({
      where: { OR: [{ candidateId: { in: createdCandidateIds } }, { jobOrderId: { in: createdJobOrderIds } }] },
    });
  }
  if (createdJobOrderIds.length > 0) {
    await prisma.jobOrder.deleteMany({ where: { id: { in: createdJobOrderIds } } });
  }
  if (createdWorkerIds.length > 0) {
    await prisma.worker.deleteMany({ where: { id: { in: createdWorkerIds } } });
  }
  if (createdCandidateIds.length > 0) {
    await prisma.candidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// F5.4: Compliance (escritura) es F5.5, todavía no existe — no hay forma
// legítima vía API de mover complianceStatus a COMPLIANT. Se arma la
// precondición directo con Prisma (documentado), igual que otras fases
// ya usaron Prisma directo para preparar fixtures que otro módulo futuro
// todavía no expone en escritura.
async function createAvailableCompliantWorker(): Promise<{ workerId: string; candidateId: string }> {
  const res = await fetch(`${baseUrl}/api/v1/candidates`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({
      firstName: "F5.4test",
      lastName: `Worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `f54test.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`,
      categoryIds: [REAL_CATEGORY_ID],
    }),
  });
  const candidate = (await res.json()) as { id: string };
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

  await prisma.worker.update({ where: { id: worker.worker.id }, data: { complianceStatus: "COMPLIANT" } });

  return { workerId: worker.worker.id, candidateId: candidate.id };
}

async function createOpenJobOrder(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      companyId: REAL_COMPANY_ID,
      categoryId: REAL_CATEGORY_ID,
      title: `F5.4 test — ${Date.now()}`,
      workersNeeded: 2,
      billRate: 30,
      payRate: 20,
      startDate: new Date().toISOString(),
      ...overrides,
    }),
  });
  const jobOrder = (await res.json()) as { id: string };
  createdJobOrderIds.push(jobOrder.id);

  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "OPEN" }),
  });

  return jobOrder.id;
}

async function createValidAssignment(overrides: Record<string, unknown> = {}) {
  const { workerId } = await createAvailableCompliantWorker();
  const jobOrderId = await createOpenJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      workerId,
      jobOrderId,
      payRate: 22,
      billRate: 33,
      startDate: new Date().toISOString(),
      ...overrides,
    }),
  });
  const body = (await res.json()) as { id: string };
  if (res.status === 201) createdAssignmentIds.push(body.id);
  return { res, body, workerId, jobOrderId };
}

// ---- Creación ----

test("POST /assignments as sales@titan.dev returns 403 (no assignments.create)", async () => {
  const { workerId } = await createAvailableCompliantWorker();
  const jobOrderId = await createOpenJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ workerId, jobOrderId, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  assert.equal(res.status, 403);
});

test("POST /assignments as operations@titan.dev creates a real Assignment, always SCHEDULED", async () => {
  const { res, body } = (await createValidAssignment()) as unknown as { res: Response; body: { id: string; status: string } };
  assert.equal(res.status, 201);
  assert.equal(body.status, "SCHEDULED", "a new Assignment must always start as SCHEDULED");
});

test("creating an Assignment marks the Worker as ASSIGNED and increments JobOrder.workersFilled/status", async () => {
  const { workerId, jobOrderId } = await createValidAssignment();

  const worker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
  assert.equal(worker.status, "ASSIGNED", "Worker.status must be derived, never left AVAILABLE after a real Assignment");

  const jobOrder = await prisma.jobOrder.findUniqueOrThrow({ where: { id: jobOrderId } });
  assert.equal(jobOrder.workersFilled, 1);
  assert.equal(jobOrder.status, "PARTIALLY_FILLED", "1 of 2 needed → PARTIALLY_FILLED, never edited by hand");
});

test("filling all needed workers moves the JobOrder to FILLED", async () => {
  const jobOrderId = await createOpenJobOrder({ workersNeeded: 1 });
  const { workerId } = await createAvailableCompliantWorker();
  const res = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId, jobOrderId, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  const body = (await res.json()) as { id: string };
  createdAssignmentIds.push(body.id);

  const jobOrder = await prisma.jobOrder.findUniqueOrThrow({ where: { id: jobOrderId } });
  assert.equal(jobOrder.status, "FILLED");
  assert.equal(jobOrder.workersFilled, 1);
});

test("POST /assignments rejects a Worker that is not COMPLIANT", async () => {
  const res1 = await fetch(`${baseUrl}/api/v1/candidates`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({
      firstName: "F5.4test",
      lastName: `NotCompliant-${Date.now()}`,
      email: `f54.notcompliant.${Date.now()}@example.com`,
      categoryIds: [REAL_CATEGORY_ID],
    }),
  });
  const candidate = (await res1.json()) as { id: string };
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
  // complianceStatus se queda en PENDING (default de la conversión) — nunca se fuerza a COMPLIANT acá.

  const jobOrderId = await createOpenJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      workerId: worker.worker.id,
      jobOrderId,
      payRate: 20,
      billRate: 30,
      startDate: new Date().toISOString(),
    }),
  });
  assert.equal(res.status, 400);
});

test("POST /assignments rejects a Worker that is already ASSIGNED (not AVAILABLE)", async () => {
  const { workerId } = await createValidAssignment();
  const jobOrderId = await createOpenJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId, jobOrderId, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  assert.equal(res.status, 400, "a Worker already ASSIGNED must never receive a second concurrent Assignment");
});

test("POST /assignments rejects a Job Order that is DRAFT (not OPEN/PARTIALLY_FILLED)", async () => {
  const { workerId } = await createAvailableCompliantWorker();
  const draftRes = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      companyId: REAL_COMPANY_ID,
      categoryId: REAL_CATEGORY_ID,
      title: `F5.4 test draft — ${Date.now()}`,
      workersNeeded: 2,
      billRate: 30,
      payRate: 20,
      startDate: new Date().toISOString(),
    }),
  });
  const draftJobOrder = (await draftRes.json()) as { id: string };
  createdJobOrderIds.push(draftJobOrder.id);

  const res = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      workerId,
      jobOrderId: draftJobOrder.id,
      payRate: 20,
      billRate: 30,
      startDate: new Date().toISOString(),
    }),
  });
  assert.equal(res.status, 400);
});

test("POST /assignments rejects a Job Order with no remaining capacity", async () => {
  const jobOrderId = await createOpenJobOrder({ workersNeeded: 1 });
  const { workerId: workerId1 } = await createAvailableCompliantWorker();
  const first = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId: workerId1, jobOrderId, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  const firstBody = (await first.json()) as { id: string };
  createdAssignmentIds.push(firstBody.id);

  const { workerId: workerId2 } = await createAvailableCompliantWorker();
  const second = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId: workerId2, jobOrderId, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  assert.equal(second.status, 400, "a Job Order already at capacity must reject a new Assignment");
});

test("endDate before startDate is rejected", async () => {
  const { res } = await createValidAssignment({
    startDate: "2026-08-01T00:00:00.000Z",
    endDate: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(res.status, 400);
});

test("the body cannot set status/tenantId on creation — those fields simply don't exist in the input contract", async () => {
  const { res, body } = (await createValidAssignment({ status: "ACTIVE", tenantId: "other" })) as unknown as {
    res: Response;
    body: { status: string };
  };
  assert.equal(res.status, 201);
  assert.equal(body.status, "SCHEDULED");
});

// ---- Tenancy ----

test("an Assignment created under one tenant is invisible/not-found under another tenant context", async () => {
  const { body } = await createValidAssignment();
  const assignment = body as { id: string };

  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      await assert.rejects(() => getAssignmentDetail(assignment.id), /Assignment not found/);
    },
  );
});

// ---- Detalle / listado ----

test("GET /assignments/:id for a nonexistent id returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/v1/assignments/does-not-exist`, { headers: OPERATIONS_HEADERS });
  assert.equal(res.status, 404);
});

test("GET /assignments/:id returns the full detail including workerComplianceStatus", async () => {
  const { body } = await createValidAssignment();
  const assignment = body as { id: string };

  const detailRes = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}`, { headers: OPERATIONS_HEADERS });
  assert.equal(detailRes.status, 200);
  const detail = (await detailRes.json()) as { workerComplianceStatus: string; updatedAt: string };
  assert.equal(detail.workerComplianceStatus, "COMPLIANT");
  assert.ok(detail.updatedAt);
});

test("GET /assignments supports filtering by jobOrderId and status", async () => {
  const { jobOrderId } = await createValidAssignment();
  const res = await fetch(`${baseUrl}/api/v1/assignments?jobOrderId=${jobOrderId}&status=SCHEDULED`, {
    headers: OPERATIONS_HEADERS,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ jobOrderId: string; status: string }> };
  for (const item of body.items) {
    assert.equal(item.jobOrderId, jobOrderId);
    assert.equal(item.status, "SCHEDULED");
  }
});

// ---- Edición ----

test("PATCH /assignments/:id edits allowed fields", async () => {
  const { body } = await createValidAssignment();
  const assignment = body as { id: string };

  const patchRes = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ payRate: 25, billRate: 38 }),
  });
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()) as { payRate: string; billRate: string };
  assert.equal(Number(updated.payRate), 25);
  assert.equal(Number(updated.billRate), 38);
});

test("PATCH /assignments/:id silently ignores workerId/jobOrderId/status/tenantId — protected fields never change", async () => {
  const { body, workerId, jobOrderId } = await createValidAssignment();
  const assignment = body as { id: string };

  const patchRes = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId: "hijacked", jobOrderId: "hijacked", status: "COMPLETED", tenantId: "other" }),
  });
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()) as { workerId: string; jobOrderId: string; status: string };
  assert.equal(updated.workerId, workerId);
  assert.equal(updated.jobOrderId, jobOrderId);
  assert.equal(updated.status, "SCHEDULED");
});

test("PATCH /assignments/:id for a nonexistent id returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/v1/assignments/does-not-exist`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ payRate: 25 }),
  });
  assert.equal(res.status, 404);
});

// ---- Transición de estado ----

test("valid transition SCHEDULED -> ACTIVE succeeds", async () => {
  const { body } = await createValidAssignment();
  const assignment = body as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "ACTIVE" }),
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, "ACTIVE");
});

test("invalid transition SCHEDULED -> COMPLETED is rejected (must go through ACTIVE first)", async () => {
  const { body } = await createValidAssignment();
  const assignment = body as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "COMPLETED" }),
  });
  assert.equal(res.status, 400);
});

test("closing an Assignment (ACTIVE -> COMPLETED) with a reason frees the Worker and reopens JobOrder capacity", async () => {
  const { body, workerId, jobOrderId } = await createValidAssignment();
  const assignment = body as { id: string };

  await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "ACTIVE" }),
  });
  const closeRes = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "COMPLETED", reason: "Contract ended normally" }),
  });
  assert.equal(closeRes.status, 200);

  const worker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
  assert.equal(worker.status, "AVAILABLE", "closing the only active Assignment must free the Worker back to AVAILABLE");

  const jobOrder = await prisma.jobOrder.findUniqueOrThrow({ where: { id: jobOrderId } });
  assert.equal(jobOrder.workersFilled, 0);
  assert.equal(jobOrder.status, "OPEN", "workersFilled back to 0 must reopen the Job Order");

  // El registro no se elimina — sigue existiendo y consultable.
  const stillThereRes = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}`, { headers: OPERATIONS_HEADERS });
  assert.equal(stillThereRes.status, 200);
});

test("status transition is idempotent: requesting the current status again succeeds without error", async () => {
  const { body } = await createValidAssignment();
  const assignment = body as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "SCHEDULED" }),
  });
  assert.equal(res.status, 200);
});

test("PATCH /assignments/:id/status as sales@titan.dev returns 403 (no assignments.update)", async () => {
  const { body } = await createValidAssignment();
  const assignment = body as { id: string };
  const res = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
    method: "PATCH",
    headers: SALES_HEADERS,
    body: JSON.stringify({ status: "ACTIVE" }),
  });
  assert.equal(res.status, 403);
});

// ---- Activity + AuditLog ----

test("creating an Assignment writes Activity + AuditLog on the assignment, jobOrder, and worker entities", async () => {
  const { body, workerId, jobOrderId } = await createValidAssignment();
  const assignment = body as { id: string };

  const assignmentActivity = await prisma.activity.findFirst({ where: { entityType: "assignment", entityId: assignment.id } });
  assert.ok(assignmentActivity);
  const assignmentAudit = await prisma.auditLog.findFirst({
    where: { entityType: "assignment", entityId: assignment.id, action: "assignment.created" },
  });
  assert.ok(assignmentAudit);

  const jobOrderActivity = await prisma.activity.findFirst({
    where: { entityType: "jobOrder", entityId: jobOrderId, subject: { contains: "Worker assigned" } },
  });
  assert.ok(jobOrderActivity);

  const workerActivity = await prisma.activity.findFirst({
    where: { entityType: "worker", entityId: workerId, subject: { contains: "Assigned to Job Order" } },
  });
  assert.ok(workerActivity);
});

test("a status transition writes Activity + AuditLog with before/after and the reason", async () => {
  const { body } = await createValidAssignment();
  const assignment = body as { id: string };

  await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "TERMINATED", reason: "Client cancelled the project" }),
  });

  const audit = await prisma.auditLog.findFirst({
    where: { entityType: "assignment", entityId: assignment.id, action: "assignment.status_changed" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(audit);
  assert.deepEqual(audit?.before, { status: "SCHEDULED" });
  assert.deepEqual(audit?.after, { status: "TERMINATED", reason: "Client cancelled the project" });
});

// ---------- F9.5: Assignment Management (extended lifecycle) ----------

async function createApprovedPlacement(candidateId: string, jobOrderId: string): Promise<string> {
  await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement-readiness/${jobOrderId}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  const createRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrderId}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ payRate: 20, billRate: 30 }),
  });
  const placement = (await createRes.json()) as { id: string };
  await fetch(`${baseUrl}/api/v1/placements/${placement.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "PENDING_APPROVAL" }),
  });
  await fetch(`${baseUrl}/api/v1/placements/${placement.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "APPROVED" }),
  });
  return placement.id;
}

test("POST /assignments with a placementId from a DRAFT (unapproved) Placement is rejected with 400", async () => {
  const { workerId, candidateId } = await createAvailableCompliantWorker();
  const jobOrderId = await createOpenJobOrder();
  await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement-readiness/${jobOrderId}`, { method: "POST", headers: RECRUITER_HEADERS });
  const placementRes = await fetch(`${baseUrl}/api/v1/candidates/${candidateId}/placement/${jobOrderId}`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
  });
  const placement = (await placementRes.json()) as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId, jobOrderId, placementId: placement.id, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  assert.equal(res.status, 400);
});

test("POST /assignments with an APPROVED Placement's id creates a real Assignment in DRAFT (extended lifecycle), never SCHEDULED directly", async () => {
  const { workerId, candidateId } = await createAvailableCompliantWorker();
  const jobOrderId = await createOpenJobOrder();
  const placementId = await createApprovedPlacement(candidateId, jobOrderId);

  const res = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId, jobOrderId, placementId, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string; status: string; placementId: string };
  createdAssignmentIds.push(body.id);
  assert.equal(body.status, "DRAFT");
  assert.equal(body.placementId, placementId);
});

test("a DRAFT Assignment never occupies the Worker/JobOrder capacity until it reaches an occupying status", async () => {
  const { workerId, candidateId } = await createAvailableCompliantWorker();
  const jobOrderId = await createOpenJobOrder();
  const placementId = await createApprovedPlacement(candidateId, jobOrderId);

  const createRes = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId, jobOrderId, placementId, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  const assignment = (await createRes.json()) as { id: string };
  createdAssignmentIds.push(assignment.id);

  const worker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
  assert.equal(worker.status, "AVAILABLE", "a DRAFT assignment must never mark the Worker as ASSIGNED");
});

test("full extended lifecycle DRAFT -> PENDING_APPROVAL -> SCHEDULED -> ACTIVE -> PAUSED -> ACTIVE -> COMPLETED succeeds; PAUSED still occupies the Worker", async () => {
  const { workerId, candidateId } = await createAvailableCompliantWorker();
  const jobOrderId = await createOpenJobOrder();
  const placementId = await createApprovedPlacement(candidateId, jobOrderId);

  const createRes = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId, jobOrderId, placementId, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  const assignment = (await createRes.json()) as { id: string };
  createdAssignmentIds.push(assignment.id);

  for (const status of ["PENDING_APPROVAL", "SCHEDULED", "ACTIVE", "PAUSED"]) {
    const res = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
      method: "PATCH",
      headers: OPERATIONS_HEADERS,
      body: JSON.stringify({ status }),
    });
    assert.equal(res.status, 200, `expected 200 moving to ${status}`);
  }

  const pausedWorker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
  assert.equal(pausedWorker.status, "ASSIGNED", "PAUSED must still occupy the Worker, never silently freeing it");

  const resumeRes = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "ACTIVE" }),
  });
  assert.equal(resumeRes.status, 200);

  const completeRes = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "COMPLETED" }),
  });
  assert.equal(completeRes.status, 200);
});

test("CANCELLED is reachable from SCHEDULED and reversible only to DRAFT -- never a permanent rejection", async () => {
  const { workerId, candidateId } = await createAvailableCompliantWorker();
  const jobOrderId = await createOpenJobOrder();
  const placementId = await createApprovedPlacement(candidateId, jobOrderId);
  const createRes = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId, jobOrderId, placementId, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  const assignment = (await createRes.json()) as { id: string };
  createdAssignmentIds.push(assignment.id);

  for (const status of ["PENDING_APPROVAL", "SCHEDULED"]) {
    await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
      method: "PATCH",
      headers: OPERATIONS_HEADERS,
      body: JSON.stringify({ status }),
    });
  }

  const cancelRes = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "CANCELLED" }),
  });
  assert.equal(cancelRes.status, 200);

  const reopenRes = await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "DRAFT" }),
  });
  assert.equal(reopenRes.status, 200);
});

test("a Worker with two DRAFT assignments on overlapping dates: confirming the first to SCHEDULED succeeds, confirming the second (overlapping) is rejected with 400", async () => {
  const { workerId, candidateId } = await createAvailableCompliantWorker();
  const jobOrderA = await createOpenJobOrder({ workersNeeded: 5 });
  const jobOrderB = await createOpenJobOrder({ workersNeeded: 5 });
  const placementA = await createApprovedPlacement(candidateId, jobOrderA);

  const start = new Date();
  const sameStartIso = start.toISOString();

  const assignmentARes = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId, jobOrderId: jobOrderA, placementId: placementA, payRate: 20, billRate: 30, startDate: sameStartIso }),
  });
  const assignmentA = (await assignmentARes.json()) as { id: string };
  createdAssignmentIds.push(assignmentA.id);

  // Segundo Assignment DRAFT directo (sin Placement) para el MISMO Worker
  // y una ventana de fechas solapada -- no requiere estar AVAILABLE
  // porque el primero sigue en DRAFT (no ocupa todavía).
  const assignmentBRes = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId, jobOrderId: jobOrderB, payRate: 20, billRate: 30, startDate: sameStartIso }),
  });
  // El segundo, sin placementId, nace SCHEDULED de inmediato (comportamiento
  // F5.4 preservado) -- pero el Worker ya no está AVAILABLE tras el primero
  // si este llegó a ocupar. Como A sigue en DRAFT, B sí puede crearse.
  assert.equal(assignmentBRes.status, 201);
  const assignmentB = (await assignmentBRes.json()) as { id: string; status: string };
  createdAssignmentIds.push(assignmentB.id);
  assert.equal(assignmentB.status, "SCHEDULED", "an Assignment created without a placementId keeps the F5.4 default behavior");

  // Confirmar A (DRAFT -> ... -> SCHEDULED) ahora debe fallar: B ya ocupa
  // ese rango de fechas para el mismo Worker.
  await fetch(`${baseUrl}/api/v1/assignments/${assignmentA.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "PENDING_APPROVAL" }),
  });
  const conflictRes = await fetch(`${baseUrl}/api/v1/assignments/${assignmentA.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "SCHEDULED" }),
  });
  assert.equal(conflictRes.status, 400, "confirming an overlapping Assignment for the same Worker must be rejected");
});

test("changing status to/from PAUSED writes AuditLog entries", async () => {
  const { workerId, candidateId } = await createAvailableCompliantWorker();
  const jobOrderId = await createOpenJobOrder();
  const placementId = await createApprovedPlacement(candidateId, jobOrderId);
  const createRes = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ workerId, jobOrderId, placementId, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  const assignment = (await createRes.json()) as { id: string };
  createdAssignmentIds.push(assignment.id);

  for (const status of ["PENDING_APPROVAL", "SCHEDULED", "ACTIVE", "PAUSED"]) {
    await fetch(`${baseUrl}/api/v1/assignments/${assignment.id}/status`, {
      method: "PATCH",
      headers: OPERATIONS_HEADERS,
      body: JSON.stringify({ status }),
    });
  }

  const pausedAudit = await prisma.auditLog.findFirst({
    where: { entityType: "assignment", entityId: assignment.id, action: "assignment.status_changed" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(pausedAudit);
  assert.deepEqual(pausedAudit?.after, { status: "PAUSED", reason: null });
});
