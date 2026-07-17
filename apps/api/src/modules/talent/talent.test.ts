import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createApp } from "../../app";
import { convertCandidateToWorker, getCandidateDetail } from "./service";

let server: Server;
let baseUrl: string;

const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };
const CEO_HEADERS = { "x-dev-user": "ceo@titan.dev", "content-type": "application/json" };
const OPERATIONS_HEADERS = { "x-dev-user": "operations@titan.dev", "content-type": "application/json" };

// F5.2: registro real del seed de F0 — no se inventan IDs.
const REAL_CATEGORY_ID = "category-general-labor";
const REAL_FORKLIFT_CATEGORY_ID = "category-forklift-operator";
const REAL_COMPANY_ID = "company-01";

const createdCandidateIds: string[] = [];
const createdWorkerIds: string[] = [];
const createdJobOrderIds: string[] = [];
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
  // F5.2/F8.2/F8.5/F8.6/F8.7/F8.8/F8.9/F8.10: limpieza — todo lo creado
  // por esta suite queda claramente identificado (nombre/prefijo de
  // test) y se borra al terminar. CandidateQualification/CandidateMatch/
  // CandidateShortlistEntry/ScreeningPlan/InterviewPreview/
  // PlacementReadiness tienen FKs ON DELETE RESTRICT hacia Candidate/
  // JobOrder, así que deben borrarse primero.
  if (createdCandidateIds.length > 0 || createdJobOrderIds.length > 0) {
    await prisma.placementReadiness.deleteMany({
      where: { OR: [{ candidateId: { in: createdCandidateIds } }, { jobOrderId: { in: createdJobOrderIds } }] },
    });
    await prisma.interviewPreview.deleteMany({
      where: { OR: [{ candidateId: { in: createdCandidateIds } }, { jobOrderId: { in: createdJobOrderIds } }] },
    });
    await prisma.screeningPlan.deleteMany({
      where: { OR: [{ candidateId: { in: createdCandidateIds } }, { jobOrderId: { in: createdJobOrderIds } }] },
    });
    await prisma.candidateShortlistEntry.deleteMany({
      where: { OR: [{ candidateId: { in: createdCandidateIds } }, { jobOrderId: { in: createdJobOrderIds } }] },
    });
    await prisma.candidateMatch.deleteMany({
      where: { OR: [{ candidateId: { in: createdCandidateIds } }, { jobOrderId: { in: createdJobOrderIds } }] },
    });
    await prisma.candidateQualification.deleteMany({
      where: { OR: [{ candidateId: { in: createdCandidateIds } }, { jobOrderId: { in: createdJobOrderIds } }] },
    });
  }
  if (createdDocumentIds.length > 0) {
    await prisma.document.deleteMany({ where: { id: { in: createdDocumentIds } } });
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

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "F5.2test",
    lastName: `Candidate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    email: `f52test.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`,
    phone: `555-${Math.floor(1000000 + Math.random() * 8999999)}`,
    city: "Chicago",
    state: "IL",
    categoryIds: [REAL_CATEGORY_ID],
    ...overrides,
  };
}

async function createValidCandidate(overrides: Record<string, unknown> = {}, headers = RECRUITER_HEADERS) {
  const res = await fetch(`${baseUrl}/api/v1/candidates`, {
    method: "POST",
    headers,
    body: JSON.stringify(validPayload(overrides)),
  });
  const body = (await res.json()) as { id: string };
  if (res.status === 201) createdCandidateIds.push(body.id);
  return { res, body };
}

async function moveToQualified(id: string, headers = RECRUITER_HEADERS) {
  await fetch(`${baseUrl}/api/v1/candidates/${id}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "SCREENING" }),
  });
  await fetch(`${baseUrl}/api/v1/candidates/${id}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "QUALIFIED" }),
  });
}

// ---- Creación ----

test("POST /candidates as sales@titan.dev returns 403 (no candidates.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/candidates`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify(validPayload()),
  });
  assert.equal(res.status, 403);
});

test("POST /candidates as recruiter@titan.dev creates a real Candidate, always NEW", async () => {
  const { res, body } = (await createValidCandidate()) as { res: Response; body: { id: string; status: string } };
  assert.equal(res.status, 201);
  assert.equal(body.status, "NEW", "a new Candidate must always start as NEW");
});

test("createdById is taken from the tenancy context, never from the request body", async () => {
  const { res, body } = (await createValidCandidate({ createdById: "someone-else-entirely" })) as {
    res: Response;
    body: { id: string };
  };
  assert.equal(res.status, 201);

  const recruiterUser = await prisma.user.findFirstOrThrow({
    where: { tenantId: "tenant-titan", email: "recruiter@titan.dev" },
  });
  const detailRes = await fetch(`${baseUrl}/api/v1/candidates/${body.id}`, { headers: RECRUITER_HEADERS });
  const detail = (await detailRes.json()) as { createdById: string | null };
  assert.equal(detail.createdById, recruiterUser.id, "createdById must be the real authenticated user, never the body value");
});

test("the body cannot set status/tenantId/aiScore on creation — those fields simply don't exist in the input contract", async () => {
  const { res, body } = (await createValidCandidate({ status: "PLACED", tenantId: "some-other-tenant", aiScore: 99 })) as {
    res: Response;
    body: { id: string; status: string; aiScore: number | null };
  };
  assert.equal(res.status, 201);
  assert.equal(body.status, "NEW");
});

test("email is normalized (case-insensitive) and duplicate email is rejected with 409", async () => {
  const sharedEmail = `f52.dup.${Date.now()}@example.com`;
  const { res: firstRes } = await createValidCandidate({ email: sharedEmail.toLowerCase(), phone: undefined });
  assert.equal(firstRes.status, 201);

  const { res: dupRes, body: dupBody } = (await createValidCandidate({
    email: sharedEmail.toUpperCase(),
    phone: undefined,
  })) as unknown as { res: Response; body: { error: { details?: { existingCandidateId?: string } } } };
  assert.equal(dupRes.status, 409, "same email in different case must still be detected as a duplicate");
  assert.ok(dupBody.error.details?.existingCandidateId);
});

