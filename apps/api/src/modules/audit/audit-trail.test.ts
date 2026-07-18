// F10.9: Portal Audit Trail -- interno (tenant completo, gateado por
// auditLogs.view), cliente (acotado a SU Company, nunca tenant-wide),
// Worker/Candidate (solo su propio historial). Nunca expone before/
// after/ip en ningún nivel.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const ADMIN_HEADERS = { "x-dev-user": "admin@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };
const CLIENT_ADMIN_HEADERS = { "x-dev-user": "client-admin@titan.dev", "content-type": "application/json" }; // company-01
const CLIENT_MANAGER_HEADERS = { "x-dev-user": "client-manager@titan.dev", "content-type": "application/json" }; // company-01
const WORKER_HEADERS = { "x-dev-user": "worker-portal@titan.dev", "content-type": "application/json" };
const CANDIDATE_HEADERS = { "x-dev-user": "candidate-portal@titan.dev", "content-type": "application/json" };

const createdRequestIds: string[] = [];
let otherCompanyRequestId = "";

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;

  // Fixture de una ClientJobRequest de OTRA company (company-02, no
  // company-01) para probar que el audit trail de un cliente nunca
  // cruza hacia una company distinta dentro del mismo tenant.
  const other = await prisma.clientJobRequest.create({
    data: {
      tenantId: "tenant-titan",
      companyId: "company-02",
      requestedTitle: "F10.9 Other Company Audit Fixture",
      headcount: 1,
      desiredStartDate: new Date("2026-11-01"),
      urgency: "MEDIUM",
      status: "SUBMITTED",
    },
  });
  otherCompanyRequestId = other.id;
  await prisma.auditLog.create({
    data: {
      tenantId: "tenant-titan",
      actorType: "HUMAN",
      actorId: "seed-fixture",
      action: "clientJobRequest.submitted",
      entityType: "clientJobRequest",
      entityId: other.id,
    },
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const allIds = [...createdRequestIds, otherCompanyRequestId];
  await prisma.auditLog.deleteMany({ where: { entityType: "clientJobRequest", entityId: { in: allIds } } });
  await prisma.notification.deleteMany({ where: { entityType: "clientJobRequest", entityId: { in: allIds } } });
  await prisma.clientJobRequest.deleteMany({ where: { id: { in: allIds } } });
});

test("GET /audit-log (internal) as sales@titan.dev returns 403 (Sales has no auditLogs.view)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/audit-log`, { headers: SALES_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /audit-log (internal) as admin returns tenant-wide entries, never exposes before/after/ip", async () => {
  const res = await fetch(`${baseUrl}/api/v1/audit-log?limit=50`, { headers: ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<Record<string, unknown>> };
  assert.ok(body.items.length > 0);
  for (const entry of body.items) {
    assert.equal(entry.before, undefined);
    assert.equal(entry.after, undefined);
    assert.equal(entry.ip, undefined);
    assert.ok(entry.actorLabel, "actorLabel must be resolved, never a raw id-only view");
  }
});

test("GET /audit-log supports entityType and action filters", async () => {
  const res = await fetch(`${baseUrl}/api/v1/audit-log?entityType=clientJobRequest&action=submitted&limit=50`, { headers: ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ entityType: string; action: string }> };
  for (const entry of body.items) {
    assert.equal(entry.entityType, "clientJobRequest");
    assert.ok(entry.action.toLowerCase().includes("submitted"));
  }
});

test("GET /portal/client/audit-log as client-manager@titan.dev returns 403 (CLIENT_MANAGER has no auditLogs.view)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/audit-log`, { headers: CLIENT_MANAGER_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /portal/client/audit-log (company-01) never includes an action tied to company-02's ClientJobRequest", async () => {
  const createRes = await fetch(`${baseUrl}/api/v1/portal/client/job-requests`, {
    method: "POST",
    headers: CLIENT_ADMIN_HEADERS,
    body: JSON.stringify({ requestedTitle: "F10.9 Company-01 Audit Fixture", headcount: 1, desiredStartDate: "2026-11-02" }),
  });
  const created = (await createRes.json()) as { id: string };
  createdRequestIds.push(created.id);
  await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${created.id}/submit`, { method: "POST", headers: CLIENT_ADMIN_HEADERS });

  const res = await fetch(`${baseUrl}/api/v1/portal/client/audit-log?entityType=clientJobRequest&limit=100`, { headers: CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ entityId: string }> };
  assert.ok(body.items.some((e) => e.entityId === created.id), "must see its own company's action");
  assert.ok(!body.items.some((e) => e.entityId === otherCompanyRequestId), "must never see company-02's action, same tenant or not");
});

test("GET /portal/worker/audit-log only shows actions actorId-attributed to the current Worker, and includes a real self-performed action", async () => {
  const patchRes = await fetch(`${baseUrl}/api/v1/portal/worker/profile`, {
    method: "PATCH",
    headers: WORKER_HEADERS,
    body: JSON.stringify({ city: "Aurora" }),
  });
  assert.equal(patchRes.status, 200);

  const res = await fetch(`${baseUrl}/api/v1/portal/worker/audit-log?limit=50`, { headers: WORKER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ actorId: string; action: string }> };
  assert.ok(body.items.some((e) => e.action === "portal.worker_profile_updated"));

  const workerUser = await prisma.user.findFirstOrThrow({ where: { email: "worker-portal@titan.dev" } });
  for (const entry of body.items) {
    assert.equal(entry.actorId, workerUser.id, "a Worker must only ever see actions actorId-attributed to themselves");
  }
});

test("GET /portal/candidate/audit-log only shows the Candidate's own actions, never the Worker's", async () => {
  const patchRes = await fetch(`${baseUrl}/api/v1/portal/candidate/profile`, {
    method: "PATCH",
    headers: CANDIDATE_HEADERS,
    body: JSON.stringify({ availabilityNotes: "F10.9 audit test" }),
  });
  assert.equal(patchRes.status, 200);

  const res = await fetch(`${baseUrl}/api/v1/portal/candidate/audit-log?limit=50`, { headers: CANDIDATE_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ actorId: string; action: string }> };
  assert.ok(body.items.some((e) => e.action === "portal.candidate_profile_updated"));

  const candidateUser = await prisma.user.findFirstOrThrow({ where: { email: "candidate-portal@titan.dev" } });
  const workerUser = await prisma.user.findFirstOrThrow({ where: { email: "worker-portal@titan.dev" } });
  for (const entry of body.items) {
    assert.equal(entry.actorId, candidateUser.id);
    assert.notEqual(entry.actorId, workerUser.id);
  }

  // cleanup del campo mutado
  await prisma.candidate.update({ where: { id: candidateUser.candidateId! }, data: { availabilityNotes: null } });
});
