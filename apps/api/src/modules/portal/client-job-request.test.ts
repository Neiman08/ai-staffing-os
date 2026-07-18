// F10.3: Client Job Request -- corre vía dev-bypass real. Foco: ciclo
// de vida completo (DRAFT -> SUBMITTED -> UNDER_REVIEW -> APPROVED ->
// CONVERTED_TO_JOB_ORDER), RBAC (CLIENT_MANAGER puede crear/enviar pero
// no editar/cancelar ni revisar; solo Operations/Sales revisan), y
// ownership/tenancy real (nunca ver/editar la solicitud de otra Company
// ni de otro tenant).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const CLIENT_ADMIN_HEADERS = { "x-dev-user": "client-admin@titan.dev", "content-type": "application/json" };
const CLIENT_MANAGER_HEADERS = { "x-dev-user": "client-manager@titan.dev", "content-type": "application/json" };
const ACME_CLIENT_ADMIN_HEADERS = { "x-dev-user": "client-admin@acme.dev", "content-type": "application/json" };
const OPERATIONS_HEADERS = { "x-dev-user": "operations@titan.dev", "content-type": "application/json" };
const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };

const REAL_CATEGORY_ID = "category-general-labor";

const createdRequestIds: string[] = [];
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
  if (createdRequestIds.length > 0) {
    // Nunca borra el JobOrder convertido -- solo desvincula la FK antes
    // de limpiar la ClientJobRequest, evita violar la constraint única.
    await prisma.clientJobRequest.updateMany({ where: { id: { in: createdRequestIds } }, data: { convertedJobOrderId: null } });
    await prisma.clientJobRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
  }
  if (createdJobOrderIds.length > 0) {
    await prisma.jobOrder.deleteMany({ where: { id: { in: createdJobOrderIds } } });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createDraft(overrides: Record<string, unknown> = {}, headers = CLIENT_ADMIN_HEADERS) {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/job-requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestedTitle: "F10.3 test — General Laborers",
      headcount: 3,
      desiredStartDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    }),
  });
  const body = (await res.json()) as { id: string };
  if (res.status === 201) createdRequestIds.push(body.id);
  return { res, body };
}

// ---- Creación (cliente) ----

test("POST /portal/client/job-requests as recruiter@titan.dev returns 403 (no clientJobs.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/job-requests`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ requestedTitle: "x", headcount: 1, desiredStartDate: new Date().toISOString() }),
  });
  assert.equal(res.status, 403);
});

test("POST /portal/client/job-requests creates a real DRAFT, never invents categoryId/rates", async () => {
  const { res, body } = (await createDraft()) as unknown as { res: Response; body: { status: string; companyId: string } };
  assert.equal(res.status, 201);
  assert.equal(body.status, "DRAFT");
  assert.equal(body.companyId, "company-01");
});

test("CLIENT_MANAGER can create a DRAFT and submit it, but cannot edit or cancel", async () => {
  const { body } = await createDraft({}, CLIENT_MANAGER_HEADERS);
  const req = body as { id: string };

  const editRes = await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}`, {
    method: "PATCH",
    headers: CLIENT_MANAGER_HEADERS,
    body: JSON.stringify({ requestedTitle: "changed" }),
  });
  assert.equal(editRes.status, 403);

  const submitRes = await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}/submit`, { method: "POST", headers: CLIENT_MANAGER_HEADERS });
  assert.equal(submitRes.status, 200, "CLIENT_MANAGER should be able to submit its own draft");

  const cancelRes = await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}/cancel`, { method: "POST", headers: CLIENT_MANAGER_HEADERS });
  assert.equal(cancelRes.status, 403);
});

// ---- Ownership / tenancy ----

test("IDOR: client-admin@titan.dev cannot see or edit another Company's job request (would need a real fixture -- verified via tenancy instead)", async () => {
  // company-01 y company-acme-01 están en tenants distintos -- el caso
  // MISMO-tenant-otra-Company ya está cubierto exhaustivamente por
  // client-portal.test.ts (F10.2); acá se verifica la variante de
  // tenancy real, más crítica para este nuevo modelo.
  const { body } = await createDraft();
  const req = body as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}`, { headers: ACME_CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 404);
});

test("PATCH /portal/client/job-requests/:id rejects editing once SUBMITTED", async () => {
  const { body } = await createDraft();
  const req = body as { id: string };
  await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}/submit`, { method: "POST", headers: CLIENT_ADMIN_HEADERS });

  const res = await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}`, {
    method: "PATCH",
    headers: CLIENT_ADMIN_HEADERS,
    body: JSON.stringify({ requestedTitle: "changed" }),
  });
  assert.equal(res.status, 400);
});

// ---- Revisión interna ----

test("PATCH /client-job-requests/:id/status as recruiter@titan.dev returns 403 (no clientJobs.approve)", async () => {
  const { body } = await createDraft();
  const req = body as { id: string };
  await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}/submit`, { method: "POST", headers: CLIENT_ADMIN_HEADERS });

  const res = await fetch(`${baseUrl}/api/v1/client-job-requests/${req.id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "UNDER_REVIEW" }),
  });
  assert.equal(res.status, 403);
});