test("phone is normalized (spaces/dashes/parens/country code) and duplicate phone is rejected with 409", async () => {
  const digits = `312${Math.floor(1000000 + Math.random() * 8999999)}`.slice(0, 10);
  const { res: firstRes } = await createValidCandidate({ email: undefined, phone: `1-(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` });
  assert.equal(firstRes.status, 201);

  const { res: dupRes } = await createValidCandidate({ email: undefined, phone: `+1 ${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}` });
  assert.equal(dupRes.status, 409, "same phone with different formatting/country code must still be detected as a duplicate");
});

test("F8.4: same firstName+lastName+state with no email/phone in common is still rejected as a duplicate", async () => {
  const uniqueLastName = `Dedupe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { res: firstRes } = await createValidCandidate({
    firstName: "Jamie",
    lastName: uniqueLastName,
    email: undefined,
    phone: undefined,
    state: "IL",
  });
  assert.equal(firstRes.status, 201);

  const { res: dupRes, body: dupBody } = (await createValidCandidate({
    firstName: "  jamie  ",
    lastName: uniqueLastName.toLowerCase(),
    email: undefined,
    phone: undefined,
    state: "il",
  })) as unknown as { res: Response; body: { error: { details?: { existingCandidateId?: string } } } };
  assert.equal(dupRes.status, 409, "same name+state (case/space insensitive) with no email/phone must still be detected as a duplicate");
  assert.ok(dupBody.error.details?.existingCandidateId);
});

test("F8.4: same firstName+lastName but no state on either side is NOT treated as a duplicate (avoids common-name false positives)", async () => {
  const uniqueLastName = `NoState-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { res: firstRes } = await createValidCandidate({
    firstName: "Taylor",
    lastName: uniqueLastName,
    email: undefined,
    phone: undefined,
    state: undefined,
  });
  assert.equal(firstRes.status, 201);

  const { res: secondRes } = await createValidCandidate({
    firstName: "Taylor",
    lastName: uniqueLastName,
    email: undefined,
    phone: undefined,
    state: undefined,
  });
  assert.equal(secondRes.status, 201, "without a state on either record, name alone must not trigger a false-positive duplicate rejection");
});

test("invalid categoryId is rejected", async () => {
  const { res } = await createValidCandidate({ categoryIds: ["category-does-not-exist"] });
  assert.equal(res.status, 400);
});

test("empty firstName is rejected", async () => {
  const { res } = await createValidCandidate({ firstName: "" });
  assert.equal(res.status, 400);
});

// ---- Tenancy ----

test("a Candidate created under one tenant is invisible/not-found under another tenant context", async () => {
  const { body } = await createValidCandidate();

  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      await assert.rejects(() => getCandidateDetail(body.id), /Candidate not found/);
    },
  );
});

// ---- Detalle / listado ----

test("GET /candidates/:id returns the real detail, including categoryIds and createdByName", async () => {
  const { body } = await createValidCandidate();
  const detailRes = await fetch(`${baseUrl}/api/v1/candidates/${(body as { id: string }).id}`, {
    headers: RECRUITER_HEADERS,
  });
  const detail = (await detailRes.json()) as { status: string; createdByName: string | null; categoryIds: string[] };
  assert.equal(detailRes.status, 200);
  assert.equal(detail.status, "NEW");
  assert.ok(detail.createdByName);
  assert.deepEqual(detail.categoryIds, [REAL_CATEGORY_ID]);
});

test("GET /candidates/:id for a nonexistent id returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/v1/candidates/does-not-exist`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 404);
});

test("GET /candidates supports search by name", async () => {
  const { body } = await createValidCandidate({ lastName: `Uniquename${Date.now()}` });
  const search = (body as { id: string; lastName?: string }) as never as { id: string };
  const created = await prisma.candidate.findUniqueOrThrow({ where: { id: search.id } });

  const res = await fetch(`${baseUrl}/api/v1/candidates?search=${encodeURIComponent(created.lastName)}`, {
    headers: RECRUITER_HEADERS,
  });
  assert.equal(res.status, 200);
  const listBody = (await res.json()) as { items: Array<{ id: string }> };
  assert.ok(listBody.items.some((i) => i.id === created.id));
});

test("GET /candidates?isWorker=false and isWorker=true are interpreted correctly, not both as true (F5.3 regression)", async () => {
  const { body } = await createValidCandidate({ lastName: `IsWorkerCheck${Date.now()}` });
  const candidate = body as { id: string };

  const falseRes = await fetch(`${baseUrl}/api/v1/candidates?isWorker=false&limit=100`, { headers: RECRUITER_HEADERS });
  const falseBody = (await falseRes.json()) as { items: Array<{ id: string }> };
  assert.equal(falseRes.status, 200, JSON.stringify(falseBody));
  assert.ok(
    falseBody.items.some((i) => i.id === candidate.id),
    "isWorker=false must include a real Candidate that has no Worker",
  );

  const trueRes = await fetch(`${baseUrl}/api/v1/candidates?isWorker=true&limit=100`, { headers: RECRUITER_HEADERS });
  const trueBody = (await trueRes.json()) as { items: Array<{ id: string }> };
  assert.ok(
    !trueBody.items.some((i) => i.id === candidate.id),
    "isWorker=true must never include a Candidate that has no Worker",
  );
});

// ---- Edición ----

test("PATCH /candidates/:id edits allowed fields", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;

  const patchRes = await fetch(`${baseUrl}/api/v1/candidates/${id}`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ city: "Denver", state: "CO" }),
  });
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()) as { city: string | null; state: string | null };
  assert.equal(updated.city, "Denver");
  assert.equal(updated.state, "CO");
});

test("PATCH /candidates/:id silently ignores status/createdById/tenantId — protected fields never change", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;

  const patchRes = await fetch(`${baseUrl}/api/v1/candidates/${id}`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "PLACED", createdById: "hijacked", tenantId: "other" }),
  });
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()) as { status: string };
  assert.equal(updated.status, "NEW", "status must never change via the general PATCH");
});

// ---- Estados ----

test("valid transition NEW -> SCREENING succeeds", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  const res = await fetch(`${baseUrl}/api/v1/candidates/${id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "SCREENING" }),
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, "SCREENING");
});

test("invalid transition NEW -> QUALIFIED (skipping SCREENING) is rejected", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  const res = await fetch(`${baseUrl}/api/v1/candidates/${id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "QUALIFIED" }),
  });
  assert.equal(res.status, 400);
});

