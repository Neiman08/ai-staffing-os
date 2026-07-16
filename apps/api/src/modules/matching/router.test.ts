// F6.6: RBAC HTTP-level para los endpoints de matching — usa el dev-bypass
// real (x-dev-user) contra tenant-titan, pero SOLO ejercita caminos de
// solo lectura o negados (403 nunca llega al handler, GET .../latest y
// .../history son de solo lectura) — nunca dispara POST .../run contra
// datos reales (esa escritura ya se prueba exhaustivamente en
// matching-api.test.ts contra fixtures sintéticos). Cero mutación de
// datos reales en este archivo.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../app";

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

const REAL_JOB_ORDER_ID = "joborder-01";

const VIEW_ALLOWED = ["ceo", "admin", "recruiter", "operations", "compliance", "manager"];
const VIEW_DENIED = ["payroll", "accounting", "sales", "marketing", "hr"];
const RUN_ALLOWED = ["ceo", "admin", "recruiter"];
const RUN_DENIED = ["operations", "compliance", "manager", "payroll", "accounting", "sales", "marketing", "hr"];

for (const role of VIEW_ALLOWED) {
  test(`GET .../matching/latest as ${role}@titan.dev is not blocked by RBAC (matching.view granted)`, async () => {
    const res = await fetch(`${baseUrl}/api/v1/job-orders/${REAL_JOB_ORDER_ID}/matching/latest`, {
      headers: { "x-dev-user": `${role}@titan.dev` },
    });
    // 404 (nunca se corrió matching para este Job Order todavía) es la
    // respuesta esperada de un rol CON permiso — lo único que se
    // verifica acá es que RBAC no lo bloqueó con 403.
    assert.notEqual(res.status, 403, `${role} debería tener matching.view`);
  });
}

for (const role of VIEW_DENIED) {
  test(`GET .../matching/latest as ${role}@titan.dev returns 403 (no matching.view)`, async () => {
    const res = await fetch(`${baseUrl}/api/v1/job-orders/${REAL_JOB_ORDER_ID}/matching/latest`, {
      headers: { "x-dev-user": `${role}@titan.dev` },
    });
    assert.equal(res.status, 403);
  });
}

for (const role of VIEW_DENIED) {
  test(`GET .../matching/history as ${role}@titan.dev returns 403 (no matching.view)`, async () => {
    const res = await fetch(`${baseUrl}/api/v1/job-orders/${REAL_JOB_ORDER_ID}/matching/history`, {
      headers: { "x-dev-user": `${role}@titan.dev` },
    });
    assert.equal(res.status, 403);
  });
}

for (const role of VIEW_ALLOWED) {
  test(`GET .../matching/history as ${role}@titan.dev is not blocked by RBAC (matching.view granted)`, async () => {
    const res = await fetch(`${baseUrl}/api/v1/job-orders/${REAL_JOB_ORDER_ID}/matching/history`, {
      headers: { "x-dev-user": `${role}@titan.dev` },
    });
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    assert.ok(Array.isArray(body.items));
  });
}

for (const role of RUN_DENIED) {
  test(`POST .../matching/run as ${role}@titan.dev returns 403 (no matching.run) — nunca llega a ejecutar nada`, async () => {
    const res = await fetch(`${baseUrl}/api/v1/job-orders/${REAL_JOB_ORDER_ID}/matching/run`, {
      method: "POST",
      headers: { "x-dev-user": `${role}@titan.dev`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
  });
}

test("RUN_ALLOWED (CEO/Admin/Recruiter) no está en RUN_DENIED — matriz coherente con F6.1", () => {
  for (const role of RUN_ALLOWED) assert.ok(!RUN_DENIED.includes(role));
});

test("GET .../matching/latest para un Job Order inexistente devuelve 404, no 500 (verify-then-act)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/job-orders/does-not-exist/matching/latest`, {
    headers: { "x-dev-user": "recruiter@titan.dev" },
  });
  assert.equal(res.status, 404);
});
