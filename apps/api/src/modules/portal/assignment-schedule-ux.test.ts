// F10.6: Assignment and Schedule UX -- enriquecimiento de
// /portal/worker/assignments (location/shiftType/scheduleNotes/
// supervisorName) y el flujo completo de ScheduleChangeRequest: el
// Worker SOLO puede crear una solicitud (nunca mutar el Assignment
// directamente), la revisión (aprobar/rechazar) es exclusivamente
// interna (/schedule-change-requests, modules/assignments).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const WORKER_HEADERS = { "x-dev-user": "worker-portal@titan.dev", "content-type": "application/json" };
const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };
const ADMIN_HEADERS = { "x-dev-user": "admin@titan.dev", "content-type": "application/json" };

const WORKER_ASSIGNMENT_ID = "assignment-01"; // worker-01's real seeded Assignment
const OTHER_ASSIGNMENT_ID = "assignment-02"; // worker-02's -- NOT worker-01's

let createdRequestId: string;

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
  if (createdRequestId) {
    await prisma.scheduleChangeRequest.deleteMany({ where: { id: createdRequestId } });
  }
});

test("GET /portal/worker/assignments enriches with location/shiftType/scheduleNotes/supervisorName", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/assignments`, { headers: WORKER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ id: string; location: unknown; shiftType: string; supervisorName: string | null }>;
  const own = body.find((a) => a.id === WORKER_ASSIGNMENT_ID);
  assert.ok(own, "worker-01's real seeded Assignment must be present");
  assert.ok(own!.location, "location must be populated from JobOrder");
  assert.ok(own!.shiftType, "shiftType must be populated from JobOrder");
  // billRate/payRate/margin must never leak into the portal DTO
  assert.equal((own as unknown as Record<string, unknown>).billRate, undefined);
  assert.equal((own as unknown as Record<string, unknown>).payRate, undefined);
});

test("GET /portal/worker/shifts includes breakMinutes", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/shifts`, { headers: WORKER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ breakMinutes: number }>;
  for (const s of body) {
    assert.equal(typeof s.breakMinutes, "number");
  }
});

test("POST /portal/worker/assignments/:id/schedule-change-requests as recruiter@titan.dev returns 403 (no portalAssignments.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/assignments/${WORKER_ASSIGNMENT_ID}/schedule-change-requests`, {
    method: "POST",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ requestType: "shift_swap", requestedChange: "Swap Friday for Saturday" }),
  });
  assert.equal(res.status, 403);
});

test("POST /portal/worker/assignments/:id/schedule-change-requests on another worker's Assignment returns 404 (ownership, not 403)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/assignments/${OTHER_ASSIGNMENT_ID}/schedule-change-requests`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ requestType: "shift_swap", requestedChange: "Swap Friday for Saturday" }),
  });
  assert.equal(res.status, 404);
});

test("POST /portal/worker/assignments/:id/schedule-change-requests requires requestedChange, 400 without it", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/assignments/${WORKER_ASSIGNMENT_ID}/schedule-change-requests`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ requestType: "shift_swap" }),
  });
  assert.equal(res.status, 400);
});

test("POST /portal/worker/assignments/:id/schedule-change-requests creates a real PENDING request, never mutates the Assignment", async () => {
  const before = await prisma.assignment.findUniqueOrThrow({ where: { id: WORKER_ASSIGNMENT_ID } });

  const res = await fetch(`${baseUrl}/api/v1/portal/worker/assignments/${WORKER_ASSIGNMENT_ID}/schedule-change-requests`, {
    method: "POST",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ requestType: "shift_swap", requestedChange: "Swap Friday for Saturday" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string; status: string; assignmentId: string };
  assert.equal(body.status, "PENDING");
  assert.equal(body.assignmentId, WORKER_ASSIGNMENT_ID);
  createdRequestId = body.id;

  const after = await prisma.assignment.findUniqueOrThrow({ where: { id: WORKER_ASSIGNMENT_ID } });
  assert.equal(after.status, before.status, "the Worker's request must never change Assignment.status directly");

  const auditEntry = await prisma.auditLog.findFirst({
    where: { action: "portal.worker_schedule_change_requested", entityId: createdRequestId },
  });
  assert.ok(auditEntry, "creating a request must be audited");
});

test("GET /portal/worker/schedule-change-requests?assignmentId=... lists only the Worker's own requests for that Assignment", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/schedule-change-requests?assignmentId=${WORKER_ASSIGNMENT_ID}`, { headers: WORKER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ id: string; assignmentId: string }>;
  assert.ok(body.some((r) => r.id === createdRequestId));
  for (const r of body) assert.equal(r.assignmentId, WORKER_ASSIGNMENT_ID);
});

test("GET /schedule-change-requests (internal) as sales@titan.dev returns 403 (no assignments.view)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/schedule-change-requests`, { headers: SALES_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /schedule-change-requests (internal) as admin lists the pending request with worker/jobOrder names resolved", async () => {
  const res = await fetch(`${baseUrl}/api/v1/schedule-change-requests?status=PENDING`, { headers: ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ id: string; workerName: string; jobOrderTitle: string }>;
  const created = body.find((r) => r.id === createdRequestId);
  assert.ok(created);
  assert.ok(created!.workerName.length > 0);
  assert.ok(created!.jobOrderTitle.length > 0);
});

test("PATCH /schedule-change-requests/:id/status as recruiter@titan.dev returns 403 (no assignments.update)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/schedule-change-requests/${createdRequestId}/status`, {
    method: "PATCH",
    headers: RECRUITER_HEADERS,
    body: JSON.stringify({ status: "APPROVED" }),
  });
  assert.equal(res.status, 403);
});

test("PATCH /schedule-change-requests/:id/status rejects an invalid status value with 400", async () => {
  const res = await fetch(`${baseUrl}/api/v1/schedule-change-requests/${createdRequestId}/status`, {
    method: "PATCH",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ status: "MAYBE" }),
  });
  assert.equal(res.status, 400);
});

test("PATCH /schedule-change-requests/:id/status as admin approves it, is audited, and a second review attempt is rejected (already decided)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/schedule-change-requests/${createdRequestId}/status`, {
    method: "PATCH",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ status: "APPROVED", reviewNotes: "Approved for this week only" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; reviewNotes: string | null };
  assert.equal(body.status, "APPROVED");
  assert.equal(body.reviewNotes, "Approved for this week only");

  const auditEntry = await prisma.auditLog.findFirst({ where: { action: "scheduleChangeRequest.reviewed", entityId: createdRequestId } });
  assert.ok(auditEntry);

  const second = await fetch(`${baseUrl}/api/v1/schedule-change-requests/${createdRequestId}/status`, {
    method: "PATCH",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ status: "REJECTED" }),
  });
  assert.equal(second.status, 400, "an already-decided request cannot be reviewed again");
});
