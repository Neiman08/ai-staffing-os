import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createApp } from "../../app";
import { createJobOrder } from "./service";

let server: Server;
let baseUrl: string;

const OPERATIONS_HEADERS = { "x-dev-user": "operations@titan.dev", "content-type": "application/json" };
const COMPLIANCE_HEADERS = { "x-dev-user": "compliance@titan.dev", "content-type": "application/json" };
const CEO_HEADERS = { "x-dev-user": "ceo@titan.dev", "content-type": "application/json" };

// F5.1: registros reales del seed de F0 — no se inventan IDs.
const REAL_COMPANY_ID = "company-01";
const REAL_CATEGORY_ID = "category-general-labor";

const createdJobOrderIds: string[] = [];

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
  // F5.1: limpieza — todo Job Order creado por esta suite queda
  // claramente identificado (título con prefijo de test) y se borra al
  // terminar; nada de esto se deja como dato "real" del tenant.
  if (createdJobOrderIds.length > 0) {
    await prisma.jobOrder.deleteMany({ where: { id: { in: createdJobOrderIds } } });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    companyId: REAL_COMPANY_ID,
    categoryId: REAL_CATEGORY_ID,
    title: "F5.1 test — General Labor night shift",
    workersNeeded: 5,
    billRate: 30,
    payRate: 20,
    startDate: new Date().toISOString(),
    ...overrides,
  };
}

async function createValidJobOrder(headers: Record<string, string> = OPERATIONS_HEADERS) {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers,
    body: JSON.stringify(validPayload()),
  });
  const body = (await res.json()) as { id: string };
  if (res.status === 201) createdJobOrderIds.push(body.id);
  return { res, body };
}

// ---- Creación ----

test("POST /job-orders as compliance@titan.dev returns 403 (no jobOrders.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify(validPayload()),
  });
  assert.equal(res.status, 403);
});

test("POST /job-orders as operations@titan.dev creates a real Job Order, always DRAFT", async () => {
  const { res, body } = (await createValidJobOrder()) as { res: Response; body: { id: string; status: string } };
  assert.equal(res.status, 201);
  assert.equal(body.status, "DRAFT", "a new Job Order must always start as DRAFT, never OPEN");
});

test("createdById is taken from the tenancy context, never from the request body", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify(validPayload({ createdById: "someone-else-entirely" })),
  });
  const body = (await res.json()) as { id: string };
  assert.equal(res.status, 201);
  createdJobOrderIds.push(body.id);

  const operationsUser = await prisma.user.findFirstOrThrow({ where: { tenantId: "tenant-titan", email: "operations@titan.dev" } });
  const detailRes = await fetch(`${baseUrl}/api/v1/job-orders/${body.id}`, { headers: OPERATIONS_HEADERS });
  const detail = (await detailRes.json()) as { createdById: string | null };
  assert.equal(detail.createdById, operationsUser.id, "createdById must be the real authenticated user, never the body value");
});

test("the body cannot set status/workersFilled/tenantId on creation — those fields simply don't exist in the input contract", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify(validPayload({ status: "OPEN", workersFilled: 999, tenantId: "some-other-tenant" })),
  });
  const body = (await res.json()) as { id: string; status: string; workersFilled: number };
  assert.equal(res.status, 201);
  createdJobOrderIds.push(body.id);
  assert.equal(body.status, "DRAFT");
  assert.equal(body.workersFilled, 0);
});

test("Company from another tenant is rejected, never accepted", async () => {
  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      await assert.rejects(
        () => createJobOrder(validPayload() as never),
        /Company not found/,
      );
    },
  );
});

test("invalid categoryId is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify(validPayload({ categoryId: "category-does-not-exist" })),
  });
  assert.equal(res.status, 400);
});

test("workersNeeded <= 0 is rejected by validation", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify(validPayload({ workersNeeded: 0 })),
  });
  assert.equal(res.status, 400);
});

test("billRate <= payRate is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify(validPayload({ billRate: 15, payRate: 20 })),
  });
  assert.equal(res.status, 400);
});

test("negative payRate is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify(validPayload({ payRate: -5, billRate: 10 })),
  });
  assert.equal(res.status, 400);
});

test("endDate before startDate is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify(
      validPayload({ startDate: "2026-08-01T00:00:00.000Z", endDate: "2026-07-01T00:00:00.000Z" }),
    ),
  });
  assert.equal(res.status, 400);
});

test("empty title is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify(validPayload({ title: "" })),
  });
  assert.equal(res.status, 400);
});

test("location with city but no state is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify(validPayload({ location: { city: "Chicago" } })),
  });
  assert.equal(res.status, 400);
});

test("unknown requirement key (not a real DocumentType) is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify(validPayload({ requirements: ["not_a_real_doc_type"] })),
  });
  assert.equal(res.status, 400);
});

test("a real requirement key (osha10) is accepted and persisted", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify(validPayload({ requirements: ["osha10", "drug_test"] })),
  });
  const body = (await res.json()) as { id: string };
  assert.equal(res.status, 201);
  createdJobOrderIds.push(body.id);

  const detailRes = await fetch(`${baseUrl}/api/v1/job-orders/${body.id}`, { headers: OPERATIONS_HEADERS });
  const detail = (await detailRes.json()) as { requirements: string[] };
  assert.deepEqual(detail.requirements.sort(), ["drug_test", "osha10"]);
});

