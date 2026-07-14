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
const createdPayrollRunIds: string[] = [];

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
  if (createdPayrollRunIds.length > 0) {
    // onDelete: Cascade en PayrollItem.payrollRunId ya limpia los items.
    await prisma.payrollRun.deleteMany({ where: { id: { in: createdPayrollRunIds } } });
  }
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

// ================= Payroll Runs (F5.7) =================
// F5.7: años lejanos (2029) para garantizar aislamiento total frente al
// seed real (~2026) y frente a los fixtures de TimeEntry de F5.6 (enero
// 2026) que conviven en el mismo archivo hasta su propio after() global.

async function createApprovedEntry(assignmentId: string, date: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/v1/time-entries`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ assignmentId, date, regularHours: 8, ...overrides }),
  });
  const body = (await res.json()) as { id: string };
  createdTimeEntryIds.push(body.id);
  await fetch(`${baseUrl}/api/v1/time-entries/bulk-approve`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ ids: [body.id] }),
  });
  return body.id;
}

test("POST /payroll/runs as sales@titan.dev returns 403 (no payrollRuns.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/payroll/runs`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ periodStart: "2029-01-01", periodEnd: "2029-01-07" }),
  });
  assert.equal(res.status, 403);
});

test("POST /payroll/runs with no APPROVED entries in the period is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/v1/payroll/runs`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ periodStart: "2029-02-01", periodEnd: "2029-02-07" }),
  });
  assert.equal(res.status, 400);
});

test("creating a Payroll run aggregates APPROVED entries, computes totals correctly, and locks the TimeEntries", async () => {
  const assignmentId = await createRealAssignment();
  await createApprovedEntry(assignmentId, "2029-03-01", { regularHours: 8, overtimeHours: 2 });
  await createApprovedEntry(assignmentId, "2029-03-02", { regularHours: 8, overtimeHours: 0 });

  // Una entrada PENDING (nunca aprobada) en el mismo rango — nunca debe
  // incluirse en el run.
  const pendingRes = await fetch(`${baseUrl}/api/v1/time-entries`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ assignmentId, date: "2029-03-03", regularHours: 8 }),
  });
  const pendingEntry = (await pendingRes.json()) as { id: string };
  createdTimeEntryIds.push(pendingEntry.id);

  const res = await fetch(`${baseUrl}/api/v1/payroll/runs`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ periodStart: "2029-03-01", periodEnd: "2029-03-07" }),
  });
  assert.equal(res.status, 201);
  const run = (await res.json()) as { id: string; status: string; itemCount: number; totalGross: string };
  createdPayrollRunIds.push(run.id);
  assert.equal(run.status, "DRAFT");
  assert.equal(run.itemCount, 1, "one PayrollItem per Assignment, aggregated across both approved days");

  // regularHours=16, otHours=2 -> payRate=20: regularPay=320, otPay=2*20*1.5=60 -> gross=380
  assert.equal(Number(run.totalGross), 380);

  const entry1 = await prisma.timeEntry.findFirst({ where: { assignmentId, date: new Date("2029-03-01") } });
  assert.equal(entry1?.status, "LOCKED", "an entry included in a Payroll run must become LOCKED");

  const pendingCheck = await prisma.timeEntry.findUniqueOrThrow({ where: { id: pendingEntry.id } });
  assert.equal(pendingCheck.status, "PENDING", "a PENDING entry must never be swept into a Payroll run");
});

test("GET /payroll/runs/:id returns the full detail with items", async () => {
  const assignmentId = await createRealAssignment();
  await createApprovedEntry(assignmentId, "2029-04-01");

  const createRes = await fetch(`${baseUrl}/api/v1/payroll/runs`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ periodStart: "2029-04-01", periodEnd: "2029-04-07" }),
  });
  const run = (await createRes.json()) as { id: string };
  createdPayrollRunIds.push(run.id);

  const detailRes = await fetch(`${baseUrl}/api/v1/payroll/runs/${run.id}`, { headers: PAYROLL_HEADERS });
  assert.equal(detailRes.status, 200);
  const detail = (await detailRes.json()) as { items: Array<{ workerName: string }>; createdByName: string | null };
  assert.equal(detail.items.length, 1);
  assert.ok(detail.createdByName);
});