test("PATCH /candidates/:id/status can never set PLACED directly", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  await moveToQualified(id);

  const res = await fetch(`${baseUrl}/api/v1/candidates/${id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "PLACED" }),
  });
  assert.equal(res.status, 400, "PLACED must only be reachable via convert-to-worker, never PATCH /status");
});

test("status transition is idempotent: requesting the current status again succeeds without error", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  const res = await fetch(`${baseUrl}/api/v1/candidates/${id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "NEW" }),
  });
  assert.equal(res.status, 200);
});

test("REJECTED -> NEW reopening works and is logged distinctly as a reopen", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  await fetch(`${baseUrl}/api/v1/candidates/${id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "REJECTED" }),
  });

  const reopenRes = await fetch(`${baseUrl}/api/v1/candidates/${id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "NEW" }),
  });
  assert.equal(reopenRes.status, 200);

  const audit = await prisma.auditLog.findFirst({
    where: { entityType: "candidate", entityId: id, action: "candidate.reopened" },
  });
  assert.ok(audit, "reopening must be logged as candidate.reopened, not a generic status_changed");
});

test("REJECTED -> QUALIFIED direct jump is rejected (must reopen to NEW first)", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  await fetch(`${baseUrl}/api/v1/candidates/${id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "REJECTED" }),
  });
  const res = await fetch(`${baseUrl}/api/v1/candidates/${id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "QUALIFIED" }),
  });
  assert.equal(res.status, 400);
});

// ---- Conversión a Worker ----

test("POST /candidates/:id/convert-to-worker as recruiter@titan.dev returns 403 (has candidates.update but not workers.create)", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  await moveToQualified(id);

  const res = await fetch(`${baseUrl}/api/v1/candidates/${id}/convert-to-worker`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ employmentType: "W2", defaultPayRate: 18.5 }),
  });
  assert.equal(res.status, 403);
});

test("converting a non-QUALIFIED Candidate (still NEW) is rejected", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;

  const res = await fetch(`${baseUrl}/api/v1/candidates/${id}/convert-to-worker`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ employmentType: "W2", defaultPayRate: 18.5 }),
  });
  assert.equal(res.status, 400);
});

test("CEO converts a QUALIFIED Candidate to Worker: real Worker created, Candidate becomes PLACED, no Assignment/PayrollItem created", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  await moveToQualified(id);

  const res = await fetch(`${baseUrl}/api/v1/candidates/${id}/convert-to-worker`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ employmentType: "C1099", defaultPayRate: 22.75 }),
  });
  assert.equal(res.status, 201);
  const result = (await res.json()) as {
    worker: { id: string; employmentType: string; defaultPayRate: string; status: string; complianceStatus: string };
    alreadyConverted: boolean;
  };
  createdWorkerIds.push(result.worker.id);
  assert.equal(result.alreadyConverted, false);
  assert.equal(result.worker.employmentType, "C1099");
  assert.equal(Number(result.worker.defaultPayRate), 22.75);
  assert.equal(result.worker.status, "AVAILABLE");
  assert.equal(result.worker.complianceStatus, "PENDING");

  const candidateDetailRes = await fetch(`${baseUrl}/api/v1/candidates/${id}`, { headers: CEO_HEADERS });
  const candidateDetail = (await candidateDetailRes.json()) as { status: string; workerId: string | null };
  assert.equal(candidateDetail.status, "PLACED");
  assert.equal(candidateDetail.workerId, result.worker.id);

  const assignmentCount = await prisma.assignment.count({ where: { workerId: result.worker.id } });
  const payrollItemCount = await prisma.payrollItem.count({ where: { workerId: result.worker.id } });
  assert.equal(assignmentCount, 0, "conversion must never create an Assignment");
  assert.equal(payrollItemCount, 0, "conversion must never create a PayrollItem");

  const workerDetailRes = await fetch(`${baseUrl}/api/v1/workers/${result.worker.id}`, { headers: CEO_HEADERS });
  assert.equal(workerDetailRes.status, 200);
  const workerDetail = (await workerDetailRes.json()) as { candidateId: string; candidateName: string };
  assert.equal(workerDetail.candidateId, id);
  assert.ok(workerDetail.candidateName.length > 0);
});

test("converting an already-converted Candidate is idempotent — returns the same Worker, never creates a second one", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  await moveToQualified(id);

  const firstRes = await fetch(`${baseUrl}/api/v1/candidates/${id}/convert-to-worker`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ employmentType: "W2", defaultPayRate: 19 }),
  });
  const firstBody = (await firstRes.json()) as { worker: { id: string } };
  createdWorkerIds.push(firstBody.worker.id);

  const secondRes = await fetch(`${baseUrl}/api/v1/candidates/${id}/convert-to-worker`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ employmentType: "C1099", defaultPayRate: 999 }),
  });
  assert.equal(secondRes.status, 201);
  const secondBody = (await secondRes.json()) as { worker: { id: string; employmentType: string }; alreadyConverted: boolean };
  assert.equal(secondBody.alreadyConverted, true);
  assert.equal(secondBody.worker.id, firstBody.worker.id, "must return the existing Worker, never a new one");
  assert.equal(secondBody.worker.employmentType, "W2", "the second body (C1099/999) must be ignored entirely");

  const workerCount = await prisma.worker.count({ where: { candidateId: id } });
  assert.equal(workerCount, 1, "exactly one Worker must exist for this Candidate, never two");
});

test("converting a Candidate from another tenant context fails (tenancy respected)", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  await moveToQualified(id);

  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      await assert.rejects(
        () => convertCandidateToWorker(id, { employmentType: "W2", defaultPayRate: 20 }),
        /Candidate not found/,
      );
    },
  );
});

test("a failure mid-transaction rolls back completely — no orphan Worker, Candidate status unchanged", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  await moveToQualified(id);

  // F5.2: 9 dígitos enteros excede la precisión de Worker.defaultPayRate
  // (Decimal(10,2) → máximo 8 dígitos enteros) — Postgres rechaza el
  // INSERT con un error real de overflow numérico DENTRO de la
  // transacción, sin necesidad de mockear nada.
  const res = await fetch(`${baseUrl}/api/v1/candidates/${id}/convert-to-worker`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ employmentType: "W2", defaultPayRate: 123456789.5 }),
  });
  assert.notEqual(res.status, 201, "an overflowing defaultPayRate must not succeed");

  const workerCount = await prisma.worker.count({ where: { candidateId: id } });
  assert.equal(workerCount, 0, "no Worker row must survive a rolled-back transaction");

  const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id } });
  assert.equal(candidate.status, "QUALIFIED", "Candidate status must remain unchanged when the transaction rolls back");
});

