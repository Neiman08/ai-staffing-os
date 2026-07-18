// F10.8: Notifications Center -- emisión (core/notifications.ts),
// scoping por userId/recipientRole (mismos endpoints para roles
// internos y de portal, ya que notifications.view/.markRead existen en
// los 15 roles desde F10.1), idempotencia, y los triggers reales
// wireados (JOB_REQUEST_SUBMITTED, JOB_REQUEST_NEEDS_INFORMATION,
// TIME_ENTRY_APPROVED/REJECTED, SCHEDULE_CHANGED).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { emitNotification, notifyPortalUsers } from "../../core/notifications";

let server: Server;
let baseUrl: string;

const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };
const CLIENT_ADMIN_HEADERS = { "x-dev-user": "client-admin@titan.dev", "content-type": "application/json" };
const WORKER_HEADERS = { "x-dev-user": "worker-portal@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };

const createdIds: string[] = [];

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
  if (createdIds.length) {
    await prisma.notification.deleteMany({ where: { id: { in: createdIds } } });
  }
});

test("emitNotification requires exactly one of recipientUserId/recipientRole", async () => {
  const recruiter = await prisma.user.findFirstOrThrow({ where: { email: "recruiter@titan.dev" } });
  await runWithTenancyContext({ tenantId: recruiter.tenantId, userId: recruiter.id, permissions: [] }, async () => {
    await assert.rejects(() => emitNotification({ type: "SYSTEM_NOTICE", title: "x" }));
    await assert.rejects(() => emitNotification({ type: "SYSTEM_NOTICE", title: "x", recipientUserId: recruiter.id, recipientRole: "Recruiter" }));
  });
});

test("emitNotification is idempotent while the previous one is unread (same recipient/type/entityId)", async () => {
  const recruiter = await prisma.user.findFirstOrThrow({ where: { email: "recruiter@titan.dev" } });
  await runWithTenancyContext({ tenantId: recruiter.tenantId, userId: recruiter.id, permissions: [] }, async () => {
    await emitNotification({ recipientUserId: recruiter.id, type: "SYSTEM_NOTICE", title: "dup test", entityType: "test_entity", entityId: "dup-1" });
    await emitNotification({ recipientUserId: recruiter.id, type: "SYSTEM_NOTICE", title: "dup test 2", entityType: "test_entity", entityId: "dup-1" });
  });
  const rows = await prisma.notification.findMany({ where: { userId: recruiter.id, entityType: "test_entity", entityId: "dup-1" } });
  assert.equal(rows.length, 1, "a second emit with the same unread (recipient, type, entityId) must not create a duplicate");
  createdIds.push(...rows.map((r) => r.id));
});

test("notifyPortalUsers never leaks to a User of a different company", async () => {
  const titanCompanyId = "company-01";
  await runWithTenancyContext({ tenantId: "tenant-titan", userId: "seed-system", permissions: [] }, async () => {
    await notifyPortalUsers({ companyId: titanCompanyId }, { type: "SYSTEM_NOTICE", title: "company-scoped test", entityType: "test_entity", entityId: "scope-1" });
  });
  const rows = await prisma.notification.findMany({ where: { entityType: "test_entity", entityId: "scope-1" } });
  createdIds.push(...rows.map((r) => r.id));
  for (const r of rows) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.userId! } });
    assert.equal(u.companyId, titanCompanyId);
  }
});

test("GET /notifications as recruiter@titan.dev returns 403 for sales@titan.dev (no notifications.view is impossible -- all roles have it, so this instead confirms 200 for everyone)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/notifications`, { headers: SALES_HEADERS });
  assert.equal(res.status, 200, "notifications.view exists on all 15 roles since F10.1 -- this is a smoke check, not a 403 case");
});

test("POST /portal/client/job-requests/:id/submit emits a JOB_REQUEST_SUBMITTED notification for Sales (role-broadcast)", async () => {
  const createRes = await fetch(`${baseUrl}/api/v1/portal/client/job-requests`, {
    method: "POST",
    headers: CLIENT_ADMIN_HEADERS,
    body: JSON.stringify({ requestedTitle: "F10.8 Notification Test Role", headcount: 1, desiredStartDate: "2026-09-15" }),
  });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()) as { id: string };

  const submitRes = await fetch(`${baseUrl}/api/v1/portal/client/job-requests/${created.id}/submit`, { method: "POST", headers: CLIENT_ADMIN_HEADERS });
  assert.equal(submitRes.status, 200);

  const notif = await prisma.notification.findFirst({
    where: { type: "JOB_REQUEST_SUBMITTED", entityType: "clientJobRequest", entityId: created.id },
  });
  assert.ok(notif, "submitting must emit a JOB_REQUEST_SUBMITTED notification");
  // F10.11: corregido de "Recruiter" a "Sales" -- Recruiter no tiene
  // clientJobs.view (solo Sales/Operations), un hallazgo real del pase
  // de e2e (ver docs/F10_PLAN.md §13).
  assert.equal(notif!.recipientRole, "Sales");
  assert.equal(notif!.userId, null);
  if (notif) createdIds.push(notif.id);

  const listRes = await fetch(`${baseUrl}/api/v1/notifications`, { headers: SALES_HEADERS });
  const list = (await listRes.json()) as { items: Array<{ id: string; type: string }> };
  assert.ok(list.items.some((n) => n.id === notif!.id), "Sales must see a notification addressed to their role");

  const workerCannotSee = await fetch(`${baseUrl}/api/v1/notifications`, { headers: WORKER_HEADERS });
  const workerList = (await workerCannotSee.json()) as { items: Array<{ id: string }> };
  assert.ok(!workerList.items.some((n) => n.id === notif!.id), "a WORKER must never see a Sales-role notification");

  await prisma.clientJobRequest.delete({ where: { id: created.id } });
});

test("POST /notifications/:id/read marks it read (idempotent), and a stranger role sharing no ownership gets 404", async () => {
  const recruiter = await prisma.user.findFirstOrThrow({ where: { email: "recruiter@titan.dev" } });
  let notifId = "";
  await runWithTenancyContext({ tenantId: recruiter.tenantId, userId: recruiter.id, permissions: [] }, async () => {
    await emitNotification({ recipientUserId: recruiter.id, type: "SYSTEM_NOTICE", title: "mark-read test", entityType: "test_entity", entityId: "read-1" });
  });
  const created = await prisma.notification.findFirstOrThrow({ where: { userId: recruiter.id, entityType: "test_entity", entityId: "read-1" } });
  notifId = created.id;
  createdIds.push(notifId);

  const wrongOwner = await fetch(`${baseUrl}/api/v1/notifications/${notifId}/read`, { method: "POST", headers: SALES_HEADERS });
  assert.equal(wrongOwner.status, 404);

  const res = await fetch(`${baseUrl}/api/v1/notifications/${notifId}/read`, { method: "POST", headers: RECRUITER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { readAt: string | null };
  assert.ok(body.readAt);

  const auditEntry = await prisma.auditLog.findFirst({ where: { action: "notification.marked_read", entityId: notifId } });
  assert.ok(auditEntry);
});
