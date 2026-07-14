import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createApp } from "../../app";
import { runComplianceAlertSweepForTenant } from "./service";

let server: Server;
let baseUrl: string;

const CEO_HEADERS = { "x-dev-user": "ceo@titan.dev", "content-type": "application/json" };
const COMPLIANCE_HEADERS = { "x-dev-user": "compliance@titan.dev", "content-type": "application/json" };
const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };
const OPERATIONS_HEADERS = { "x-dev-user": "operations@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };

const REAL_COMPANY_ID = "company-01";
const REAL_CATEGORY_ID = "category-general-labor";
const DOCTYPE_DRUG_TEST_ID = "doctype-drug-test"; // requiresExpiration: true
const DOCTYPE_OSHA10_ID = "doctype-osha10";

const createdCandidateIds: string[] = [];
const createdWorkerIds: string[] = [];
const createdJobOrderIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdDocumentIds: string[] = [];

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
  if (createdDocumentIds.length > 0) {
    await prisma.complianceAlert.deleteMany({ where: { documentId: { in: createdDocumentIds } } });
    await prisma.document.deleteMany({ where: { id: { in: createdDocumentIds } } });
  }
  if (createdAssignmentIds.length > 0) {
    await prisma.assignment.deleteMany({ where: { id: { in: createdAssignmentIds } } });
  }
  if (createdJobOrderIds.length > 0) {
    await prisma.jobOrder.deleteMany({ where: { id: { in: createdJobOrderIds } } });
  }
  if (createdWorkerIds.length > 0) {
    await prisma.complianceAlert.deleteMany({ where: { workerId: { in: createdWorkerIds } } });
    await prisma.worker.deleteMany({ where: { id: { in: createdWorkerIds } } });
  }
  if (createdCandidateIds.length > 0) {
    await prisma.candidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createWorker(): Promise<{ workerId: string; candidateId: string }> {
  const res = await fetch(`${baseUrl}/api/v1/candidates`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({
      firstName: "F5.5test",
      lastName: `Worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `f55test.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`,
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

  return { workerId: worker.worker.id, candidateId: candidate.id };
}

async function createDocumentFor(
  ownerField: "candidateId" | "workerId",
  ownerId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await fetch(`${baseUrl}/api/v1/documents`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ documentTypeId: DOCTYPE_DRUG_TEST_ID, [ownerField]: ownerId, ...overrides }),
  });
  const body = (await res.json()) as { id: string };
  if (res.status === 201) createdDocumentIds.push(body.id);
  return { res, body };
}

// ---- POST /documents ----

test("POST /documents as sales@titan.dev returns 403 (no documents.create)", async () => {
  const { workerId } = await createWorker();
  const res = await fetch(`${baseUrl}/api/v1/documents`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ documentTypeId: DOCTYPE_DRUG_TEST_ID, workerId }),
  });
  assert.equal(res.status, 403);
});

test("POST /documents creates a real Document, always PENDING_REVIEW", async () => {
  const { workerId } = await createWorker();
  const { res, body } = (await createDocumentFor("workerId", workerId)) as unknown as {
    res: Response;
    body: { status: string };
  };
  assert.equal(res.status, 201);
  assert.equal(body.status, "PENDING_REVIEW");
});

test("POST /documents rejects providing both candidateId and workerId", async () => {
  const { workerId, candidateId } = await createWorker();
  const res = await fetch(`${baseUrl}/api/v1/documents`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ documentTypeId: DOCTYPE_DRUG_TEST_ID, workerId, candidateId }),
  });
  assert.equal(res.status, 400);
});

test("POST /documents rejects providing neither candidateId nor workerId", async () => {
  const res = await fetch(`${baseUrl}/api/v1/documents`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ documentTypeId: DOCTYPE_DRUG_TEST_ID }),
  });
  assert.equal(res.status, 400);
});

test("POST /documents rejects an unknown documentTypeId", async () => {
  const { workerId } = await createWorker();
  const res = await fetch(`${baseUrl}/api/v1/documents`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ documentTypeId: "doctype-does-not-exist", workerId }),
  });
  assert.equal(res.status, 400);
});

// ---- POST /documents/:id/verify ----

test("POST /documents/:id/verify as recruiter@titan.dev returns 403 (no compliance.verify)", async () => {
  const { workerId } = await createWorker();
  const { body } = await createDocumentFor("workerId", workerId);
  const doc = body as { id: string };
  const res = await fetch(`${baseUrl}/api/v1/documents/${doc.id}/verify`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "VERIFIED" }),
  });
  assert.equal(res.status, 403);
});

test("POST /documents/:id/verify as compliance@titan.dev marks a document VERIFIED", async () => {
  const { workerId } = await createWorker();
  const { body } = await createDocumentFor("workerId", workerId);
  const doc = body as { id: string };
  const res = await fetch(`${baseUrl}/api/v1/documents/${doc.id}/verify`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ status: "VERIFIED" }),
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, "VERIFIED");
});

test("rejecting a document without rejectionReason is rejected", async () => {
  const { workerId } = await createWorker();
  const { body } = await createDocumentFor("workerId", workerId);
  const doc = body as { id: string };
  const res = await fetch(`${baseUrl}/api/v1/documents/${doc.id}/verify`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ status: "REJECTED" }),
  });
  assert.equal(res.status, 400);
});

test("rejecting a document creates a FAILED_CHECK alert and blocks the Worker", async () => {
  const { workerId } = await createWorker();
  const { body } = await createDocumentFor("workerId", workerId);
  const doc = body as { id: string };

  const res = await fetch(`${baseUrl}/api/v1/documents/${doc.id}/verify`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ status: "REJECTED", rejectionReason: "Expired at time of submission" }),
  });
  assert.equal(res.status, 200);

  const alert = await prisma.complianceAlert.findFirst({ where: { workerId, type: "FAILED_CHECK" } });
  assert.ok(alert, "a FAILED_CHECK alert must be created automatically when a document is rejected");
  assert.equal(alert?.resolvedAt, null);

  const worker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
  assert.equal(worker.complianceStatus, "BLOCKED", "Worker.complianceStatus must be derived from the real unresolved alert");
});

test("verifying a document does not create any alert and leaves complianceStatus unaffected by it", async () => {
  const { workerId } = await createWorker();
  const { body } = await createDocumentFor("workerId", workerId);
  const doc = body as { id: string };

  await fetch(`${baseUrl}/api/v1/documents/${doc.id}/verify`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ status: "VERIFIED" }),
  });

  const alerts = await prisma.complianceAlert.count({ where: { workerId } });
  assert.equal(alerts, 0);
});

test("POST /documents/:id/verify for a nonexistent id returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/v1/documents/does-not-exist/verify`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ status: "VERIFIED" }),
  });
  assert.equal(res.status, 404);
});

