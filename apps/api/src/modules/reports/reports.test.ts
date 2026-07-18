// F9.11: RBAC por métrica en GET /reports/operational -- el endpoint en
// sí nunca devuelve 403 (accesible a todo rol autenticado, mismo
// criterio que /dashboard/summary, F6.8), pero cada campo del payload
// solo debe aparecer si el permiso real que lo respalda ya existe en el
// rol (workers.view, documents.view, assignments.view, timeEntries.view,
// shifts.view, incidents.view). Corre vía dev-bypass real contra
// tenant-titan, solo lectura -- cero mutación.

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

async function fetchReport(role: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/api/v1/reports/operational`, {
    headers: { "x-dev-user": `${role}@titan.dev` },
  });
  assert.equal(res.status, 200, `${role} debería poder llegar al endpoint (nunca 403)`);
  return (await res.json()) as Record<string, unknown>;
}

const ONBOARDING_FIELDS = ["onboardingByStatus", "checklistItemsByStatus"];
const COMPLIANCE_FIELDS = ["complianceEvaluationsByStatus"];
const OPS_FIELDS = ["placementsByStatus", "assignmentsByStatus"];
const TIME_FIELDS = ["timeEntriesByStatus", "timeEntryFlagCounts"];
const SHIFT_FIELDS = ["shiftCount"];
const INCIDENT_FIELDS = ["incidentsByStatus", "incidentsByType", "openIncidentCount"];
const ALL_GATED_FIELDS = [...ONBOARDING_FIELDS, ...COMPLIANCE_FIELDS, ...OPS_FIELDS, ...TIME_FIELDS, ...SHIFT_FIELDS, ...INCIDENT_FIELDS];

interface RoleExpectation {
  role: string;
  present: string[];
  absent: string[];
}

// Derivado directamente de ROLE_PERMISSIONS en packages/db/prisma/seed.ts
// -- cada expectativa se explica por el permiso real que la respalda.
const EXPECTATIONS: RoleExpectation[] = [
  {
    role: "ceo",
    present: ALL_GATED_FIELDS,
    absent: [],
  },
  {
    role: "recruiter",
    // workers.view, assignments.view, documents.view -- sin timeEntries.view/shifts.view/incidents.view
    present: [...ONBOARDING_FIELDS, ...COMPLIANCE_FIELDS, ...OPS_FIELDS],
    absent: [...TIME_FIELDS, ...SHIFT_FIELDS, ...INCIDENT_FIELDS],
  },
  {
    role: "compliance",
    // workers.view, documents.view, assignments.view, incidents.view -- sin timeEntries.view/shifts.view
    present: [...ONBOARDING_FIELDS, ...COMPLIANCE_FIELDS, ...OPS_FIELDS, ...INCIDENT_FIELDS],
    absent: [...TIME_FIELDS, ...SHIFT_FIELDS],
  },
  {
    role: "payroll",
    // workers.view, assignments.view, timeEntries.view, shifts.view -- sin documents.view/incidents.view
    present: [...ONBOARDING_FIELDS, ...OPS_FIELDS, ...TIME_FIELDS, ...SHIFT_FIELDS],
    absent: [...COMPLIANCE_FIELDS, ...INCIDENT_FIELDS],
  },
  {
    role: "operations",
    // workers.view, assignments.view, timeEntries.view, shifts.view, incidents.view -- sin documents.view
    present: [...ONBOARDING_FIELDS, ...OPS_FIELDS, ...TIME_FIELDS, ...SHIFT_FIELDS, ...INCIDENT_FIELDS],
    absent: COMPLIANCE_FIELDS,
  },
  {
    role: "hr",
    // workers.view, documents.view, incidents.view -- sin assignments.view/timeEntries.view/shifts.view
    present: [...ONBOARDING_FIELDS, ...COMPLIANCE_FIELDS, ...INCIDENT_FIELDS],
    absent: [...OPS_FIELDS, ...TIME_FIELDS, ...SHIFT_FIELDS],
  },
  {
    role: "accounting",
    // timeEntries.view -- sin workers.view/documents.view/assignments.view/shifts.view/incidents.view
    present: TIME_FIELDS,
    absent: [...ONBOARDING_FIELDS, ...COMPLIANCE_FIELDS, ...OPS_FIELDS, ...SHIFT_FIELDS, ...INCIDENT_FIELDS],
  },
  {
    role: "manager",
    // workers/documents/assignments/timeEntries/shifts/incidents.view: todo presente
    present: ALL_GATED_FIELDS,
    absent: [],
  },
  {
    role: "sales",
    // ninguno de los permisos que respaldan estos campos
    present: [],
    absent: ALL_GATED_FIELDS,
  },
];

for (const { role, present, absent } of EXPECTATIONS) {
  test(`GET /reports/operational as ${role}@titan.dev exposes exactly the metrics its permissions cover`, async () => {
    const body = await fetchReport(role);
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
    const res = await fetch(`${baseUrl}/api/v1/reports/operational`, { headers: { "x-dev-user": `${role}@titan.dev` } });
    assert.equal(res.status, 200);
  }
});

test("generatedAt is always present, is a real ISO timestamp, never omitted regardless of permissions", async () => {
  const body = await fetchReport("sales");
  assert.equal(typeof body.generatedAt, "string");
  assert.ok(!Number.isNaN(new Date(body.generatedAt as string).getTime()));
});

test("counts are real non-negative integers, never invented/predicted values", async () => {
  const body = await fetchReport("ceo");
  const incidentsByStatus = body.incidentsByStatus as Record<string, number>;
  for (const [, count] of Object.entries(incidentsByStatus)) {
    assert.ok(Number.isInteger(count) && count >= 0);
  }
  assert.ok(Number.isInteger(body.openIncidentCount) && (body.openIncidentCount as number) >= 0);
});
