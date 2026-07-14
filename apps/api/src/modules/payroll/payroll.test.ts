import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const CEO_HEADERS = { "x-dev-user": "ceo@titan.dev", "content-type": "application/json" };
const PAYROLL_HEADERS = { "x-dev-user": "payroll@titan.dev", "content-type": "application/json" };
const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };
const OPERATIONS_HEADERS = { "x-dev-user": "operations@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };

const REAL_COMPANY_ID = "company-01";
const REAL_CATEGORY_ID = "category-general-labor";

const createdCandidateIds: string[] = [];
const createdWorkerIds: string[] = [];
const createdJobOrderIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdTimeEntryIds: string[] = [];

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
  if (createdTimeEntryIds.length > 0) {
    await prisma.timeEntry.deleteMany({ where: { id: { in: createdTimeEntryIds } } });
  }
  if (createdAssignmentIds.length > 0) {
    await prisma.assignment.deleteMany({ where: { id: { in: createdAssignmentIds } } });
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

async function createRealAssignment(): Promise<string> {
  const candRes = await fetch(`${baseUrl}/api/v1/candidates`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({
      firstName: "F5.6test",
      lastName: `Worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `f56test.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`,
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
  await prisma.worker.update({ where: { id: worker.worker.id }, data: { complianceStatus: "COMPLIANT" } });

  const jobOrderRes = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      companyId: REAL_COMPANY_ID,
      categoryId: REAL_CATEGORY_ID,
      title: `F5.6 test — ${Date.now()}`,
      workersNeeded: 1,
      billRate: 30,
      payRate: 20,
      startDate: new Date().toISOString(),
    }),
  });
  const jobOrder = (await jobOrderRes.json()) as { id: string };
  createdJobOrderIds.push(jobOrder.id);
  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "OPEN" }),
  });

  const assignmentRes = await fetch(`${baseUrl}/api/v1/assignments`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      workerId: worker.worker.id,
      jobOrderId: jobOrder.id,
      payRate: 20,
      billRate: 30,
      startDate: new Date().toISOString(),
    }),
  });
  const assignment = (await assignmentRes.json()) as { id: string };
  createdAssignmentIds.push(assignment.id);
  return assignment.id;
}

let dayCounter = 0;
function nextUniqueDate(): string {
  dayCounter += 1;
  const d = new Date(2026, 0, dayCounter);
  return d.toISOString();
}

async function createValidTimeEntry(assignmentId: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/v1/time-entries`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ assignmentId, date: nextUniqueDate(), regularHours: 8, ...overrides }),
  });
  const body = (await res.json()) as { id: string };
  if (res.status === 201) createdTimeEntryIds.push(body.id);
  return { res, body };
}

// ---- Creación ----

test("POST /time-entries as sales@titan.dev returns 403 (no timeEntries.create)", async () => {
  const assignmentId = await createRealAssignment();
  const res = await fetch(`${baseUrl}/api/v1/time-entries`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ assignmentId, date: nextUniqueDate(), regularHours: 8 }),
  });
  assert.equal(res.status, 403);
});

test("POST /time-entries as payroll@titan.dev creates a real TimeEntry, always PENDING", async () => {
  const assignmentId = await createRealAssignment();
  const { res, body } = (await createValidTimeEntry(assignmentId)) as unknown as { res: Response; body: { status: string } };
  assert.equal(res.status, 201);
  assert.equal(body.status, "PENDING");
});

test("POST /time-entries rejects an unknown assignmentId", async () => {
  const res = await fetch(`${baseUrl}/api/v1/time-entries`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ assignmentId: "assignment-does-not-exist", date: nextUniqueDate(), regularHours: 8 }),
  });
  assert.equal(res.status, 400);
});

test("POST /time-entries rejects total hours exceeding 24 in a single day", async () => {
  const assignmentId = await createRealAssignment();
  const { res } = await createValidTimeEntry(assignmentId, { regularHours: 10, overtimeHours: 10, doubleHours: 10 });
  assert.equal(res.status, 400);
});

test("POST /time-entries rejects a duplicate for the same assignmentId+date with 409", async () => {
  const assignmentId = await createRealAssignment();
  const sharedDate = nextUniqueDate();
  const first = await createValidTimeEntry(assignmentId, { date: sharedDate });
  assert.equal(first.res.status, 201);

  const second = await createValidTimeEntry(assignmentId, { date: sharedDate });
  assert.equal(second.res.status, 409);
});

test("the body cannot set status/tenantId on creation — those fields simply don't exist in the input contract", async () => {
  const assignmentId = await createRealAssignment();
  const { res, body } = (await createValidTimeEntry(assignmentId, { status: "APPROVED", tenantId: "other" })) as unknown as {
    res: Response;
    body: { status: string };
  };
  assert.equal(res.status, 201);
  assert.equal(body.status, "PENDING");
});

// ---- Tenancy ----

test("a TimeEntry created under one tenant is invisible under another tenant context", async () => {
  const assignmentId = await createRealAssignment();
  const { body } = await createValidTimeEntry(assignmentId);
  const entry = body as { id: string };

  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      const found = await prisma.timeEntry.findFirst({ where: { id: entry.id, tenantId: "tenant-does-not-exist" } });
      assert.equal(found, null);
    },
  );
});

