// F10.5: Profile and Document UX -- PATCH /portal/{worker,candidate}/profile
// (whitelist self-service, nunca campos internos) y POST
// /portal/{worker,candidate}/documents/:id/submit (crea un Document real
// vía DocumentStorageAdapter mock -- nunca bytes reales, referencia
// siempre `mock://`). Fixtures de WorkerOnboarding/DocumentChecklistItem
// se crean/limpian acá porque ni worker-01 ni candidate-029 tienen
// checklist real seedeado (ver docs/F10_PLAN.md §7).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const WORKER_HEADERS = { "x-dev-user": "worker-portal@titan.dev", "content-type": "application/json" };
const CANDIDATE_HEADERS = { "x-dev-user": "candidate-portal@titan.dev", "content-type": "application/json" };
const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };

const WORKER_CANDIDATE_ID = "candidate-034"; // worker-01.candidateId
const CANDIDATE_ID = "candidate-029";
const JOB_ORDER_ID = "joborder-01";
const DOCUMENT_TYPE_ID = "doctype-i9";

let workerOnboardingId: string;
let workerChecklistItemId: string;
let candidateOnboardingId: string;
let candidateChecklistItemId: string;
let verifiedChecklistItemId: string;

// F10.5: candidate-034/candidate-029 son personas seed compartidas (F10.1,
// usadas por otros archivos de test y por verificación visual manual) --
// capturamos su estado ORIGINAL acá para restaurarlo exacto en after(),
// nunca asumimos null (los valores de seed son generados, no fijos).
let workerCandidateOriginal: { phone: string | null; city: string | null; state: string | null; languages: string[]; availabilityNotes: string | null; skills: string[] };
let candidateOriginal: typeof workerCandidateOriginal;

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;

  workerCandidateOriginal = await prisma.candidate.findUniqueOrThrow({
    where: { id: WORKER_CANDIDATE_ID },
    select: { phone: true, city: true, state: true, languages: true, availabilityNotes: true, skills: true },
  });
  candidateOriginal = await prisma.candidate.findUniqueOrThrow({
    where: { id: CANDIDATE_ID },
    select: { phone: true, city: true, state: true, languages: true, availabilityNotes: true, skills: true },
  });

  const workerOnboarding = await prisma.workerOnboarding.create({
    data: {
      tenantId: "tenant-titan",
      candidateId: WORKER_CANDIDATE_ID,
      jobOrderId: JOB_ORDER_ID,
      workerId: "worker-01",
      status: "IN_PROGRESS",
      progress: 40,
      nextBestAction: "Submit pending documents",
      rulesVersion: 1,
    },
  });
  workerOnboardingId = workerOnboarding.id;

  const workerItem = await prisma.documentChecklistItem.create({
    data: {
      tenantId: "tenant-titan",
      workerOnboardingId,
      documentTypeId: DOCUMENT_TYPE_ID,
      label: "I-9",
      status: "PENDING",
    },
  });
  workerChecklistItemId = workerItem.id;

  const verifiedItem = await prisma.documentChecklistItem.create({
    data: {
      tenantId: "tenant-titan",
      workerOnboardingId,
      documentTypeId: "doctype-w4",
      label: "W-4",
      status: "VERIFIED",
    },
  });
  verifiedChecklistItemId = verifiedItem.id;

  const candidateOnboarding = await prisma.workerOnboarding.create({
    data: {
      tenantId: "tenant-titan",
      candidateId: CANDIDATE_ID,
      jobOrderId: JOB_ORDER_ID,
      status: "INVITED",
      progress: 10,
      nextBestAction: "Submit pending documents",
      rulesVersion: 1,
    },
  });
  candidateOnboardingId = candidateOnboarding.id;

  const candidateItem = await prisma.documentChecklistItem.create({
    data: {
      tenantId: "tenant-titan",
      workerOnboardingId: candidateOnboardingId,
      documentTypeId: DOCUMENT_TYPE_ID,
      label: "I-9",
      status: "PENDING",
    },
  });
  candidateChecklistItemId = candidateItem.id;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.documentChecklistItem.deleteMany({ where: { workerOnboardingId: { in: [workerOnboardingId, candidateOnboardingId] } } });
  await prisma.document.deleteMany({ where: { OR: [{ candidateId: WORKER_CANDIDATE_ID }, { candidateId: CANDIDATE_ID }] } });
  await prisma.workerOnboarding.deleteMany({ where: { id: { in: [workerOnboardingId, candidateOnboardingId] } } });
  await prisma.candidate.update({ where: { id: WORKER_CANDIDATE_ID }, data: workerCandidateOriginal });
  await prisma.candidate.update({ where: { id: CANDIDATE_ID }, data: candidateOriginal });
});

// ---- Worker profile update ----

test("PATCH /portal/worker/profile as recruiter@titan.dev returns 403 (no portalProfile.update)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/profile`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ phone: "555-0100" }),
  });
  assert.equal(res.status, 403);
});

