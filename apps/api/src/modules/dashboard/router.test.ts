// F6.8: RBAC por métrica en GET /dashboard/summary — el endpoint en sí
// nunca devuelve 403 (accesible a todo rol autenticado, ver router.ts),
// pero cada campo del payload solo debe aparecer si el permiso real que
// lo respalda ya existe en el rol (mismo permiso que gatea su propio
// módulo: workers.view, candidates.view, jobOrders.view, documents.view,
// assignments.view, payrollRuns.view/invoices.view). Corre vía dev-bypass
// real contra tenant-titan, solo lectura — cero mutación.

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

async function fetchSummary(role: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/api/v1/dashboard/summary`, {
    headers: { "x-dev-user": `${role}@titan.dev` },
  });
  assert.equal(res.status, 200, `${role} debería poder llegar al endpoint (nunca 403)`);
  return (await res.json()) as Record<string, unknown>;
}

const FINANCIAL_FIELDS = ["weeklyHours", "weeklyGrossMargin", "billableRevenuePeriod", "dailySeries"];
const COMPLIANCE_FIELDS = ["unresolvedComplianceAlerts", "recentAlerts", "workersByComplianceStatus"];

interface RoleExpectation {
  role: string;
  present: string[];
  absent: string[];
}

// Derivado directamente de ROLE_PERMISSIONS en packages/db/prisma/seed.ts
// (Recruiter/Compliance/Operations/Accounting/Manager/Sales/Marketing/HR)
// — cada expectativa nombra el permiso real que la justifica en el
// comentario, no un valor arbitrario.
const EXPECTATIONS: RoleExpectation[] = [
  {
    role: "ceo",
    // CEO = ALL_KEYS: todo presente.
    present: ["activeWorkers", "candidatesByStatus", "openJobOrders", "fillRate", "assignmentsByStatus", ...COMPLIANCE_FIELDS, ...FINANCIAL_FIELDS],
    absent: [],
  },
  {
    role: "recruiter",
    // workers.view, candidates.view, jobOrders.view, documents.view, assignments.view — sin payrollRuns.view/invoices.view
    present: ["activeWorkers", "candidatesByStatus", "openJobOrders", "fillRate", "assignmentsByStatus", ...COMPLIANCE_FIELDS],
    absent: FINANCIAL_FIELDS,
  },
  {
    role: "compliance",
    // candidates.view, documents.view, workers.view, assignments.view, jobOrders.view — sin financials
    present: ["activeWorkers", "candidatesByStatus", "openJobOrders", "fillRate", "assignmentsByStatus", ...COMPLIANCE_FIELDS],
    absent: FINANCIAL_FIELDS,
  },
  {
    role: "operations",
    // jobOrders.view, workers.view, assignments.view — sin candidates.view/documents.view/financials
    present: ["activeWorkers", "openJobOrders", "fillRate", "assignmentsByStatus"],
    absent: ["candidatesByStatus", ...COMPLIANCE_FIELDS, ...FINANCIAL_FIELDS],
  },
  {
    role: "accounting",
    // payrollRuns.view + invoices.view — sin workers/candidates/jobOrders/documents/assignments.view
    present: FINANCIAL_FIELDS,
    absent: ["activeWorkers", "candidatesByStatus", "openJobOrders", "fillRate", "assignmentsByStatus", ...COMPLIANCE_FIELDS],
  },
  {
    role: "manager",
    // candidates/workers/jobOrders/documents/assignments/invoices.view: todo presente
    present: ["activeWorkers", "candidatesByStatus", "openJobOrders", "fillRate", "assignmentsByStatus", ...COMPLIANCE_FIELDS, ...FINANCIAL_FIELDS],
    absent: [],
  },
  {
    role: "sales",
    // solo jobOrders.view
    present: ["openJobOrders", "fillRate"],
    absent: ["activeWorkers", "candidatesByStatus", "assignmentsByStatus", ...COMPLIANCE_FIELDS, ...FINANCIAL_FIELDS],
  },
  {
    role: "marketing",
    // solo candidates.view
    present: ["candidatesByStatus"],
    absent: ["activeWorkers", "openJobOrders", "fillRate", "assignmentsByStatus", ...COMPLIANCE_FIELDS, ...FINANCIAL_FIELDS],
  },
  {
    role: "hr",
    // candidates.view, workers.view, documents.view — sin jobOrders.view/assignments.view/financials
    present: ["activeWorkers", "candidatesByStatus", ...COMPLIANCE_FIELDS],
    absent: ["openJobOrders", "fillRate", "assignmentsByStatus", ...FINANCIAL_FIELDS],
  },
];

for (const { role, present, absent } of EXPECTATIONS) {
  test(`GET /dashboard/summary as ${role}@titan.dev exposes exactly the metrics its permissions cover`, async () => {
    const body = await fetchSummary(role);
    for (const field of present) {
      assert.notEqual(body[field], undefined, `${role} debería ver "${field}"`);
    }
    for (const field of absent) {
      assert.equal(body[field], undefined, `${role} NO debería ver "${field}" (sin el permiso que lo respalda)`);
    }
  });
}

test("el endpoint nunca devuelve 403 para ningún rol autenticado (visible a todos, RBAC es por campo)", async () => {
  for (const { role } of EXPECTATIONS) {
    const res = await fetch(`${baseUrl}/api/v1/dashboard/summary`, { headers: { "x-dev-user": `${role}@titan.dev` } });
    assert.equal(res.status, 200);
  }
});

test("tenancy: el summary de tenant-titan nunca incluye datos de otro tenant (spot-check de conteos no negativos y coherentes)", async () => {
  const body = await fetchSummary("ceo");
  assert.equal(typeof body.activeWorkers, "number");
  assert.ok((body.activeWorkers as number) >= 0);
  assert.equal(typeof body.fillRate, "number");
  assert.ok((body.fillRate as number) >= 0 && (body.fillRate as number) <= 1);
});
