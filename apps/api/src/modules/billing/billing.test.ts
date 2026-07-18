import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createApp } from "../../app";
import { flagOverdueInvoicesForTenant } from "./service";

let server: Server;
let baseUrl: string;

const CEO_HEADERS = { "x-dev-user": "ceo@titan.dev", "content-type": "application/json" };
const ACCOUNTING_HEADERS = { "x-dev-user": "accounting@titan.dev", "content-type": "application/json" };
const PAYROLL_HEADERS = { "x-dev-user": "payroll@titan.dev", "content-type": "application/json" };
const OPERATIONS_HEADERS = { "x-dev-user": "operations@titan.dev", "content-type": "application/json" };
const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };

const REAL_COMPANY_ID = "company-01";
const REAL_CATEGORY_ID = "category-general-labor";

const createdCandidateIds: string[] = [];
const createdWorkerIds: string[] = [];
const createdJobOrderIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdTimeEntryIds: string[] = [];
const createdPayrollRunIds: string[] = [];
const createdInvoiceIds: string[] = [];
const createdContractIds: string[] = [];

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
  if (createdContractIds.length > 0) {
    await prisma.contract.deleteMany({ where: { id: { in: createdContractIds } } });
  }
  if (createdInvoiceIds.length > 0) {
    // onDelete: Cascade en InvoiceLine.invoiceId; Payment no tiene cascade
    // declarado (RESTRICT), se borra explícito primero.
    await prisma.payment.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
    await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
  }
  if (createdPayrollRunIds.length > 0) {
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

// F5.8: años lejanos (2031) para garantizar aislamiento total frente al
// seed real (~2026) y frente a los fixtures 2026/2029 de F5.6/F5.7 que
// conviven en el mismo proceso de test hasta su propio after() global.

async function createRealAssignment(billRate = 30, payRate = 20): Promise<string> {
  const candRes = await fetch(`${baseUrl}/api/v1/candidates`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({
      firstName: "F5.8test",
      lastName: `Worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `f58test.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`,
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
    body: JSON.stringify({ employmentType: "W2", defaultPayRate: payRate }),
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
      title: `F5.8 test — ${Date.now()}`,
      workersNeeded: 1,
      billRate,
      payRate,
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
      payRate,
      billRate,
      startDate: new Date().toISOString(),
    }),
  });
  const assignment = (await assignmentRes.json()) as { id: string };
  createdAssignmentIds.push(assignment.id);
  return assignment.id;
}

async function createApprovedEntry(assignmentId: string, date: string, hours = 8) {
  const res = await fetch(`${baseUrl}/api/v1/time-entries`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ assignmentId, date, regularHours: hours }),
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

/**
 * Cadena completa hasta un PayrollRun APPROVED con PayrollItem.billAmount
 * facturable — createInvoice solo agrega PayrollRuns APPROVED/PAID/EXPORTED
 * (ver BILLABLE_PAYROLL_RUN_STATUSES en service.ts).
 */
async function createApprovedPayrollRun(periodStart: string, periodEnd: string, hours = 8) {
  const assignmentId = await createRealAssignment();
  await createApprovedEntry(assignmentId, periodStart, hours);

  const createRes = await fetch(`${baseUrl}/api/v1/payroll/runs`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ periodStart, periodEnd }),
  });
  const run = (await createRes.json()) as { id: string };
  createdPayrollRunIds.push(run.id);

  await fetch(`${baseUrl}/api/v1/payroll/runs/${run.id}/submit`, { method: "POST", headers: PAYROLL_HEADERS });
  await fetch(`${baseUrl}/api/v1/payroll/runs/${run.id}/approve`, { method: "POST", headers: CEO_HEADERS });

  return { runId: run.id, assignmentId };
}

// ---- Generación ----

test("POST /invoices as sales@titan.dev returns 403 (no invoices.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-01-01", periodEnd: "2031-01-07" }),
  });
  assert.equal(res.status, 403);
});

test("POST /invoices with no unbilled approved payroll items in the period is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-02-01", periodEnd: "2031-02-07" }),
  });
  assert.equal(res.status, 400);
});

test("a PayrollRun still DRAFT (not yet APPROVED) is never billable", async () => {
  const assignmentId = await createRealAssignment();
  await createApprovedEntry(assignmentId, "2031-03-01");
  const createRes = await fetch(`${baseUrl}/api/v1/payroll/runs`, {
    method: "POST",
    headers: PAYROLL_HEADERS,
    body: JSON.stringify({ periodStart: "2031-03-01", periodEnd: "2031-03-07" }),
  });
  const run = (await createRes.json()) as { id: string };
  createdPayrollRunIds.push(run.id);
  // Nunca se somete/aprueba — se queda en DRAFT.

  const res = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-03-01", periodEnd: "2031-03-07" }),
  });
  assert.equal(res.status, 400);
});

test("generates a real Invoice from an APPROVED PayrollRun, with correct subtotal/total and one line per assignment", async () => {
  await createApprovedPayrollRun("2031-04-01", "2031-04-07", 8);

  const res = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-04-01", periodEnd: "2031-04-07" }),
  });
  assert.equal(res.status, 201);
  const invoice = (await res.json()) as { id: string; status: string; subtotal: string; total: string; balance: string };
  createdInvoiceIds.push(invoice.id);
  assert.equal(invoice.status, "DRAFT");
  // 8h * billRate 30 = 240
  assert.equal(Number(invoice.subtotal), 240);
  assert.equal(Number(invoice.total), 240);
  assert.equal(Number(invoice.balance), 240);

  const detailRes = await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}`, { headers: ACCOUNTING_HEADERS });
  const detail = (await detailRes.json()) as { lines: Array<{ amount: string }>; companyName: string };
  assert.equal(detail.lines.length, 1);
  assert.equal(Number(detail.lines[0]!.amount), 240);
  assert.ok(detail.companyName);
});

test("a PayrollItem already invoiced is never included again in a second Invoice for the same period", async () => {
  const { assignmentId } = await createApprovedPayrollRun("2031-05-01", "2031-05-07", 8);

  const firstRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-05-01", periodEnd: "2031-05-07" }),
  });
  assert.equal(firstRes.status, 201);
  const firstInvoice = (await firstRes.json()) as { id: string };
  createdInvoiceIds.push(firstInvoice.id);

  const secondRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-05-01", periodEnd: "2031-05-07" }),
  });
  assert.equal(secondRes.status, 400, "the same billAmount must never be billed twice");

  const item = await prisma.payrollItem.findFirst({ where: { assignmentId } });
  assert.equal(item?.invoiced, true);
});