// ---- POST /compliance/alerts/:id/resolve ----

test("POST /compliance/alerts/:id/resolve as recruiter@titan.dev returns 403 (no compliance.verify)", async () => {
  const { workerId } = await createWorker();
  const { body } = await createDocumentFor("workerId", workerId);
  const doc = body as { id: string };
  await fetch(`${baseUrl}/api/v1/documents/${doc.id}/verify`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ status: "REJECTED", rejectionReason: "test" }),
  });
  const alert = await prisma.complianceAlert.findFirstOrThrow({ where: { workerId, type: "FAILED_CHECK" } });

  const res = await fetch(`${baseUrl}/api/v1/compliance/alerts/${alert.id}/resolve`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  assert.equal(res.status, 403);
});

test("resolving a FAILED_CHECK alert un-blocks the Worker back to COMPLIANT", async () => {
  const { workerId } = await createWorker();
  const { body } = await createDocumentFor("workerId", workerId);
  const doc = body as { id: string };
  await fetch(`${baseUrl}/api/v1/documents/${doc.id}/verify`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ status: "REJECTED", rejectionReason: "test" }),
  });
  const alert = await prisma.complianceAlert.findFirstOrThrow({ where: { workerId, type: "FAILED_CHECK" } });

  const res = await fetch(`${baseUrl}/api/v1/compliance/alerts/${alert.id}/resolve`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
  });
  assert.equal(res.status, 200);

  const worker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
  assert.equal(worker.complianceStatus, "COMPLIANT");
});

test("resolving an already-resolved alert is idempotent, never a second AuditLog entry", async () => {
  const { workerId } = await createWorker();
  const { body } = await createDocumentFor("workerId", workerId);
  const doc = body as { id: string };
  await fetch(`${baseUrl}/api/v1/documents/${doc.id}/verify`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ status: "REJECTED", rejectionReason: "test" }),
  });
  const alert = await prisma.complianceAlert.findFirstOrThrow({ where: { workerId, type: "FAILED_CHECK" } });

  await fetch(`${baseUrl}/api/v1/compliance/alerts/${alert.id}/resolve`, { method: "POST", headers: COMPLIANCE_HEADERS });
  const secondRes = await fetch(`${baseUrl}/api/v1/compliance/alerts/${alert.id}/resolve`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
  });
  assert.equal(secondRes.status, 200);

  const auditCount = await prisma.auditLog.count({
    where: { entityType: "complianceAlert", entityId: alert.id, action: "complianceAlert.resolved" },
  });
  assert.equal(auditCount, 1, "resolving twice must only ever produce one AuditLog entry");
});

// ---- Tenancy ----