// ---- Activity + AuditLog ----

test("creating a Candidate writes both an Activity and an AuditLog entry", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;

  const activity = await prisma.activity.findFirst({ where: { entityType: "candidate", entityId: id, subject: { contains: "created" } } });
  assert.ok(activity, "Activity row for candidate.created must exist");

  const audit = await prisma.auditLog.findFirst({ where: { entityType: "candidate", entityId: id, action: "candidate.created" } });
  assert.ok(audit, "AuditLog row for candidate.created must exist");
});

test("converting to Worker writes an AuditLog entry without PII in metadata", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  await moveToQualified(id);

  const convertRes = await fetch(`${baseUrl}/api/v1/candidates/${id}/convert-to-worker`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ employmentType: "W2", defaultPayRate: 21 }),
  });
  const convertBody = (await convertRes.json()) as { worker: { id: string } };
  createdWorkerIds.push(convertBody.worker.id);

  const audit = await prisma.auditLog.findFirst({
    where: { entityType: "candidate", entityId: id, action: "candidate.converted_to_worker" },
  });
  assert.ok(audit);
  assert.deepEqual(audit?.before, { status: "QUALIFIED" });
  assert.deepEqual(audit?.after, { status: "PLACED", workerId: convertBody.worker.id });
  const serialized = JSON.stringify(audit);
  assert.ok(!serialized.includes("F5.2test"), "AuditLog metadata must never contain the candidate's name (PII)");
});

test("a repeated (duplicate) conversion attempt is also logged, without creating a second AuditLog for a real conversion", async () => {
  const { body } = await createValidCandidate();
  const id = (body as { id: string }).id;
  await moveToQualified(id);

  const firstRes = await fetch(`${baseUrl}/api/v1/candidates/${id}/convert-to-worker`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ employmentType: "W2", defaultPayRate: 20 }),
  });
  const firstBody = (await firstRes.json()) as { worker: { id: string } };
  createdWorkerIds.push(firstBody.worker.id);

  await fetch(`${baseUrl}/api/v1/candidates/${id}/convert-to-worker`, {
    method: "POST",
    headers: CEO_HEADERS,
    body: JSON.stringify({ employmentType: "W2", defaultPayRate: 20 }),
  });

  const duplicateAttemptAudit = await prisma.auditLog.findFirst({
    where: { entityType: "candidate", entityId: id, action: "candidate.convert_to_worker_duplicate_attempt" },
  });
  assert.ok(duplicateAttemptAudit, "a repeated conversion attempt must be audited");

  const realConversionAuditCount = await prisma.auditLog.count({
    where: { entityType: "candidate", entityId: id, action: "candidate.converted_to_worker" },
  });
  assert.equal(realConversionAuditCount, 1, "only the first, real conversion writes candidate.converted_to_worker");
});

// ---------- F8.2: Job Requirements and Qualification Rules ----------

async function createValidJobOrder(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({
      companyId: REAL_COMPANY_ID,
      categoryId: REAL_FORKLIFT_CATEGORY_ID,
      title: "F8.2 test — Forklift Operator",
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

test("GET /candidates/:id/qualification/:jobOrderId as sales@titan.dev returns 403 (no candidates.view)", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}`, { headers: SALES_HEADERS });
  assert.equal(res.status, 403);
});

test("candidato sin documento requerido -> missing_required_document, nunca cambia Candidate.status", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 200);
  const result = (await res.json()) as { hardDisqualifiers: string[]; missingDocuments: string[] };
  assert.ok(result.hardDisqualifiers.includes("missing_required_document:forklift_cert"));
  assert.ok(result.missingDocuments.includes("forklift_cert"));

  const stillNew = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
  assert.equal(stillNew.status, "NEW", "evaluar calificación nunca debe cambiar Candidate.status");
});

test("candidato con documento requerido VERIFIED y vigente -> sin disqualifiers de documento", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const documentType = await prisma.documentType.findFirstOrThrow({ where: { key: "forklift_cert" } });
  const document = await prisma.document.create({
    data: {
      tenantId: (await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).tenantId,
      candidateId: candidate.id,
      documentTypeId: documentType.id,
      status: "VERIFIED",
    },
  });
  createdDocumentIds.push(document.id);

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 200);
  const result = (await res.json()) as { hardDisqualifiers: string[] };
  assert.ok(!result.hardDisqualifiers.some((d) => d.startsWith("missing_required_document") || d.startsWith("document_expired")));
});

test("candidato con categoria distinta a la del Job Order -> category_mismatch", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}`, { headers: RECRUITER_HEADERS });
  const result = (await res.json()) as { hardDisqualifiers: string[] };
  assert.ok(result.hardDisqualifiers.includes("category_mismatch"));
});

// ---------- F8.5: Estados de calificación con razones auditables ----------