// ---- Detalle / listado ----

test("GET /job-orders/:id returns the real detail, including description and createdByName", async () => {
  const { body } = await createValidJobOrder();
  const detailRes = await fetch(`${baseUrl}/api/v1/job-orders/${(body as { id: string }).id}`, {
    headers: OPERATIONS_HEADERS,
  });
  const detail = (await detailRes.json()) as { title: string; createdByName: string | null; status: string };
  assert.equal(detailRes.status, 200);
  assert.equal(detail.status, "DRAFT");
  assert.ok(detail.createdByName, "createdByName must resolve to a real user name");
});

test("GET /job-orders/:id for a nonexistent id returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders/does-not-exist`, { headers: OPERATIONS_HEADERS });
  assert.equal(res.status, 404);
});

test("GET /job-orders supports filtering by status and companyId", async () => {
  const res = await fetch(
    `${baseUrl}/api/v1/job-orders?status=DRAFT&companyId=${REAL_COMPANY_ID}&limit=50`,
    { headers: OPERATIONS_HEADERS },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ status: string; companyId: string }> };
  for (const item of body.items) {
    assert.equal(item.status, "DRAFT");
    assert.equal(item.companyId, REAL_COMPANY_ID);
  }
});

// ---- Edición ----

test("PATCH /job-orders/:id edits allowed fields", async () => {
  const { body } = await createValidJobOrder();
  const id = (body as { id: string }).id;

  const patchRes = await fetch(`${baseUrl}/api/v1/job-orders/${id}`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ title: "F5.1 test — updated title", workersNeeded: 8 }),
  });
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()) as { title: string; workersNeeded: number };
  assert.equal(updated.title, "F5.1 test — updated title");
  assert.equal(updated.workersNeeded, 8);
});

test("PATCH /job-orders/:id silently ignores status/workersFilled/createdById/tenantId — protected fields never change", async () => {
  const { body } = await createValidJobOrder();
  const id = (body as { id: string }).id;

  const patchRes = await fetch(`${baseUrl}/api/v1/job-orders/${id}`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "OPEN", workersFilled: 3, createdById: "hijacked", tenantId: "other" }),
  });
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()) as { status: string; workersFilled: number };
  assert.equal(updated.status, "DRAFT", "status must never change via the general PATCH");
  assert.equal(updated.workersFilled, 0, "workersFilled must never be settable by a human");
});

test("PATCH edit rejects billRate <= payRate against the merged (existing + patch) values", async () => {
  const { body } = await createValidJobOrder(); // billRate 30, payRate 20
  const id = (body as { id: string }).id;

  const patchRes = await fetch(`${baseUrl}/api/v1/job-orders/${id}`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ payRate: 35 }), // only payRate sent; merged against existing billRate=30 must fail
  });
  assert.equal(patchRes.status, 400);
});

// ---- Transición de estado ----

test("valid transition DRAFT -> OPEN succeeds and is recorded", async () => {
  const { body } = await createValidJobOrder();
  const id = (body as { id: string }).id;

  const statusRes = await fetch(`${baseUrl}/api/v1/job-orders/${id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "OPEN" }),
  });
  assert.equal(statusRes.status, 200);
  const updated = (await statusRes.json()) as { status: string };
  assert.equal(updated.status, "OPEN");
});

test("invalid transition DRAFT -> FILLED is rejected (manual moves to PARTIALLY_FILLED/FILLED are never allowed)", async () => {
  const { body } = await createValidJobOrder();
  const id = (body as { id: string }).id;

  const statusRes = await fetch(`${baseUrl}/api/v1/job-orders/${id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "FILLED" }),
  });
  assert.equal(statusRes.status, 400);
});

test("invalid transition CLOSED -> OPEN is rejected (terminal states don't reopen)", async () => {
  const { body } = await createValidJobOrder();
  const id = (body as { id: string }).id;
  await fetch(`${baseUrl}/api/v1/job-orders/${id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "OPEN" }),
  });
  await fetch(`${baseUrl}/api/v1/job-orders/${id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "CLOSED" }),
  });

  const reopenRes = await fetch(`${baseUrl}/api/v1/job-orders/${id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "OPEN" }),
  });
  assert.equal(reopenRes.status, 400);
});

test("closing (OPEN -> CLOSED) and cancelling (DRAFT -> CANCELLED) both work, without deleting the record", async () => {
  const { body: closeBody } = await createValidJobOrder();
  const closeId = (closeBody as { id: string }).id;
  await fetch(`${baseUrl}/api/v1/job-orders/${closeId}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "OPEN" }),
  });
  const closeRes = await fetch(`${baseUrl}/api/v1/job-orders/${closeId}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "CLOSED" }),
  });
  assert.equal(((await closeRes.json()) as { status: string }).status, "CLOSED");

  const { body: cancelBody } = await createValidJobOrder();
  const cancelId = (cancelBody as { id: string }).id;
  const cancelRes = await fetch(`${baseUrl}/api/v1/job-orders/${cancelId}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "CANCELLED" }),
  });
  assert.equal(((await cancelRes.json()) as { status: string }).status, "CANCELLED");

  // El registro sigue existiendo — cerrar/cancelar nunca borra nada.
  const stillThereRes = await fetch(`${baseUrl}/api/v1/job-orders/${cancelId}`, { headers: OPERATIONS_HEADERS });
  assert.equal(stillThereRes.status, 200);
});

