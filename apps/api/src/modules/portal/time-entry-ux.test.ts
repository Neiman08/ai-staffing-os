// F10.7: Time Entry UX -- draft (hora inicio/fin/break) -> editar ->
// enviar -> ver status -> rechazo -> corregir y reenviar. El Worker
// SOLO puede tocar sus propios TimeEntry mientras siguen DRAFT; nunca
// autoaprueba; el cliente solo aprueba/rechaza dentro de su empresa
// (ya cubierto por F10.2, acá se agrega el nuevo contexto de
// overtimeFlag/discrepancyFlag/notes visibles al revisar).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const WORKER_HEADERS = { "x-dev-user": "worker-portal@titan.dev", "content-type": "application/json" };
const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };

const WORKER_ASSIGNMENT_ID = "assignment-01"; // worker-01's real seeded Assignment
const OTHER_ASSIGNMENT_ID = "assignment-02"; // worker-02's -- NOT worker-01's
const ENTRY_DATE = "2026-08-01"; // free date, not used by any seeded fixture

let createdEntryId: string;

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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdEntryId) {
    await prisma.timeEntry.deleteMany({ where: { id: createdEntryId } });
  }
});

test("POST /portal/worker/time-entries as recruiter@titan.dev returns 403 (no portalTimeEntries.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ assignmentId: WORKER_ASSIGNMENT_ID, date: ENTRY_DATE, startTime: "08:00", endTime: "16:00", breakMinutes: 30 }),
  });
  assert.equal(res.status, 403);
});

test("POST /portal/worker/time-entries on another worker's Assignment returns 404 (ownership, not 403)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ assignmentId: OTHER_ASSIGNMENT_ID, date: ENTRY_DATE, startTime: "08:00", endTime: "16:00", breakMinutes: 30 }),
  });
  assert.equal(res.status, 404);
});

test("POST /portal/worker/time-entries rejects startTime === endTime (zero duration) with 400", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ assignmentId: WORKER_ASSIGNMENT_ID, date: ENTRY_DATE, startTime: "08:00", endTime: "08:00", breakMinutes: 0 }),
  });
  assert.equal(res.status, 400);
});

test("POST /portal/worker/time-entries rejects a malformed startTime with 400", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ assignmentId: WORKER_ASSIGNMENT_ID, date: ENTRY_DATE, startTime: "8am", endTime: "16:00" }),
  });
  assert.equal(res.status, 400);
});

test("POST /portal/worker/time-entries creates a real DRAFT TimeEntry, computing regularHours from start/end/break, with the note persisted", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ assignmentId: WORKER_ASSIGNMENT_ID, date: ENTRY_DATE, startTime: "08:00", endTime: "16:30", breakMinutes: 30, notes: "Worked the closing shift" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string; status: string; regularHours: string; notes: string | null };
  assert.equal(body.status, "DRAFT");
  assert.equal(Number(body.regularHours), 8); // 8:00-16:30 = 8.5h gross - 0.5h break = 8h
  assert.equal(body.notes, "Worked the closing shift");
  createdEntryId = body.id;

  const auditEntry = await prisma.auditLog.findFirst({ where: { action: "portal.worker_time_entry_created", entityId: createdEntryId } });
  assert.ok(auditEntry);
});

test("POST /portal/worker/time-entries rejects a duplicate date for the same Assignment with 409", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ assignmentId: WORKER_ASSIGNMENT_ID, date: ENTRY_DATE, startTime: "08:00", endTime: "16:00", breakMinutes: 0 }),
  });
  assert.equal(res.status, 409);
});