test("POST /candidates/:id/qualification/:jobOrderId as sales@titan.dev returns 403 (no candidates.update)", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}`, {
    method: "POST",
    headers: SALES_HEADERS,
  });
  assert.equal(res.status, 403);
});

test("POST persists NOT_QUALIFIED for a category mismatch, with auditable reasons, and never changes Candidate.status", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    status: string;
    reasons: string[];
    hardDisqualifiers: string[];
    candidateId: string;
    jobOrderId: string;
  };
  assert.equal(body.status, "NOT_QUALIFIED");
  assert.ok(body.hardDisqualifiers.includes("category_mismatch"));
  assert.ok(body.reasons.length > 0, "reasons must be auditable, never empty when disqualified");

  const stillNew = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
  assert.equal(stillNew.status, "NEW", "persisting a qualification must never change Candidate.status");

  const persisted = await prisma.candidateQualification.findUniqueOrThrow({
    where: { candidateId_jobOrderId: { candidateId: candidate.id, jobOrderId: jobOrder.id } },
  });
  assert.equal(persisted.status, "NOT_QUALIFIED");
});

test("POST persists NEEDS_REVIEW when the only disqualifier is a missing required document", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "NEEDS_REVIEW");
});

test("POST persists QUALIFIED when all requirements are met, and re-running upserts the same row instead of creating a second one", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const documentType = await prisma.documentType.findFirstOrThrow({ where: { key: "forklift_cert" } });
  const document = await prisma.document.create({
    data: {
      tenantId: (await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).tenantId,
      candidateId: candidate.id,
      documentTypeId: documentType.id,
      status: "VERIFIED",
    },
  });
  createdDocumentIds.push(document.id);

  const firstRes = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  assert.equal(firstRes.status, 201);
  const firstBody = (await firstRes.json()) as { id: string; status: string };
  assert.equal(firstBody.status, "QUALIFIED");

  const secondRes = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  assert.equal(secondRes.status, 201);
  const secondBody = (await secondRes.json()) as { id: string; status: string };
  assert.equal(secondBody.id, firstBody.id, "re-evaluating the same pair must upsert, never create a second row");

  const count = await prisma.candidateQualification.count({
    where: { candidateId: candidate.id, jobOrderId: jobOrder.id },
  });
  assert.equal(count, 1);
});

test("GET .../status returns the persisted record without re-evaluating, and 404s when nothing was persisted yet", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  const notYetRes = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}/status`, {
    headers: RECRUITER_HEADERS,
  });
  assert.equal(notYetRes.status, 404);

  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });

  const afterRes = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}/status`, {
    headers: RECRUITER_HEADERS,
  });
  assert.equal(afterRes.status, 200);
  const body = (await afterRes.json()) as { candidateId: string; jobOrderId: string; status: string };
  assert.equal(body.candidateId, candidate.id);
  assert.equal(body.jobOrderId, jobOrder.id);
});

test("persisting a qualification writes an AuditLog entry", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/qualification/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });

  const auditEntry = await prisma.auditLog.findFirst({
    where: { action: "candidate.qualification_evaluated", entityType: "candidate_qualification" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(auditEntry);
});

// ---------- F8.6: Matching and Ranking ----------

test("POST /job-orders/:jobOrderId/matching as sales@titan.dev returns 403 (no candidates.update)", async () => {
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: SALES_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /job-orders/:jobOrderId/matching returns 404 before any matching run has been computed", async () => {
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 404);
});

test("POST computes matching: NOT_QUALIFIED (wrong category) is excluded and never ranked, qualified candidate is ranked, never changes Candidate.status", async () => {
  const jobOrder = await createValidJobOrder();
  const documentType = await prisma.documentType.findFirstOrThrow({ where: { key: "forklift_cert" } });

  const { body: qualified } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID], state: "IL" });
  const document = await prisma.document.create({
    data: {
      tenantId: (await prisma.candidate.findUniqueOrThrow({ where: { id: qualified.id } })).tenantId,
      candidateId: qualified.id,
      documentTypeId: documentType.id,
      status: "VERIFIED",
    },
  });
  createdDocumentIds.push(document.id);

  const { body: wrongCategory } = await createValidCandidate({ categoryIds: [REAL_CATEGORY_ID] });

  const res = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    ranked: Array<{ candidateId: string; rank: number; qualificationStatus: string }>;
    excluded: Array<{ candidateId: string; rank: number | null; qualificationStatus: string }>;
  };

  assert.ok(body.ranked.some((r) => r.candidateId === qualified.id && r.qualificationStatus === "QUALIFIED"));
  assert.ok(!body.ranked.some((r) => r.candidateId === wrongCategory.id), "a NOT_QUALIFIED candidate must never appear in ranked");

  const stillNew = await prisma.candidate.findUniqueOrThrow({ where: { id: qualified.id } });
  assert.equal(stillNew.status, "NEW", "computing matching must never change Candidate.status");
});

test("POST is idempotent: re-running upserts the same CandidateMatch row instead of creating a second one", async () => {
  const jobOrder = await createValidJobOrder();
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });

  const firstRes = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });
  assert.equal(firstRes.status, 201);
  const secondRes = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });
  assert.equal(secondRes.status, 201);

  const count = await prisma.candidateMatch.count({ where: { candidateId: candidate.id, jobOrderId: jobOrder.id } });
  assert.equal(count, 1);
});

test("GET returns the persisted ranking without recomputing, sorted by rank", async () => {
  const jobOrder = await createValidJobOrder();
  await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });

  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });

  const res = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ranked: Array<{ rank: number }> };
  const ranks = body.ranked.map((r) => r.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "ranked results must come back sorted by rank ascending");
});

test("computing matching writes an AuditLog entry", async () => {
  const jobOrder = await createValidJobOrder();
  await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });

  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });

  const auditEntry = await prisma.auditLog.findFirst({
    where: { action: "candidate.matching_computed", entityType: "job_order_matching", entityId: jobOrder.id },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(auditEntry);
});

// ---------- F8.7: Candidate Shortlist ----------

test("POST /job-orders/:jobOrderId/shortlist as sales@titan.dev returns 403 (no candidates.update)", async () => {
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { method: "POST", headers: SALES_HEADERS });
  assert.equal(res.status, 403);
});

test("POST /job-orders/:jobOrderId/shortlist returns 404 when matching was never run for this Job Order (enforces pipeline order)", async () => {
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { method: "POST", headers: RECRUITER_HEADERS });
  assert.equal(res.status, 404);
});

test("POST generates a shortlist from the persisted ranking, never includes a NOT_QUALIFIED candidate, never changes Candidate.status", async () => {
  const jobOrder = await createValidJobOrder();
  const { body: qualified } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const { body: wrongCategory } = await createValidCandidate({ categoryIds: [REAL_CATEGORY_ID] });

  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });

  const res = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { method: "POST", headers: RECRUITER_HEADERS });
  assert.equal(res.status, 201);
  const body = (await res.json()) as Array<{ candidateId: string; reviewStatus: string; rank: number }>;

  assert.ok(body.some((e) => e.candidateId === qualified.id));
  assert.ok(!body.some((e) => e.candidateId === wrongCategory.id), "a NOT_QUALIFIED candidate must never be shortlisted");
  assert.ok(body.every((e) => e.reviewStatus === "DRAFT"), "a freshly generated shortlist entry always starts at DRAFT");

  const stillNew = await prisma.candidate.findUniqueOrThrow({ where: { id: qualified.id } });
  assert.equal(stillNew.status, "NEW", "generating a shortlist must never change Candidate.status");
});

test("POST is idempotent and preserves a manually-set reviewStatus on regeneration", async () => {
  const jobOrder = await createValidJobOrder();
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });

  // Nota: la categoría forklift ya tiene candidatos del seed de F0 en
  // este tenant, así que la shortlist tiene más de una entrada -- hay
  // que ubicar la entrada de ESTE candidato específico, nunca asumir
  // que es la primera del arreglo.
  const firstRes = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { method: "POST", headers: RECRUITER_HEADERS });
  const firstBody = (await firstRes.json()) as Array<{ id: string; candidateId: string }>;
  const entry = firstBody.find((e) => e.candidateId === candidate.id);
  assert.ok(entry);

  const patchRes = await fetch(`${baseUrl}/api/v1/shortlist/${entry!.id}/review-status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ reviewStatus: "READY_FOR_REVIEW" }),
  });
  assert.equal(patchRes.status, 200);

  // Regenerar no debe revertir la decisión humana ya tomada.
  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { method: "POST", headers: RECRUITER_HEADERS });

  const count = await prisma.candidateShortlistEntry.count({ where: { candidateId: candidate.id, jobOrderId: jobOrder.id } });
  assert.equal(count, 1, "regenerating must upsert, never duplicate");

  const refreshed = await prisma.candidateShortlistEntry.findFirstOrThrow({ where: { candidateId: candidate.id, jobOrderId: jobOrder.id } });
  assert.equal(refreshed.reviewStatus, "READY_FOR_REVIEW", "a manually-set reviewStatus must survive regeneration");
});

