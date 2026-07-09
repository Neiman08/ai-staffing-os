import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "./app";

let server: Server;
let baseUrl: string;

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

test("GET /api/v1/health returns ok without auth", async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; db: boolean };
  assert.equal(body.status, "ok");
  assert.equal(body.db, true);
});

test("GET /api/v1/candidates as admin (default dev-bypass) returns 200", async () => {
  const res = await fetch(`${baseUrl}/api/v1/candidates`);
  assert.equal(res.status, 200);
});

test("GET /api/v1/candidates as sales@titan.dev returns 403 (Sales has no candidates.view permission)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/candidates`, {
    headers: { "x-dev-user": "sales@titan.dev" },
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "FORBIDDEN");
});

test("GET /api/v1/companies as sales@titan.dev returns 200 (Sales does have companies.view)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/companies`, {
    headers: { "x-dev-user": "sales@titan.dev" },
  });
  assert.equal(res.status, 200);
});

// F1: new leads/opportunities/followUps permissions (12 new keys, §6 of the plan)
test("GET /api/v1/leads as compliance@titan.dev returns 403 (Compliance has no leads.view permission)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/leads`, {
    headers: { "x-dev-user": "compliance@titan.dev" },
  });
  assert.equal(res.status, 403);
});

test("POST /api/v1/leads as sales@titan.dev succeeds (Sales has leads.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/leads`, {
    method: "POST",
    headers: { "x-dev-user": "sales@titan.dev", "content-type": "application/json" },
    body: JSON.stringify({ source: "rbac-test", city: "Test City", state: "IL" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string };
  assert.ok(body.id);
  // createLead() also writes an Activity row (entityType: "lead", entityId:
  // body.id) via logActivity — clean that up too, or it leaks into
  // subsequent seed/count checks.
  await prisma.activity.deleteMany({ where: { entityType: "lead", entityId: body.id } });
  await prisma.lead.delete({ where: { id: body.id } });
});

test("POST /api/v1/leads as compliance@titan.dev returns 403 (Compliance has no leads.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/leads`, {
    method: "POST",
    headers: { "x-dev-user": "compliance@titan.dev", "content-type": "application/json" },
    body: JSON.stringify({ source: "rbac-test" }),
  });
  assert.equal(res.status, 403);
});