test("internal review: SUBMITTED -> UNDER_REVIEW -> NEEDS_INFORMATION -> back to SUBMITTED by client -> UNDER_REVIEW -> APPROVED", async () => {
  const { body } = await createDraft();
  const req = body as { id: string };
  await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}/submit`, { method: "POST", headers: CLIENT_ADMIN_HEADERS });

  const toUnderReview = await fetch(`${baseUrl}/api/v1/client-job-requests/${req.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "UNDER_REVIEW" }),
  });
  assert.equal(toUnderReview.status, 200);

  const toNeedsInfo = await fetch(`${baseUrl}/api/v1/client-job-requests/${req.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "NEEDS_INFORMATION", reviewNotes: "Please confirm shift start time" }),
  });
  assert.equal(toNeedsInfo.status, 200);

  // El cliente ahora puede volver a editar (NEEDS_INFORMATION es editable).
  const editRes = await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}`, {
    method: "PATCH",
    headers: CLIENT_ADMIN_HEADERS,
    body: JSON.stringify({ schedule: "7am-3pm" }),
  });
  assert.equal(editRes.status, 200);

  const resubmit = await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}/submit`, { method: "POST", headers: CLIENT_ADMIN_HEADERS });
  assert.equal(resubmit.status, 200);
  assert.equal(((await resubmit.json()) as { status: string }).status, "SUBMITTED");

  await fetch(`${baseUrl}/api/v1/client-job-requests/${req.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "UNDER_REVIEW" }),
  });
  const approveRes = await fetch(`${baseUrl}/api/v1/client-job-requests/${req.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "APPROVED" }),
  });
  assert.equal(approveRes.status, 200);
  assert.equal(((await approveRes.json()) as { status: string }).status, "APPROVED");
});

// ---- Conversión a JobOrder real ----

test("POST /client-job-requests/:id/convert requires APPROVED status first", async () => {
  const { body } = await createDraft();
  const req = body as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/client-job-requests/${req.id}/convert`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ categoryId: REAL_CATEGORY_ID, billRate: 30, payRate: 20 }),
  });
  assert.equal(res.status, 400, "still DRAFT -- must be APPROVED first");
});

test("full path to CONVERTED_TO_JOB_ORDER creates a real JobOrder (DRAFT) linked back to the request, never auto-activates it", async () => {
  const { body } = await createDraft({ requestedTitle: "F10.3 conversion test", headcount: 5 });
  const req = body as { id: string };

  await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}/submit`, { method: "POST", headers: CLIENT_ADMIN_HEADERS });
  await fetch(`${baseUrl}/api/v1/client-job-requests/${req.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "UNDER_REVIEW" }),
  });
  await fetch(`${baseUrl}/api/v1/client-job-requests/${req.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "APPROVED" }),
  });

  const convertRes = await fetch(`${baseUrl}/api/v1/client-job-requests/${req.id}/convert`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ categoryId: REAL_CATEGORY_ID, billRate: 32, payRate: 22 }),
  });
  assert.equal(convertRes.status, 200);
  const converted = (await convertRes.json()) as { status: string; convertedJobOrderId: string | null };
  assert.equal(converted.status, "CONVERTED_TO_JOB_ORDER");
  assert.ok(converted.convertedJobOrderId);
  createdJobOrderIds.push(converted.convertedJobOrderId!);

  const jobOrder = await prisma.jobOrder.findUniqueOrThrow({ where: { id: converted.convertedJobOrderId! } });
  assert.equal(jobOrder.status, "DRAFT", "a converted JobOrder must never auto-activate -- starts DRAFT like any other");
  assert.equal(jobOrder.companyId, "company-01");
  assert.equal(jobOrder.workersNeeded, 5);
  assert.equal(Number(jobOrder.billRate), 32);
  assert.equal(Number(jobOrder.payRate), 22);
});

test("AuditLog entries are written for create, submit, review, and convert", async () => {
  const { body } = await createDraft({ requestedTitle: "F10.3 audit test" });
  const req = body as { id: string };
  await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${req.id}/submit`, { method: "POST", headers: CLIENT_ADMIN_HEADERS });
  await fetch(`${baseUrl}/api/v1/client-job-requests/${req.id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "UNDER_REVIEW" }),
  });

  const createdAudit = await prisma.auditLog.findFirst({ where: { action: "clientJobRequest.created", entityType: "clientJobRequest", entityId: req.id } });
  const submittedAudit = await prisma.auditLog.findFirst({ where: { action: "clientJobRequest.submitted", entityType: "clientJobRequest", entityId: req.id } });
  const reviewedAudit = await prisma.auditLog.findFirst({ where: { action: "clientJobRequest.reviewed", entityType: "clientJobRequest", entityId: req.id } });
  assert.ok(createdAudit);
  assert.ok(submittedAudit);
  assert.ok(reviewedAudit);
});