test("PATCH /portal/worker/profile updates only whitelisted self-service fields, persists in DB", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/profile`, {
    method: "PATCH",
    headers: WORKER_HEADERS,
    body: JSON.stringify({
      phone: "555-0199",
      city: "Chicago",
      availabilityNotes: "Available weekends only",
      skills: ["forklift", "osha-10"],
      languages: ["English", "Spanish"],
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { phone: string; city: string; availabilityNotes: string; skills: string[]; languages: string[] };
  assert.equal(body.phone, "555-0199");
  assert.equal(body.city, "Chicago");
  assert.equal(body.availabilityNotes, "Available weekends only");
  assert.deepEqual(body.skills, ["forklift", "osha-10"]);
  assert.deepEqual(body.languages, ["English", "Spanish"]);

  const dbCandidate = await prisma.candidate.findUniqueOrThrow({ where: { id: WORKER_CANDIDATE_ID } });
  assert.equal(dbCandidate.phone, "555-0199");
  assert.deepEqual(dbCandidate.skills, ["forklift", "osha-10"]);
});

test("PATCH /portal/worker/profile ignores internal-only fields silently (status/yearsExperience never accepted from this endpoint)", async () => {
  const before = await prisma.candidate.findUniqueOrThrow({ where: { id: WORKER_CANDIDATE_ID } });
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/profile`, {
    method: "PATCH",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ status: "NOT_QUALIFIED", yearsExperience: 999, city: "Aurora" }),
  });
  assert.equal(res.status, 200);
  const after = await prisma.candidate.findUniqueOrThrow({ where: { id: WORKER_CANDIDATE_ID } });
  assert.equal(after.status, before.status, "status must never change via portal profile update");
  assert.equal(after.yearsExperience, before.yearsExperience, "yearsExperience must never change via portal profile update");
  assert.equal(after.city, "Aurora");
});

test("PATCH /portal/worker/profile rejects non-array languages/skills with 400", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/profile`, {
    method: "PATCH",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ skills: "forklift" }),
  });
  assert.equal(res.status, 400);
});

// ---- Candidate profile update ----

test("PATCH /portal/candidate/profile updates only own Candidate row, never worker-01's", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/candidate/profile`, {
    method: "PATCH",
    headers: CANDIDATE_HEADERS,
    body: JSON.stringify({ availabilityNotes: "Mornings only", skills: ["forklift"] }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string; availabilityNotes: string };
  assert.equal(body.id, CANDIDATE_ID);
  assert.equal(body.availabilityNotes, "Mornings only");

  const other = await prisma.candidate.findUniqueOrThrow({ where: { id: WORKER_CANDIDATE_ID } });
  assert.notEqual(other.availabilityNotes, "Mornings only");
});

// ---- Document submission ----

test("POST /portal/worker/documents/:id/submit as recruiter@titan.dev returns 403 (no portalDocuments.update)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/documents/${workerChecklistItemId}/submit`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ fileName: "i9-form.pdf" }),
  });
  assert.equal(res.status, 403);
});

test("POST /portal/worker/documents/:id/submit requires fileName, 400 without it", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/documents/${workerChecklistItemId}/submit`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("POST /portal/worker/documents/:id/submit on another identity's checklist item returns 404 (ownership, not 403)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/documents/${candidateChecklistItemId}/submit`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ fileName: "i9-form.pdf" }),
  });
  assert.equal(res.status, 404);
});

test("POST /portal/worker/documents/:id/submit on a VERIFIED item (invalid transition) returns 400", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/documents/${verifiedChecklistItemId}/submit`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ fileName: "w4-form.pdf" }),
  });
  assert.equal(res.status, 400);
});

test("POST /portal/worker/documents/:id/submit on a PENDING item creates a real Document with a mock:// fileUrl and links it via documentId", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/documents/${workerChecklistItemId}/submit`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ fileName: "i9-form.pdf", notes: "uploaded from portal" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string; status: string };
  assert.equal(body.status, "SUBMITTED");

  const item = await prisma.documentChecklistItem.findUniqueOrThrow({ where: { id: workerChecklistItemId } });
  assert.equal(item.status, "SUBMITTED");
  assert.ok(item.documentId, "documentId must be linked");
  assert.equal(item.source, "worker_upload", "source keeps its F9.2 meaning -- never overwritten with a storage reference");

  const document = await prisma.document.findUniqueOrThrow({ where: { id: item.documentId! } });
  assert.ok(document.fileUrl?.startsWith("mock://"), "fileUrl must be the mock adapter reference, never a real bytes URL");
  assert.equal(document.status, "PENDING_REVIEW");
  assert.equal(document.candidateId, WORKER_CANDIDATE_ID);
  assert.equal(document.workerId, "worker-01");

  const auditEntry = await prisma.auditLog.findFirst({
    where: { action: "portal.worker_document_submitted", entityId: workerChecklistItemId },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(auditEntry, "document submission must be audited");
});

test("POST /portal/candidate/documents/:id/submit on a PENDING item creates a real Document scoped to the candidate (workerId null)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/candidate/documents/${candidateChecklistItemId}/submit`, {
    method: "POST",
    headers: CANDIDATE_HEADERS,
    body: JSON.stringify({ fileName: "i9-form.pdf" }),
  });
  assert.equal(res.status, 200);

  const item = await prisma.documentChecklistItem.findUniqueOrThrow({ where: { id: candidateChecklistItemId } });
  assert.equal(item.status, "SUBMITTED");
  assert.equal(item.source, "candidate_upload");

  const document = await prisma.document.findUniqueOrThrow({ where: { id: item.documentId! } });
  assert.ok(document.fileUrl?.startsWith("mock://"));
  assert.equal(document.candidateId, CANDIDATE_ID);
  assert.equal(document.workerId, null, "candidate-029 has no linked Worker row yet -- workerId must stay null, never invented");
});

test("POST /portal/candidate/documents/:id/submit on worker-01's checklist item returns 404 (cross-identity ownership)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/candidate/documents/${verifiedChecklistItemId}/submit`, {
    method: "POST",
    headers: CANDIDATE_HEADERS,
    body: JSON.stringify({ fileName: "w4-form.pdf" }),
  });
  assert.equal(res.status, 404);
});
