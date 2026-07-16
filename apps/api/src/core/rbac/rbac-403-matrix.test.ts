// F6.9: cierre de la deuda de tests RBAC 403 heredada de F5 (ver plan
// aprobado docs/F6_AUTONOMOUS_RECRUITING_AND_OPERATIONS_PLAN.md §"24
// permission keys de F5.1-F5.3, sin test de 403" — extendido acá a
// candidates/workers/jobOrders/documents/timeEntries/pricingScenarios/
// assignments/payroll(Runs)/invoices/payments, además de matching que ya
// quedó cubierto en F6.6). Matriz completa: para cada endpoint
// permission-gated, cada uno de los 11 roles reales del seed obtiene
// exactamente 403 si le falta el permiso, o algo distinto de 403 si lo
// tiene — nunca al revés. requirePermission() corre ANTES que cualquier
// lookup de recurso, así que un id inexistente en el path nunca
// contamina el resultado de un rol SIN el permiso (siempre 403, nunca
// pasa a buscar el recurso). Solo lectura — cero mutación de datos
// reales, ningún endpoint de escritura se ejecuta con un id real.

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

const ALL_ROLES = [
  "ceo",
  "admin",
  "recruiter",
  "compliance",
  "payroll",
  "sales",
  "operations",
  "marketing",
  "hr",
  "accounting",
  "manager",
] as const;

async function requestAs(role: string, method: string, path: string) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { "x-dev-user": `${role}@titan.dev`, "content-type": "application/json" },
    body: method === "GET" ? undefined : "{}",
  });
}

interface Endpoint {
  label: string;
  method: string;
  path: string;
  // Derivado literal de ROLE_PERMISSIONS en packages/db/prisma/seed.ts —
  // cada set acá es una copia de verificación, no una fuente nueva.
  grantedTo: readonly string[];
}

const ENDPOINTS: Endpoint[] = [
  {
    label: "candidates.view — GET /candidates",
    method: "GET",
    path: "/candidates",
    grantedTo: ["ceo", "admin", "recruiter", "compliance", "marketing", "hr", "manager"],
  },
  {
    label: "workers.view — GET /workers",
    method: "GET",
    path: "/workers",
    grantedTo: ["ceo", "admin", "recruiter", "compliance", "payroll", "operations", "hr", "manager"],
  },
  {
    label: "jobOrders.view — GET /job-orders",
    method: "GET",
    path: "/job-orders",
    grantedTo: ["ceo", "admin", "recruiter", "compliance", "payroll", "sales", "operations", "manager"],
  },
  {
    label: "documents.view — GET /documents",
    method: "GET",
    path: "/documents",
    grantedTo: ["ceo", "admin", "recruiter", "compliance", "hr", "manager"],
  },
  {
    label: "timeEntries.view — GET /time-entries",
    method: "GET",
    path: "/time-entries",
    grantedTo: ["ceo", "admin", "payroll", "operations", "accounting", "manager"],
  },
  {
    label: "pricingScenarios.view — GET /pricing/scenarios",
    method: "GET",
    path: "/pricing/scenarios",
    grantedTo: ["ceo", "admin", "payroll", "sales", "accounting", "manager"],
  },
  {
    label: "assignments.view — GET /assignments",
    method: "GET",
    path: "/assignments",
    grantedTo: ["ceo", "admin", "recruiter", "compliance", "payroll", "operations", "manager"],
  },
  {
    label: "payrollRuns.view — GET /payroll/runs",
    method: "GET",
    path: "/payroll/runs",
    grantedTo: ["ceo", "admin", "payroll", "accounting"],
  },
  {
    label: "invoices.view — GET /invoices",
    method: "GET",
    path: "/invoices",
    grantedTo: ["ceo", "admin", "accounting", "manager"],
  },
  {
    label: "invoices.update — POST /invoices/:id/payments (payments)",
    method: "POST",
    path: "/invoices/rbac-matrix-fake-invoice-id/payments",
    grantedTo: ["ceo", "admin", "accounting"],
  },
  {
    label: "matching.view — GET /job-orders/:id/matching/latest",
    method: "GET",
    path: "/job-orders/rbac-matrix-fake-job-order-id/matching/latest",
    grantedTo: ["ceo", "admin", "recruiter", "compliance", "operations", "manager"],
  },
  {
    label: "matching.run — POST /job-orders/:id/matching/run",
    method: "POST",
    path: "/job-orders/rbac-matrix-fake-job-order-id/matching/run",
    grantedTo: ["ceo", "admin", "recruiter"],
  },
];

for (const endpoint of ENDPOINTS) {
  test(`RBAC matrix — ${endpoint.label}`, async () => {
    for (const role of ALL_ROLES) {
      const res = await requestAs(role, endpoint.method, endpoint.path);
      if (endpoint.grantedTo.includes(role)) {
        assert.notEqual(
          res.status,
          403,
          `${role} tiene el permiso de "${endpoint.label}" — no debería recibir 403`,
        );
      } else {
        assert.equal(
          res.status,
          403,
          `${role} NO tiene el permiso de "${endpoint.label}" — debería recibir 403, recibió ${res.status}`,
        );
      }
    }
  });
}

test("la matriz cubre los 11 roles reales del seed para cada endpoint (coherencia del propio test)", () => {
  for (const endpoint of ENDPOINTS) {
    for (const role of endpoint.grantedTo) {
      assert.ok(
        (ALL_ROLES as readonly string[]).includes(role),
        `"${role}" en grantedTo de "${endpoint.label}" no es uno de los 11 roles reales`,
      );
    }
  }
});
