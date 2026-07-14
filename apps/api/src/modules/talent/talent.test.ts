import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createApp } from "../../app";
import { createCandidate, convertCandidateToWorker, getCandidateDetail } from "./service";

let server: Server;
let baseUrl: string;

const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };
const CEO_HEADERS = { "x-dev-user": "ceo@titan.dev", "content-type": "application/json" };

// F5.2: registro real del seed de F0 — no se inventan IDs.
const REAL_CATEGORY_ID = "category-general-labor";

const createdCandidateIds: string[] = [];
const createdWorkerIds: string[] = [];

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
  // F5.2: limpieza — todo lo creado por esta suite queda claramente
  // identificado (nombre/prefijo de test) y se borra al terminar.
  if (createdWorkerIds.length > 0) {
    await prisma.worker.deleteMany({ where: { id: { in: createdWorkerIds } } });
  }
  if (createdCandidateIds.length > 0) {
    await prisma.candidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
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