test("PATCH review-status rejects an invalid transition (DRAFT -> APPROVED, must pass through READY_FOR_REVIEW)", async () => {
  const jobOrder = await createValidJobOrder();
  await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });
  const shortlistRes = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { method: "POST", headers: RECRUITER_HEADERS });
  const [entry] = (await shortlistRes.json()) as Array<{ id: string }>;
  assert.ok(entry);

  const res = await fetch(`${baseUrl}/api/v1/shortlist/${entry.id}/review-status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ reviewStatus: "APPROVED" }),
  });
  assert.equal(res.status, 400);
});

test("PATCH review-status: REMOVED is reversible -- can reopen to DRAFT, never a permanent rejection", async () => {
  const jobOrder = await createValidJobOrder();
  await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });
  const shortlistRes = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { method: "POST", headers: RECRUITER_HEADERS });
  const [entry] = (await shortlistRes.json()) as Array<{ id: string }>;
  assert.ok(entry);

  const removeRes = await fetch(`${baseUrl}/api/v1/shortlist/${entry.id}/review-status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ reviewStatus: "REMOVED" }),
  });
  assert.equal(removeRes.status, 200);

  const reopenRes = await fetch(`${baseUrl}/api/v1/shortlist/${entry.id}/review-status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ reviewStatus: "DRAFT" }),
  });
  assert.equal(reopenRes.status, 200);
});

test("PATCH review-status rejects an invalid reviewStatus value with 400", async () => {
  const jobOrder = await createValidJobOrder();
  await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });
  const shortlistRes = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { method: "POST", headers: RECRUITER_HEADERS });
  const [entry] = (await shortlistRes.json()) as Array<{ id: string }>;
  assert.ok(entry);

  const res = await fetch(`${baseUrl}/api/v1/shortlist/${entry.id}/review-status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ reviewStatus: "NOT_A_REAL_STATUS" }),
  });
  assert.equal(res.status, 400);
});

test("GET /job-orders/:jobOrderId/shortlist returns the persisted shortlist sorted by rank", async () => {
  const jobOrder = await createValidJobOrder();
  await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });
  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { method: "POST", headers: RECRUITER_HEADERS });

  const res = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ rank: number }>;
  const ranks = body.map((e) => e.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("shortlist generation and review-status changes write AuditLog entries", async () => {
  const jobOrder = await createValidJobOrder();
  await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });
  const shortlistRes = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { method: "POST", headers: RECRUITER_HEADERS });
  const [entry] = (await shortlistRes.json()) as Array<{ id: string }>;
  assert.ok(entry);

  await fetch(`${baseUrl}/api/v1/shortlist/${entry.id}/review-status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ reviewStatus: "READY_FOR_REVIEW" }),
  });

  const generatedAudit = await prisma.auditLog.findFirst({
    where: { action: "candidate.shortlist_generated", entityType: "job_order_shortlist", entityId: jobOrder.id },
  });
  const statusAudit = await prisma.auditLog.findFirst({
    where: { action: "candidate.shortlist_review_status_changed", entityType: "candidate_shortlist_entry", entityId: entry.id },
  });
  assert.ok(generatedAudit);
  assert.ok(statusAudit);
});

// ---------- F8.8: Screening Intelligence ----------

test("POST /candidates/:id/screening-plan/:jobOrderId as sales@titan.dev returns 403 (no candidates.update)", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/screening-plan/${jobOrder.id}`, { method: "POST", headers: SALES_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /candidates/:id/screening-plan/:jobOrderId returns 404 before any plan has been generated", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/screening-plan/${jobOrder.id}`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 404);
});

test("POST generates a real screening plan with baseline questions, real category name, and a document_readiness question when a required document is missing", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/screening-plan/${jobOrder.id}`, { method: "POST", headers: RECRUITER_HEADERS });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    questions: Array<{ id: string; question: string }>;
    manualReviewFlags: string[];
    missingInformation: string[];
    allowedDisqualifiers: string[];
  };

  assert.ok(body.questions.some((q) => q.id === "availability_start_date"));
  assert.ok(body.questions.some((q) => q.id === "document_readiness"));
  assert.ok(body.questions.some((q) => q.question.includes("Forklift Operator")));
  assert.ok(body.manualReviewFlags.length > 0, "missing forklift_cert must trigger NEEDS_REVIEW manual flag");
  assert.ok(body.allowedDisqualifiers.includes("category_mismatch"));

  const stillNew = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
  assert.equal(stillNew.status, "NEW", "generating a screening plan must never change Candidate.status");
});

test("POST is idempotent: re-running upserts the same ScreeningPlan row instead of creating a second one", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  const firstRes = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/screening-plan/${jobOrder.id}`, { method: "POST", headers: RECRUITER_HEADERS });
  assert.equal(firstRes.status, 201);
  const secondRes = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/screening-plan/${jobOrder.id}`, { method: "POST", headers: RECRUITER_HEADERS });
  assert.equal(secondRes.status, 201);

  const count = await prisma.screeningPlan.count({ where: { candidateId: candidate.id, jobOrderId: jobOrder.id } });
  assert.equal(count, 1);
});

test("GET returns the persisted plan without regenerating", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/screening-plan/${jobOrder.id}`, { method: "POST", headers: RECRUITER_HEADERS });

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/screening-plan/${jobOrder.id}`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { candidateId: string; jobOrderId: string };
  assert.equal(body.candidateId, candidate.id);
  assert.equal(body.jobOrderId, jobOrder.id);
});

test("generating a screening plan writes an AuditLog entry", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/screening-plan/${jobOrder.id}`, { method: "POST", headers: RECRUITER_HEADERS });
  const body = (await res.json()) as { id: string };

  const auditEntry = await prisma.auditLog.findFirst({
    where: { action: "candidate.screening_plan_generated", entityType: "screening_plan", entityId: body.id },
  });
  assert.ok(auditEntry);
});