test("full lifecycle: DRAFT -> PENDING_APPROVAL -> APPROVED -> PAID -> EXPORTED, with separation of duties enforced", async () => {
  const assignmentId = await createRealAssignment();
  await createApprovedEntry(assignmentId, "2029-05-01");

  const createRes = await fetch(`${baseUrl}/api/v1/payroll/runs`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ periodStart: "2029-05-01", periodEnd: "2029-05-07" }),
  });
  const run = (await createRes.json()) as { id: string };
  createdPayrollRunIds.push(run.id);

  const submitRes = await fetch(`${baseUrl}/api/v1/payroll/runs/${run.id}/submit`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
  });
  assert.equal(submitRes.status, 200);
  assert.equal(((await submitRes.json()) as { status: string }).status, "PENDING_APPROVAL");

  // El mismo usuario que creó el run (payroll@titan.dev) no puede aprobarlo.
  const selfApproveRes = await fetch(`${baseUrl}/api/v1/payroll/runs/${run.id}/approve`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
  });
  assert.equal(selfApproveRes.status, 403, "the creator must never be able to approve their own Payroll run");

  const approveRes = await fetch(`${baseUrl}/api/v1/payroll/runs/${run.id}/approve`, {
    method: "POST",
    headers: CEO_HEADERS,
  });
  assert.equal(approveRes.status, 200);
  assert.equal(((await approveRes.json()) as { status: string }).status, "APPROVED");

  const paidRes = await fetch(`${baseUrl}/api/v1/payroll/runs/${run.id}/mark-paid`, {
    method: "POST",
    headers: CEO_HEADERS,
  });
  assert.equal(paidRes.status, 200);
  assert.equal(((await paidRes.json()) as { status: string }).status, "PAID");

  const exportRes = await fetch(`${baseUrl}/api/v1/payroll/runs/${run.id}/export`, {
    method: "POST",
    headers: CEO_HEADERS,
  });
  assert.equal(exportRes.status, 200);
  assert.equal(exportRes.headers.get("content-type")?.includes("text/csv"), true);
  const csv = await exportRes.text();
  assert.match(csv, /"Worker","Job Order"/);

  const finalDetail = await fetch(`${baseUrl}/api/v1/payroll/runs/${run.id}`, { headers: CEO_HEADERS });
  assert.equal(((await finalDetail.json()) as { status: string }).status, "EXPORTED");
});

test("invalid transition DRAFT -> APPROVED (skipping submit) is rejected", async () => {
  const assignmentId = await createRealAssignment();
  await createApprovedEntry(assignmentId, "2029-06-01");

  const createRes = await fetch(`${baseUrl}/api/v1/payroll/runs`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ periodStart: "2029-06-01", periodEnd: "2029-06-07" }),
  });
  const run = (await createRes.json()) as { id: string };
  createdPayrollRunIds.push(run.id);

  const res = await fetch(`${baseUrl}/api/v1/payroll/runs/${run.id}/approve`, {
    method: "POST",
    headers: CEO_HEADERS,
  });
  assert.equal(res.status, 400);
});

test("exporting before PAID is rejected", async () => {
  const assignmentId = await createRealAssignment();
  await createApprovedEntry(assignmentId, "2029-07-01");

  const createRes = await fetch(`${baseUrl}/api/v1/payroll/runs`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ periodStart: "2029-07-01", periodEnd: "2029-07-07" }),
  });
  const run = (await createRes.json()) as { id: string };
  createdPayrollRunIds.push(run.id);

  const res = await fetch(`${baseUrl}/api/v1/payroll/runs/${run.id}/export`, {
    method: "POST",
    headers: CEO_HEADERS,
  });
  assert.equal(res.status, 400);
});

test("a Payroll run created under one tenant is invisible under another tenant context", async () => {
  const assignmentId = await createRealAssignment();
  await createApprovedEntry(assignmentId, "2029-08-01");

  const createRes = await fetch(`${baseUrl}/api/v1/payroll/runs`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ periodStart: "2029-08-01", periodEnd: "2029-08-07" }),
  });
  const run = (await createRes.json()) as { id: string };
  createdPayrollRunIds.push(run.id);

  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      const found = await prisma.payrollRun.findFirst({ where: { id: run.id, tenantId: "tenant-does-not-exist" } });
      assert.equal(found, null);
    },
  );
});

test("creating a Payroll run writes Activity + AuditLog", async () => {
  const assignmentId = await createRealAssignment();
  await createApprovedEntry(assignmentId, "2029-09-01");

  const createRes = await fetch(`${baseUrl}/api/v1/payroll/runs`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ periodStart: "2029-09-01", periodEnd: "2029-09-07" }),
  });
  const run = (await createRes.json()) as { id: string };
  createdPayrollRunIds.push(run.id);

  const activity = await prisma.activity.findFirst({ where: { entityType: "payrollRun", entityId: run.id } });
  assert.ok(activity);
  const audit = await prisma.auditLog.findFirst({ where: { entityType: "payrollRun", entityId: run.id, action: "payrollRun.created" } });
  assert.ok(audit);
});
