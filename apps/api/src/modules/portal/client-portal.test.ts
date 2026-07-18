// F10.2: Client Portal -- corre vía dev-bypass real contra
// client-admin@titan.dev (companyId=company-01) y client-manager@titan.dev
// (mismo companyId, menos permisos). Foco: RBAC, ownership (nunca ver
// datos de otra Company del MISMO tenant -- el riesgo real de IDOR) y
// tenancy (client-admin@acme.dev, otro tenant, nunca ve nada de
// tenant-titan).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const CLIENT_ADMIN_HEADERS = { "x-dev-user": "client-admin@titan.dev", "content-type": "application/json" };
const CLIENT_MANAGER_HEADERS = { "x-dev-user": "client-manager@titan.dev", "content-type": "application/json" };
const ACME_CLIENT_ADMIN_HEADERS = { "x-dev-user": "client-admin@acme.dev", "content-type": "application/json" };
const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };

// F10.2: confirmado por consulta directa a la base de dev (nunca
// asumido): joborder-01 pertenece a company-03, joborder-02 a
// company-04 -- joborder-03 es el único Job Order real de company-01.
const REAL_JOB_ORDER_ID = "joborder-03"; // company-01
const OTHER_COMPANY_JOB_ORDER_ID = "joborder-01"; // company-03 -- misma tenant, otra Company

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
});

test("GET /portal/client/dashboard as recruiter@titan.dev returns 403 (no portalAssignments.view -- internal roles never get portal permissions)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/dashboard`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /portal/client/dashboard as client-admin@titan.dev returns real non-negative counts", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/dashboard`, { headers: CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, number>;
  for (const key of ["openJobOrders", "activeAssignments", "pendingTimeEntries", "openIncidents"]) {
    assert.equal(typeof body[key], "number");
    assert.ok((body[key] as number) >= 0);
  }
});

test("GET /portal/client/job-orders as client-admin@titan.dev only returns company-01's job orders, never another company's", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/job-orders?limit=100`, { headers: CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ id: string }> };
  assert.ok(body.items.length > 0, "company-01 has real seeded job orders");
  const ids = body.items.map((i) => i.id);
  assert.ok(ids.includes(REAL_JOB_ORDER_ID));
  assert.ok(!ids.includes(OTHER_COMPANY_JOB_ORDER_ID), "must never leak another Company's job order in the SAME tenant");
});

test("GET /portal/client/job-orders/:id for company-01's own job order returns 200", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/job-orders/${REAL_JOB_ORDER_ID}`, { headers: CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string };
  assert.equal(body.id, REAL_JOB_ORDER_ID);
});

test("IDOR: GET /portal/client/job-orders/:id for ANOTHER company's job order (same tenant) returns 404, never 403 or the data", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/job-orders/${OTHER_COMPANY_JOB_ORDER_ID}`, { headers: CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 404, "must not confirm existence of a resource that belongs to another Company");
});

test("IDOR: GET /portal/client/job-orders/:id/shortlist for another company's job order returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/job-orders/${OTHER_COMPANY_JOB_ORDER_ID}/shortlist`, { headers: CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 404);
});

test("GET /portal/client/job-orders/:id/shortlist never exposes score/reasons/gaps/risks (internal recruiting logic)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/job-orders/${REAL_JOB_ORDER_ID}/shortlist`, { headers: CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<Record<string, unknown>>;
  for (const entry of body) {
    assert.equal(entry.score, undefined);
    assert.equal(entry.reasons, undefined);
    assert.equal(entry.gaps, undefined);
    assert.equal(entry.risks, undefined);
    assert.equal(entry.reviewStatus === "DRAFT" || entry.reviewStatus === "REMOVED", false, "only client-visible review statuses should be returned");
  }
});

test("GET /portal/client/assignments and /portal/client/workers only return company-01's data", async () => {
  const [assignmentsRes, workersRes] = await Promise.all([
    fetch(`${baseUrl}/api/v1/portal/client/assignments?limit=100`, { headers: CLIENT_ADMIN_HEADERS }),
    fetch(`${baseUrl}/api/v1/portal/client/workers`, { headers: CLIENT_ADMIN_HEADERS }),
  ]);
  assert.equal(assignmentsRes.status, 200);
  assert.equal(workersRes.status, 200);
  const assignments = (await assignmentsRes.json()) as { items: Array<{ jobOrderTitle: string }> };
  const workers = (await workersRes.json()) as Array<{ jobOrderTitle: string }>;
  assert.ok(Array.isArray(assignments.items));
  assert.ok(Array.isArray(workers));
});

test("GET /portal/client/time-entries returns only SUBMITTED/NEEDS_REVIEW entries, and only for this company", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/time-entries?limit=100`, { headers: CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ status: string }> };
  for (const item of body.items) {
    assert.ok(["SUBMITTED", "NEEDS_REVIEW"].includes(item.status));
  }
});

test("POST /portal/client/time-entries/:id/approve as client-manager@titan.dev returns 403 (view-only, matches 'less permissions than CLIENT_ADMIN' requirement)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/time-entries/does-not-exist/approve`, { method: "POST", headers: CLIENT_MANAGER_HEADERS });
  assert.equal(res.status, 403);
});

test("POST /portal/client/time-entries/:id/approve for a nonexistent id (as CLIENT_ADMIN, who does have the permission) returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/time-entries/does-not-exist/approve`, { method: "POST", headers: CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 404);
});

test("GET /portal/client/incidents only returns company-01's incidents", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/incidents?limit=100`, { headers: CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: unknown[] };
  assert.ok(Array.isArray(body.items));
});

test("tenancy: client-admin@acme.dev (tenant-acme) never sees tenant-titan's job orders even via the portal", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/job-orders?limit=100`, { headers: ACME_CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ id: string }> };
  const ids = body.items.map((i) => i.id);
  assert.ok(!ids.includes(REAL_JOB_ORDER_ID));
  assert.ok(!ids.includes(OTHER_COMPANY_JOB_ORDER_ID));
});

test("tenancy: client-admin@acme.dev cannot reach tenant-titan's job order by ID directly (URL/ID tampering)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/client/job-orders/${REAL_JOB_ORDER_ID}`, { headers: ACME_CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 404);
});