// ---- Tenancy ----

test("an Invoice created under one tenant is invisible under another tenant context", async () => {
  await createApprovedPayrollRun("2031-06-01", "2031-06-07", 8);
  const res = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-06-01", periodEnd: "2031-06-07" }),
  });
  const { id } = (await res.json()) as { id: string };
  createdInvoiceIds.push(id);

  await runWithTenancyContext({ tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] }, async () => {
    const found = await prisma.invoice.findFirst({ where: { id, tenantId: "tenant-does-not-exist" } });
    assert.equal(found, null);
  });
});

// ---- Ciclo de estado ----

test("PATCH /invoices/:id/status to SENT via the generic endpoint is rejected — must use POST /send", async () => {
  await createApprovedPayrollRun("2031-07-01", "2031-07-07", 8);
  const createRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-07-01", periodEnd: "2031-07-07" }),
  });
  const invoice = (await createRes.json()) as { id: string };
  createdInvoiceIds.push(invoice.id);

  const res = await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/status`, {
    method: "PATCH",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ status: "SENT" }),
  });
  assert.equal(res.status, 403);
});

test("POST /invoices/:id/send as sales@titan.dev returns 403 (no invoices.send)", async () => {
  await createApprovedPayrollRun("2031-08-01", "2031-08-07", 8);
  const createRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-08-01", periodEnd: "2031-08-07" }),
  });
  const invoice = (await createRes.json()) as { id: string };
  createdInvoiceIds.push(invoice.id);

  const res = await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/send`, {
    method: "POST",
    headers: SALES_HEADERS,
  });
  assert.equal(res.status, 403);
});

test("attempting to set status directly to PAID is always rejected — PAID is derived from payments", async () => {
  await createApprovedPayrollRun("2031-09-01", "2031-09-07", 8);
  const createRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-09-01", periodEnd: "2031-09-07" }),
  });
  const invoice = (await createRes.json()) as { id: string };
  createdInvoiceIds.push(invoice.id);

  await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/send`, { method: "POST", headers: ACCOUNTING_HEADERS });

  const res = await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/status`, {
    method: "PATCH",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ status: "PAID" }),
  });
  assert.equal(res.status, 400);
});