test("a Document created under one tenant is invisible under another tenant context", async () => {
  const { workerId } = await createWorker();
  const { body } = await createDocumentFor("workerId", workerId);
  const doc = body as { id: string };

  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      const found = await prisma.document.findFirst({ where: { id: doc.id, tenantId: "tenant-does-not-exist" } });
      assert.equal(found, null);
    },
  );
});

// ---- Sweep periódico ----

test("sweep generates an EXPIRING alert for a document expiring within the window", async () => {
  const { workerId } = await createWorker();
  const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 días — dentro de la ventana de 30
  const { body } = await createDocumentFor("workerId", workerId, { expirationDate: soon.toISOString() });
  const doc = body as { id: string };

  await runComplianceAlertSweepForTenant("tenant-titan");

  const alert = await prisma.complianceAlert.findFirst({ where: { documentId: doc.id, type: "EXPIRING" } });
  assert.ok(alert, "an EXPIRING alert must be created for a document expiring within the window");

  const worker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
  assert.equal(worker.complianceStatus, "PENDING");
});

test("sweep is idempotent: running it twice never creates a duplicate EXPIRING alert", async () => {
  const { workerId } = await createWorker();
  const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  const { body } = await createDocumentFor("workerId", workerId, { expirationDate: soon.toISOString() });
  const doc = body as { id: string };

  await runComplianceAlertSweepForTenant("tenant-titan");
  await runComplianceAlertSweepForTenant("tenant-titan");

  const alertCount = await prisma.complianceAlert.count({ where: { documentId: doc.id, type: "EXPIRING" } });
  assert.equal(alertCount, 1);
});

test("sweep generates an EXPIRED alert and flips the Document status for an already-expired document", async () => {
  const { workerId } = await createWorker();
  const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const { body } = await createDocumentFor("workerId", workerId, { expirationDate: past.toISOString() });
  const doc = body as { id: string };

  await runComplianceAlertSweepForTenant("tenant-titan");

  const alert = await prisma.complianceAlert.findFirst({ where: { documentId: doc.id, type: "EXPIRED" } });
  assert.ok(alert);

  const updatedDoc = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
  assert.equal(updatedDoc.status, "EXPIRED");

  const worker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
  assert.equal(worker.complianceStatus, "BLOCKED");
});

test("sweep generates a MISSING alert for a Worker on an active Assignment whose Job Order requires an undelivered document", async () => {
  const { workerId } = await createWorker();
  await prisma.worker.update({ where: { id: workerId }, data: { complianceStatus: "COMPLIANT" } });

  const jobOrderRes = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      companyId: REAL_COMPANY_ID,
      categoryId: REAL_CATEGORY_ID,
      title: `F5.5 test — ${Date.now()}`,
      workersNeeded: 1,
      billRate: 30,
      payRate: 20,
      startDate: new Date().toISOString(),
      requirements: ["osha10"],
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
      workerId,
      jobOrderId: jobOrder.id,
      payRate: 20,
      billRate: 30,
      startDate: new Date().toISOString(),
    }),
  });
  const assignment = (await assignmentRes.json()) as { id: string };
  createdAssignmentIds.push(assignment.id);

  // El Worker no tiene osha10 todavía — el sweep debe detectarlo.
  await runComplianceAlertSweepForTenant("tenant-titan");

  const alert = await prisma.complianceAlert.findFirst({ where: { workerId, type: "MISSING" } });
  assert.ok(alert, "a MISSING alert must be created for a required document the Worker never provided");
  assert.match(alert!.message, /osha10/);

  const worker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
  assert.equal(worker.complianceStatus, "BLOCKED");
});

test("sweep never generates MISSING once the Worker has a real (non-rejected) document of that type", async () => {
  const { workerId } = await createWorker();
  await prisma.worker.update({ where: { id: workerId }, data: { complianceStatus: "COMPLIANT" } });

  await createDocumentFor("workerId", workerId, { documentTypeId: DOCTYPE_OSHA10_ID });

  const jobOrderRes = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      companyId: REAL_COMPANY_ID,
      categoryId: REAL_CATEGORY_ID,
      title: `F5.5 test — ${Date.now()}`,
      workersNeeded: 1,
      billRate: 30,
      payRate: 20,
      startDate: new Date().toISOString(),
      requirements: ["osha10"],
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
    body: JSON.stringify({ workerId, jobOrderId: jobOrder.id, payRate: 20, billRate: 30, startDate: new Date().toISOString() }),
  });
  const assignment = (await assignmentRes.json()) as { id: string };
  createdAssignmentIds.push(assignment.id);

  await runComplianceAlertSweepForTenant("tenant-titan");

  const alert = await prisma.complianceAlert.findFirst({ where: { workerId, type: "MISSING" } });
  assert.equal(alert, null, "a Worker who already has the required document must never get a MISSING alert for it");
});