// ---------- F8.9: Interview Scheduling Preview ----------

function validInterviewPreviewPayload(overrides: Record<string, unknown> = {}) {
  return {
    proposedWindows: [{ start: "2026-08-01T15:00:00.000Z", end: "2026-08-01T15:30:00.000Z" }],
    durationMinutes: 30,
    timezone: "America/Chicago",
    modality: "PHONE",
    participants: [{ role: "recruiter", name: "Recruiter One" }],
    ...overrides,
  };
}

test("POST /candidates/:id/interview-preview/:jobOrderId as sales@titan.dev returns 403 (no candidates.update)", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrder.id}`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify(validInterviewPreviewPayload()),
  });
  assert.equal(res.status, 403);
});

test("GET /candidates/:id/interview-preview/:jobOrderId returns 404 before any preview has been generated", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrder.id}`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 404);
});

test("POST rejects a malformed body (missing proposedWindows) with 400", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify(validInterviewPreviewPayload({ proposedWindows: undefined })),
  });
  assert.equal(res.status, 400);
});

test("POST generates a real preview with status READY_FOR_APPROVAL when complete, availabilityConfirmed always false, never changes Candidate.status", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify(validInterviewPreviewPayload()),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { status: string; availabilityConfirmed: boolean };
  assert.equal(body.status, "READY_FOR_APPROVAL");
  assert.equal(body.availabilityConfirmed, false);

  const stillNew = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
  assert.equal(stillNew.status, "NEW", "generating an interview preview must never change Candidate.status");
});

test("POST with no proposed windows returns NEEDS_AVAILABILITY", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify(validInterviewPreviewPayload({ proposedWindows: [] })),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "NEEDS_AVAILABILITY");
});

test("POST detects a real conflict against another persisted preview for the same candidate on a different Job Order", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrderA = await createValidJobOrder();
  const jobOrderB = await createValidJobOrder();

  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrderA.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify(validInterviewPreviewPayload()),
  });

  const overlappingRes = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrderB.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify(
      validInterviewPreviewPayload({ proposedWindows: [{ start: "2026-08-01T15:15:00.000Z", end: "2026-08-01T15:45:00.000Z" }] }),
    ),
  });
  assert.equal(overlappingRes.status, 201);
  const body = (await overlappingRes.json()) as { status: string; conflicts: unknown[] };
  assert.equal(body.status, "DRAFT", "a real scheduling conflict must prevent READY_FOR_APPROVAL");
  assert.equal(body.conflicts.length, 1);
});

test("POST is idempotent: re-running upserts the same InterviewPreview row instead of creating a second one", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify(validInterviewPreviewPayload()),
  });
  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify(validInterviewPreviewPayload()),
  });

  const count = await prisma.interviewPreview.count({ where: { candidateId: candidate.id, jobOrderId: jobOrder.id } });
  assert.equal(count, 1);
});

test("PATCH status: READY_FOR_APPROVAL -> APPROVED_FOR_SEND is a valid human approval, DRAFT -> APPROVED_FOR_SEND is rejected", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const readyJobOrder = await createValidJobOrder();
  const draftJobOrder = await createValidJobOrder();

  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${readyJobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify(validInterviewPreviewPayload()),
  });
  const approveRes = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${readyJobOrder.id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "APPROVED_FOR_SEND" }),
  });
  assert.equal(approveRes.status, 200);

  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${draftJobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify(validInterviewPreviewPayload({ proposedWindows: [] })),
  });
  const invalidRes = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${draftJobOrder.id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "APPROVED_FOR_SEND" }),
  });
  assert.equal(invalidRes.status, 400, "NEEDS_AVAILABILITY must never jump directly to APPROVED_FOR_SEND");
});

test("generating a preview and changing its status write AuditLog entries", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify(validInterviewPreviewPayload()),
  });
  const body = (await res.json()) as { id: string };

  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrder.id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "APPROVED_FOR_SEND" }),
  });

  const generatedAudit = await prisma.auditLog.findFirst({
    where: { action: "candidate.interview_preview_generated", entityType: "interview_preview", entityId: body.id },
  });
  const statusAudit = await prisma.auditLog.findFirst({
    where: { action: "candidate.interview_preview_status_changed", entityType: "interview_preview", entityId: body.id },
  });
  assert.ok(generatedAudit);
  assert.ok(statusAudit);
});

// ---------- F8.10: Placement Readiness ----------

test("POST /candidates/:id/placement-readiness/:jobOrderId as sales@titan.dev returns 403 (no candidates.update)", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/placement-readiness/${jobOrder.id}`, {
    method: "POST",
    headers: SALES_HEADERS,
  });
  assert.equal(res.status, 403);
});

test("GET /candidates/:id/placement-readiness/:jobOrderId returns 404 before any evaluation has been run", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/placement-readiness/${jobOrder.id}`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 404);
});

test("POST evaluates NOT_READY for a NOT_QUALIFIED candidate (wrong category), requiresApproval always true, never changes Candidate.status", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/placement-readiness/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { readinessStatus: string; requiresApproval: boolean; blockers: string[] };
  assert.equal(body.readinessStatus, "NOT_READY");
  assert.equal(body.requiresApproval, true);
  assert.ok(body.blockers.length > 0);

  const stillNew = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
  assert.equal(stillNew.status, "NEW", "evaluating placement readiness must never change Candidate.status");
});