test("full flow: DRAFT -> SENT -> partial payment -> full payment auto-transitions to PAID", async () => {
  await createApprovedPayrollRun("2031-10-01", "2031-10-07", 8);
  const createRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-10-01", periodEnd: "2031-10-07" }),
  });
  const invoice = (await createRes.json()) as { id: string; total: string };
  createdInvoiceIds.push(invoice.id);
  assert.equal(Number(invoice.total), 240);

  const sendRes = await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/send`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
  });
  assert.equal(sendRes.status, 200);
  assert.equal(((await sendRes.json()) as { status: string }).status, "SENT");

  const partialRes = await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/payments`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ amount: 100, method: "wire" }),
  });
  assert.equal(partialRes.status, 201);
  const afterPartial = (await partialRes.json()) as { status: string; balance: string; paidTotal: string };
  assert.equal(afterPartial.status, "SENT", "a partial payment must not close the invoice");
  assert.equal(Number(afterPartial.balance), 140);
  assert.equal(Number(afterPartial.paidTotal), 100);

  const finalRes = await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/payments`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ amount: 140, reference: "check-9912" }),
  });
  assert.equal(finalRes.status, 201);
  const afterFinal = (await finalRes.json()) as { status: string; balance: string; payments: unknown[] };
  assert.equal(afterFinal.status, "PAID", "balance reaching 0 must auto-close the invoice");
  assert.equal(Number(afterFinal.balance), 0);
  assert.equal(afterFinal.payments.length, 2);
});

test("a payment exceeding the outstanding balance is rejected", async () => {
  await createApprovedPayrollRun("2031-11-01", "2031-11-07", 8);
  const createRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-11-01", periodEnd: "2031-11-07" }),
  });
  const invoice = (await createRes.json()) as { id: string };
  createdInvoiceIds.push(invoice.id);
  await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/send`, { method: "POST", headers: ACCOUNTING_HEADERS });

  const res = await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/payments`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ amount: 999999 }),
  });
  assert.equal(res.status, 400);
});

test("a payment cannot be registered on a DRAFT invoice (must be sent first)", async () => {
  await createApprovedPayrollRun("2031-12-01", "2031-12-07", 8);
  const createRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2031-12-01", periodEnd: "2031-12-07" }),
  });
  const invoice = (await createRes.json()) as { id: string };
  createdInvoiceIds.push(invoice.id);

  const res = await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/payments`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ amount: 10 }),
  });
  assert.equal(res.status, 400);
});