// ---- Listado ----

test("GET /time-entries supports filtering by assignmentId and status", async () => {
  const assignmentId = await createRealAssignment();
  await createValidTimeEntry(assignmentId);

  const res = await fetch(`${baseUrl}/api/v1/time-entries?assignmentId=${assignmentId}&status=PENDING`, {
    headers: PAYROLL_HEADERS,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ status: string }> };
  assert.ok(body.items.length > 0);
  for (const item of body.items) {
    assert.equal(item.status, "PENDING");
  }
});

// ---- Edición ----

test("PATCH /time-entries/:id edits allowed fields while PENDING", async () => {
  const assignmentId = await createRealAssignment();
  const { body } = await createValidTimeEntry(assignmentId);
  const entry = body as { id: string };

  const patchRes = await fetch(`${baseUrl}/api/v1/time-entries/${entry.id}`, {
    method: "PATCH",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ regularHours: 6, overtimeHours: 2 }),
  });
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()) as { regularHours: string; overtimeHours: string };
  assert.equal(Number(updated.regularHours), 6);
  assert.equal(Number(updated.overtimeHours), 2);
});

test("PATCH /time-entries/:id rejects editing an already-APPROVED entry", async () => {
  const assignmentId = await createRealAssignment();
  const { body } = await createValidTimeEntry(assignmentId);
  const entry = body as { id: string };

  await fetch(`${baseUrl}/api/v1/time-entries/bulk-approve`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ ids: [entry.id] }),
  });

  const patchRes = await fetch(`${baseUrl}/api/v1/time-entries/${entry.id}`, {
    method: "PATCH",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ regularHours: 4 }),
  });
  assert.equal(patchRes.status, 400);
});

test("PATCH /time-entries/:id for a nonexistent id returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/v1/time-entries/does-not-exist`, {
    method: "PATCH",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ regularHours: 4 }),
  });
  assert.equal(res.status, 404);
});

// ---- Bulk approve ----

test("POST /time-entries/bulk-approve as sales@titan.dev returns 403 (no timeEntries.update)", async () => {
  const assignmentId = await createRealAssignment();
  const { body } = await createValidTimeEntry(assignmentId);
  const entry = body as { id: string };
  const res = await fetch(`${baseUrl}/api/v1/time-entries/bulk-approve`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ ids: [entry.id] }),
  });
  assert.equal(res.status, 403);
});

test("bulk-approve moves eligible PENDING entries to APPROVED and ignores the rest", async () => {
  const assignmentId = await createRealAssignment();
  const { body: entry1 } = await createValidTimeEntry(assignmentId);
  const { body: entry2 } = await createValidTimeEntry(assignmentId);
  const e1 = entry1 as { id: string };
  const e2 = entry2 as { id: string };

  // Aprobar la primera dos veces (segunda vez ya no es PENDING) y la
  // segunda una vez — confirma que "ya no aplica" se ignora sin error.
  await fetch(`${baseUrl}/api/v1/time-entries/bulk-approve`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ ids: [e1.id] }),
  });

  const res = await fetch(`${baseUrl}/api/v1/time-entries/bulk-approve`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ ids: [e1.id, e2.id] }),
  });
  assert.equal(res.status, 200);
  const result = (await res.json()) as { approved: number; skipped: number };
  assert.equal(result.approved, 1, "only e2 was still PENDING at this point");
  assert.equal(result.skipped, 1, "e1 was already APPROVED, must be skipped without error");

  const e2Row = await prisma.timeEntry.findUniqueOrThrow({ where: { id: e2.id } });
  assert.equal(e2Row.status, "APPROVED");
  assert.ok(e2Row.approvedById);
});

// ---- Activity + AuditLog ----

test("creating a TimeEntry writes Activity on the Assignment + AuditLog on the TimeEntry", async () => {
  const assignmentId = await createRealAssignment();
  const { body } = await createValidTimeEntry(assignmentId);
  const entry = body as { id: string };

  const activity = await prisma.activity.findFirst({ where: { entityType: "assignment", entityId: assignmentId, subject: { contains: "Time entry logged" } } });
  assert.ok(activity);
  const audit = await prisma.auditLog.findFirst({ where: { entityType: "timeEntry", entityId: entry.id, action: "timeEntry.created" } });
  assert.ok(audit);
});

test("bulk-approve writes a single AuditLog entry listing all affected ids", async () => {
  const assignmentId = await createRealAssignment();
  const { body: entry1 } = await createValidTimeEntry(assignmentId);
  const { body: entry2 } = await createValidTimeEntry(assignmentId);
  const e1 = entry1 as { id: string };
  const e2 = entry2 as { id: string };

  await fetch(`${baseUrl}/api/v1/time-entries/bulk-approve`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ ids: [e1.id, e2.id] }),
  });

  const audit = await prisma.auditLog.findFirst({
    where: { action: "timeEntry.bulk_approved", entityId: `${e1.id},${e2.id}` },
  });
  assert.ok(audit);
  assert.deepEqual((audit?.before as { ids: string[] }).ids, [e1.id, e2.id]);
});