test("POST evaluates CONDITIONALLY_READY for a QUALIFIED candidate with no shortlist/screening/interview yet (pending, not blocked)", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const documentType = await prisma.documentType.findFirstOrThrow({ where: { key: "forklift_cert" } });
  const document = await prisma.document.create({
    data: {
      tenantId: (await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).tenantId,
      candidateId: candidate.id,
      documentTypeId: documentType.id,
      status: "VERIFIED",
    },
  });
  createdDocumentIds.push(document.id);

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/placement-readiness/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { readinessStatus: string; pendingChecks: string[] };
  assert.equal(body.readinessStatus, "CONDITIONALLY_READY");
  assert.ok(body.pendingChecks.includes("shortlist"));
});

test("POST reaches READY_FOR_APPROVAL once qualification, shortlist, screening, and interview are all complete", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID], state: "IL" });
  const jobOrder = await createValidJobOrder({ startDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString() });
  const documentType = await prisma.documentType.findFirstOrThrow({ where: { key: "forklift_cert" } });
  const document = await prisma.document.create({
    data: {
      tenantId: (await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).tenantId,
      candidateId: candidate.id,
      documentTypeId: documentType.id,
      status: "VERIFIED",
    },
  });
  createdDocumentIds.push(document.id);

  await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/matching`, { method: "POST", headers: RECRUITER_HEADERS });
  const shortlistRes = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/shortlist`, { method: "POST", headers: RECRUITER_HEADERS });
  const shortlistBody = (await shortlistRes.json()) as Array<{ id: string; candidateId: string }>;
  const entry = shortlistBody.find((e) => e.candidateId === candidate.id);
  assert.ok(entry);
  await fetch(`${baseUrl}/api/v1/shortlist/${entry!.id}/review-status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ reviewStatus: "READY_FOR_REVIEW" }),
  });
  await fetch(`${baseUrl}/api/v1/shortlist/${entry!.id}/review-status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ reviewStatus: "APPROVED" }),
  });

  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/screening-plan/${jobOrder.id}`, { method: "POST", headers: RECRUITER_HEADERS });

  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({
      proposedWindows: [{ start: "2026-08-01T15:00:00.000Z", end: "2026-08-01T15:30:00.000Z" }],
      durationMinutes: 30,
      timezone: "America/Chicago",
      modality: "PHONE",
      participants: [{ role: "recruiter", name: "Recruiter One" }],
    }),
  });
  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/interview-preview/${jobOrder.id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "APPROVED_FOR_SEND" }),
  });

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/placement-readiness/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { readinessStatus: string; score: number; missingInformation: string[] };
  assert.equal(body.readinessStatus, "READY_FOR_APPROVAL");
  assert.equal(body.score, 100);
  assert.ok(body.missingInformation.some((m) => m.includes("compensación")), "compensation data absence must always be documented, never invented");
});

test("POST is idempotent: re-running upserts the same PlacementReadiness row instead of creating a second one", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();

  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/placement-readiness/${jobOrder.id}`, { method: "POST", headers: RECRUITER_HEADERS });
  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/placement-readiness/${jobOrder.id}`, { method: "POST", headers: RECRUITER_HEADERS });

  const count = await prisma.placementReadiness.count({ where: { candidateId: candidate.id, jobOrderId: jobOrder.id } });
  assert.equal(count, 1);
});

test("GET returns the persisted evaluation without recomputing", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/placement-readiness/${jobOrder.id}`, { method: "POST", headers: RECRUITER_HEADERS });

  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/placement-readiness/${jobOrder.id}`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { candidateId: string; jobOrderId: string };
  assert.equal(body.candidateId, candidate.id);
  assert.equal(body.jobOrderId, jobOrder.id);
});

test("evaluating placement readiness writes an AuditLog entry", async () => {
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/placement-readiness/${jobOrder.id}`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
  });
  const body = (await res.json()) as { id: string };

  const auditEntry = await prisma.auditLog.findFirst({
    where: { action: "candidate.placement_readiness_evaluated", entityType: "placement_readiness", entityId: body.id },
  });
  assert.ok(auditEntry);
});

// ---------- F8.3: Candidate Sourcing ----------

test("GET /job-orders/:jobOrderId/source-candidates as sales@titan.dev returns 403 (no candidates.view)", async () => {
  const jobOrder = await createValidJobOrder();
  const res = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/source-candidates`, { headers: SALES_HEADERS });
  assert.equal(res.status, 403);
});

test("sourcing incluye un candidato existente con la categoria correcta, excluye uno con categoria distinta, nunca crea ni contacta a nadie", async () => {
  const jobOrder = await createValidJobOrder();
  const { body: matching } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID], state: "IL" });
  const { body: nonMatching } = await createValidCandidate({ categoryIds: [REAL_CATEGORY_ID], state: "IL" });

  const res = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/source-candidates`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 200);
  const result = (await res.json()) as {
    sourced: Array<{ candidateId: string; relevanceScore: number; reasons: string[] }>;
    excluded: Array<{ candidateId: string; reason: string }>;
  };

  assert.ok(result.sourced.some((s) => s.candidateId === matching.id));
  assert.ok(!result.sourced.some((s) => s.candidateId === nonMatching.id));

  const stillNew = await prisma.candidate.findUniqueOrThrow({ where: { id: matching.id } });
  assert.equal(stillNew.status, "NEW", "sourcing nunca debe cambiar Candidate.status");
});

test("sourcing excluye un candidato REJECTED aunque su categoria coincida", async () => {
  const jobOrder = await createValidJobOrder();
  const { body: candidate } = await createValidCandidate({ categoryIds: [REAL_FORKLIFT_CATEGORY_ID] });
  await fetch(`${baseUrl}/api/v1/candidates/${candidate.id}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "REJECTED" }),
  });

  const res = await fetch(`${baseUrl}/api/v1/job-orders/${jobOrder.id}/source-candidates`, { headers: RECRUITER_HEADERS });
  const result = (await res.json()) as { sourced: Array<{ candidateId: string }>; excluded: Array<{ candidateId: string }> };
  assert.ok(!result.sourced.some((s) => s.candidateId === candidate.id));
  assert.ok(result.excluded.some((e) => e.candidateId === candidate.id));
});