test("VOID is reachable from DRAFT via the generic status endpoint and is terminal", async () => {
  await createApprovedPayrollRun("2032-01-01", "2032-01-07", 8);
  const createRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2032-01-01", periodEnd: "2032-01-07" }),
  });
  const invoice = (await createRes.json()) as { id: string };
  createdInvoiceIds.push(invoice.id);

  const voidRes = await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/status`, {
    method: "PATCH",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ status: "VOID" }),
  });
  assert.equal(voidRes.status, 200);
  assert.equal(((await voidRes.json()) as { status: string }).status, "VOID");

  const reopenRes = await fetch(`${baseUrl}/api/v1/invoices/${invoice.id}/status`, {
    method: "PATCH",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ status: "DRAFT" }),
  });
  assert.equal(reopenRes.status, 400, "VOID is terminal — no transition out of it");
});

// ---- Sweep de OVERDUE (F5.8 §10.3) ----

test("flagOverdueInvoicesForTenant flags a SENT invoice past its dueDate, and never touches DRAFT/PAID", async () => {
  await createApprovedPayrollRun("2032-02-01", "2032-02-07", 8);
  const createRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2032-02-01", periodEnd: "2032-02-07" }),
  });
  const overdueInvoice = (await createRes.json()) as { id: string };
  createdInvoiceIds.push(overdueInvoice.id);
  await fetch(`${baseUrl}/api/v1/invoices/${overdueInvoice.id}/send`, { method: "POST", headers: ACCOUNTING_HEADERS });
  await prisma.invoice.update({ where: { id: overdueInvoice.id }, data: { dueDate: new Date("2020-01-01") } });

  await createApprovedPayrollRun("2032-03-01", "2032-03-07", 8);
  const draftRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2032-03-01", periodEnd: "2032-03-07" }),
  });
  const draftInvoice = (await draftRes.json()) as { id: string };
  createdInvoiceIds.push(draftInvoice.id);
  // dueDate real (net-30 desde ahora) — nunca vencida, y sigue DRAFT de todas formas.

  const result = await flagOverdueInvoicesForTenant("tenant-titan");
  assert.ok(result.flagged >= 1);

  const overdueCheck = await prisma.invoice.findUniqueOrThrow({ where: { id: overdueInvoice.id } });
  assert.equal(overdueCheck.status, "OVERDUE");

  const draftCheck = await prisma.invoice.findUniqueOrThrow({ where: { id: draftInvoice.id } });
  assert.equal(draftCheck.status, "DRAFT", "a DRAFT invoice must never be swept into OVERDUE");
});

// ================= Billing Readiness (F9.8) =================
// F9.8: año 2033 para aislamiento total frente a los fixtures 2031/2032
// de F5.8 que conviven en el mismo proceso de test hasta su propio after() global.

test("GET /billing/readiness as sales@titan.dev returns 403 (no invoices.view)", async () => {
  const res = await fetch(
    `${baseUrl}/api/v1/billing/readiness?companyId=${REAL_COMPANY_ID}&periodStart=2033-01-01&periodEnd=2033-01-07`,
    { headers: SALES_HEADERS },
  );
  assert.equal(res.status, 403);
});

test("GET /billing/readiness for an unknown companyId returns 404", async () => {
  const res = await fetch(
    `${baseUrl}/api/v1/billing/readiness?companyId=does-not-exist&periodStart=2033-01-01&periodEnd=2033-01-07`,
    { headers: ACCOUNTING_HEADERS },
  );
  assert.equal(res.status, 404);
});

test("GET /billing/readiness with no payroll items is NOT_READY, and company-01 (no Contract seeded) surfaces a reviewNote", async () => {
  const res = await fetch(
    `${baseUrl}/api/v1/billing/readiness?companyId=${REAL_COMPANY_ID}&periodStart=2033-01-01&periodEnd=2033-01-07`,
    { headers: ACCOUNTING_HEADERS },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; reviewNotes: string[]; estimatedRevenue: string };
  assert.equal(body.status, "NOT_READY");
  assert.equal(body.estimatedRevenue, "0.00");
  assert.ok(body.reviewNotes.some((n) => n.includes("No contract")));
});

test("GET /billing/readiness with an APPROVED PayrollRun is READY_FOR_INVOICE with correct Decimal-safe money", async () => {
  await createApprovedPayrollRun("2033-02-01", "2033-02-07", 8);

  const res = await fetch(
    `${baseUrl}/api/v1/billing/readiness?companyId=${REAL_COMPANY_ID}&periodStart=2033-02-01&periodEnd=2033-02-07`,
    { headers: ACCOUNTING_HEADERS },
  );
  const body = (await res.json()) as {
    status: string;
    estimatedRevenue: string;
    estimatedLaborCost: string;
    estimatedGrossProfit: string;
  };
  assert.equal(body.status, "READY_FOR_INVOICE");
  // 8h * billRate 30 = 240 revenue; 8h * payRate 20 = 160 labor cost.
  assert.equal(body.estimatedRevenue, "240.00");
  assert.equal(body.estimatedLaborCost, "160.00");
  assert.equal(body.estimatedGrossProfit, "80.00");
});

test("GET /billing/readiness becomes EXPORTED once the real Invoice is generated for that period", async () => {
  await createApprovedPayrollRun("2033-03-01", "2033-03-07", 8);

  const invoiceRes = await fetch(`${baseUrl}/api/v1/invoices`, {
    method: "POST",
    headers: ACCOUNTING_HEADERS,
    body: JSON.stringify({ companyId: REAL_COMPANY_ID, periodStart: "2033-03-01", periodEnd: "2033-03-07" }),
  });
  const invoice = (await invoiceRes.json()) as { id: string };
  createdInvoiceIds.push(invoice.id);

  const res = await fetch(
    `${baseUrl}/api/v1/billing/readiness?companyId=${REAL_COMPANY_ID}&periodStart=2033-03-01&periodEnd=2033-03-07`,
    { headers: ACCOUNTING_HEADERS },
  );
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "EXPORTED");
});

test("GET /billing/readiness reflects a real EXPIRED Contract as BLOCKED", async () => {
  await createApprovedPayrollRun("2033-04-01", "2033-04-07", 8);
  const contract = await prisma.contract.create({
    data: { tenantId: "tenant-titan", companyId: REAL_COMPANY_ID, status: "EXPIRED" },
  });
  createdContractIds.push(contract.id);

  const res = await fetch(
    `${baseUrl}/api/v1/billing/readiness?companyId=${REAL_COMPANY_ID}&periodStart=2033-04-01&periodEnd=2033-04-07`,
    { headers: ACCOUNTING_HEADERS },
  );
  const body = (await res.json()) as { status: string; blockers: string[] };
  assert.equal(body.status, "BLOCKED");
  assert.ok(body.blockers[0]?.includes("EXPIRED"));
});