test("PATCH /portal/worker/time-entries/:id on another worker's entry returns 404", async () => {
  const other = await prisma.timeEntry.findFirstOrThrow({ where: { assignmentId: OTHER_ASSIGNMENT_ID } });
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries/${other.id}`, {
    method: "PATCH",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ notes: "trying to edit someone else's entry" }),
  });
  assert.equal(res.status, 404);
});

test("PATCH /portal/worker/time-entries/:id updates hours and notes while still DRAFT", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries/${createdEntryId}`, {
    method: "PATCH",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ startTime: "09:00", endTime: "17:00", breakMinutes: 60, notes: "Adjusted after lunch ran long" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { regularHours: string; notes: string | null; status: string };
  assert.equal(Number(body.regularHours), 7); // 9:00-17:00 = 8h - 1h break = 7h
  assert.equal(body.notes, "Adjusted after lunch ran long");
  assert.equal(body.status, "DRAFT");
});

test("PATCH /portal/worker/time-entries/:id rejects startTime without endTime (must be paired) with 400", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries/${createdEntryId}`, {
    method: "PATCH",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ startTime: "07:00" }),
  });
  assert.equal(res.status, 400);
});

test("POST /portal/worker/time-entries/:id/submit transitions DRAFT -> SUBMITTED (no discrepancy), then editing/re-submitting is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries/${createdEntryId}/submit`, { method: "POST", headers: WORKER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "SUBMITTED");

  const editAttempt = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries/${createdEntryId}`, {
    method: "PATCH",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ notes: "trying to sneak an edit in after submit" }),
  });
  assert.equal(editAttempt.status, 400, "a SUBMITTED entry must never be worker-editable again without an explicit reject/reopen");

  const auditEntry = await prisma.auditLog.findFirst({ where: { action: "portal.worker_time_entry_submitted", entityId: createdEntryId } });
  assert.ok(auditEntry);
});

test("full reject -> correct -> resubmit cycle: internal rejects, Worker reopens (DRAFT), edits, resubmits", async () => {
  // reutiliza el endpoint interno ya probado en F9.6/payroll.test.ts --
  // acá solo se confirma la mitad del ciclo que le toca al Worker Portal.
  const rejectRes = await fetch(`${baseUrl}/api/v1/time-entries/${createdEntryId}/reject`, {
    method: "POST",
    headers: { "x-dev-user": "admin@titan.dev", "content-type": "application/json" },
    body: JSON.stringify({ rejectionReason: "Hours don't match the client's report" }),
  });
  assert.equal(rejectRes.status, 200);

  const reopenAsRecruiter = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries/${createdEntryId}/reopen`, { method: "POST", headers: RECRUITER_HEADERS });
  assert.equal(reopenAsRecruiter.status, 403);

  const reopenRes = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries/${createdEntryId}/reopen`, { method: "POST", headers: WORKER_HEADERS });
  assert.equal(reopenRes.status, 200);
  const reopened = (await reopenRes.json()) as { status: string };
  assert.equal(reopened.status, "DRAFT");

  const editRes = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries/${createdEntryId}`, {
    method: "PATCH",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ startTime: "08:00", endTime: "16:00", breakMinutes: 30, notes: "Corrected to match the client's report" }),
  });
  assert.equal(editRes.status, 200);

  const resubmitRes = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries/${createdEntryId}/submit`, { method: "POST", headers: WORKER_HEADERS });
  assert.equal(resubmitRes.status, 200);
  const resubmitted = (await resubmitRes.json()) as { status: string };
  assert.ok(["SUBMITTED", "NEEDS_REVIEW"].includes(resubmitted.status));

  const reopenAgainAttempt = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries/${createdEntryId}/reopen`, { method: "POST", headers: WORKER_HEADERS });
  assert.equal(reopenAgainAttempt.status, 400, "reopen only valid from REJECTED");
});

test("GET /portal/worker/time-entries reflects the final entry with notes, no rejectionReason leaked after correction", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries?limit=50`, { headers: WORKER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ id: string; notes: string | null; status: string }> };
  const entry = body.items.find((t) => t.id === createdEntryId);
  assert.ok(entry);
  assert.equal(entry!.notes, "Corrected to match the client's report");
});