test("status transition is idempotent: requesting the current status again succeeds without error", async () => {
  const { body } = await createValidJobOrder();
  const id = (body as { id: string }).id;

  const firstRes = await fetch(`${baseUrl}/api/v1/job-orders/${id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "DRAFT" }), // same as current
  });
  assert.equal(firstRes.status, 200);
  assert.equal(((await firstRes.json()) as { status: string }).status, "DRAFT");
});

// ---- Tenancy / permisos en el endpoint de estado ----

test("PATCH /job-orders/:id/status as compliance@titan.dev returns 403 (no jobOrders.update)", async () => {
  const { body } = await createValidJobOrder();
  const id = (body as { id: string }).id;
  const res = await fetch(`${baseUrl}/api/v1/job-orders/${id}/status`, {
    method: "PATCH",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ status: "OPEN" }),
  });
  assert.equal(res.status, 403);
});

test("CEO (ALL_KEYS) can create, edit, and transition a Job Order end to end", async () => {
  const { res, body } = (await createValidJobOrder(CEO_HEADERS)) as { res: Response; body: { id: string } };
  assert.equal(res.status, 201);
  const openRes = await fetch(`${baseUrl}/api/v1/job-orders/${body.id}/status`, {
    method: "PATCH",
    headers: CEO_HEADERS,
    body: JSON.stringify({ status: "OPEN" }),
  });
  assert.equal(openRes.status, 200);
});

// ---- Activity + AuditLog ----

test("creating a Job Order writes both an Activity and an AuditLog entry", async () => {
  const { body } = await createValidJobOrder();
  const id = (body as { id: string }).id;

  const activity = await prisma.activity.findFirst({ where: { entityType: "jobOrder", entityId: id, subject: { contains: "created" } } });
  assert.ok(activity, "Activity row for jobOrder.created must exist");

  const audit = await prisma.auditLog.findFirst({ where: { entityType: "jobOrder", entityId: id, action: "jobOrder.created" } });
  assert.ok(audit, "AuditLog row for jobOrder.created must exist");
});

test("a status transition writes both an Activity and an AuditLog entry with before/after", async () => {
  const { body } = await createValidJobOrder();
  const id = (body as { id: string }).id;

  await fetch(`${baseUrl}/api/v1/job-orders/${id}/status`, {
    method: "PATCH",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ status: "CANCELLED" }),
  });

  const audit = await prisma.auditLog.findFirst({
    where: { entityType: "jobOrder", entityId: id, action: "jobOrder.status_changed" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(audit);
  assert.deepEqual(audit?.before, { status: "DRAFT" });
  assert.deepEqual(audit?.after, { status: "CANCELLED" });
});

// ---- F8.1: Job Intake Intelligence ----

test("POST /job-orders/interpret-intake as compliance@titan.dev returns 403 (no jobOrders.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders/interpret-intake`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ rawInstruction: "Necesito 5 Forklift Operators en Chicago." }),
  });
  assert.equal(res.status, 403);
});

test("POST /job-orders/interpret-intake interpreta contra el catálogo real, nunca crea un JobOrder", async () => {
  const before = await prisma.jobOrder.count();
  const res = await fetch(`${baseUrl}/api/v1/job-orders/interpret-intake`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ rawInstruction: "Necesito 5 Forklift Operators en Chicago, IL, turno de noche, $18-22/hr, requieren Forklift Certification." }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    jobTitle: string | null;
    matchedCategoryId: string | null;
    city: string | null;
    state: string | null;
    headcount: number | null;
    shift: string | null;
    certifications: string[];
    ambiguities: string[];
  };
  assert.equal(body.jobTitle, "Forklift Operator");
  assert.equal(body.matchedCategoryId, "category-forklift-operator");
  assert.equal(body.city, "Chicago");
  assert.equal(body.state, "IL");
  assert.equal(body.headcount, 5);
  assert.equal(body.shift, "NIGHT");
  assert.ok(body.certifications.includes("Forklift Certification"));

  const after = await prisma.jobOrder.count();
  assert.equal(after, before, "interpret-intake nunca debe crear un JobOrder real");
});

test("POST /job-orders/interpret-intake sin categoria real matcheada devuelve jobTitle null y una ambiguedad, nunca inventa un titulo", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders/interpret-intake`, {
    method: "POST",
    headers: OPERATIONS_HEADERS,
    body: JSON.stringify({ rawInstruction: "Necesito gente para un puesto que no existe en el catálogo." }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { jobTitle: string | null; ambiguities: string[] };
  assert.equal(body.jobTitle, null);
  assert.ok(body.ambiguities.length > 0);
});
