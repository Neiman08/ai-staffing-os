// F11.3: GET /analytics/executive une recruiting/comercial/operaciones/
// financiero -- cada CAMPO dentro de cada bloque solo debe aparecer si el
// permiso real que lo respalda ya existe en el rol, exactamente el mismo
// criterio que dashboard/router.test.ts ya verifica para
// dashboard/summary (F6.8), del que este endpoint reutiliza el cálculo.
// Corre vía dev-bypass real contra tenant-titan, solo lectura.

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

interface ExecutiveBody {
  generatedAt: string;
  recruiting: Record<string, unknown>;
  commercial: Record<string, unknown>;
  operations: Record<string, unknown>;
  financial: Record<string, unknown>;
}

async function fetchExecutive(devUser: string): Promise<{ status: number; body: ExecutiveBody }> {
  const res = await fetch(`${baseUrl}/api/v1/analytics/executive`, { headers: { "x-dev-user": devUser } });
  const body = (await res.json()) as ExecutiveBody;
  return { status: res.status, body };
}

const RECRUITING_FIELDS = ["activeWorkers", "openJobOrders", "fillRate", "candidatesByStatus"];
const COMMERCIAL_FIELDS = ["newLeadsThisWeek", "openOpportunities", "pipelineValue", "scheduledMeetings"];
const FINANCIAL_FIELDS = ["weeklyHours", "weeklyGrossMargin", "billableRevenuePeriod", "dailySeries"];

interface RoleExpectation {
  role: string;
  recruiting: string[];
  commercial: boolean;
  assignmentsByStatus: boolean;
  unresolvedComplianceAlerts: boolean;
  openIncidentCount: boolean;
  financial: boolean;
}

// Derivado directamente de ROLE_PERMISSIONS en packages/db/prisma/seed.ts
// -- cada expectativa nombra el permiso real que la justifica.
const EXPECTATIONS: RoleExpectation[] = [
  {
    role: "ceo", // ALL_KEYS
    recruiting: RECRUITING_FIELDS,
    commercial: true,
    assignmentsByStatus: true,
    unresolvedComplianceAlerts: true,
    openIncidentCount: true,
    financial: true,
  },
  {
    role: "recruiter", // workers/jobOrders/candidates/assignments/documents.view -- sin leads/opportunities/incidents/payrollRuns/invoices.view
    recruiting: RECRUITING_FIELDS,
    commercial: false,
    assignmentsByStatus: true,
    unresolvedComplianceAlerts: true,
    openIncidentCount: false,
    financial: false,
  },
  {
    role: "compliance", // workers/jobOrders/candidates/assignments/documents/incidents.view -- sin leads/opportunities/payrollRuns/invoices.view
    recruiting: RECRUITING_FIELDS,
    commercial: false,
    assignmentsByStatus: true,
    unresolvedComplianceAlerts: true,
    openIncidentCount: true,
    financial: false,
  },
  {
    role: "payroll", // workers/jobOrders/assignments/payrollRuns.view -- sin candidates/leads/opportunities/documents/incidents.view
    recruiting: ["activeWorkers", "openJobOrders", "fillRate"],
    commercial: false,
    assignmentsByStatus: true,
    unresolvedComplianceAlerts: false,
    openIncidentCount: false,
    financial: true,
  },
  {
    role: "sales", // jobOrders/leads/opportunities.view -- sin workers/candidates/assignments/documents/incidents/payrollRuns/invoices.view
    recruiting: ["openJobOrders", "fillRate"],
    commercial: true,
    assignmentsByStatus: false,
    unresolvedComplianceAlerts: false,
    openIncidentCount: false,
    financial: false,
  },
  {
    role: "operations", // workers/jobOrders/assignments/incidents.view -- sin candidates/leads/opportunities/documents/payrollRuns/invoices.view
    recruiting: ["activeWorkers", "openJobOrders", "fillRate"],
    commercial: false,
    assignmentsByStatus: true,
    unresolvedComplianceAlerts: false,
    openIncidentCount: true,
    financial: false,
  },
  {
    role: "marketing", // candidates/leads/opportunities.view -- sin workers/jobOrders/assignments/documents/incidents/payrollRuns/invoices.view
    recruiting: ["candidatesByStatus"],
    commercial: true,
    assignmentsByStatus: false,
    unresolvedComplianceAlerts: false,
    openIncidentCount: false,
    financial: false,
  },
  {
    role: "hr", // candidates/workers/documents/incidents.view -- sin jobOrders/assignments/leads/opportunities/payrollRuns/invoices.view
    recruiting: ["activeWorkers", "candidatesByStatus"],
    commercial: false,
    assignmentsByStatus: false,
    unresolvedComplianceAlerts: true,
    openIncidentCount: true,
    financial: false,
  },
  {
    role: "accounting", // payrollRuns/invoices.view -- sin workers/candidates/jobOrders/assignments/documents/incidents/leads/opportunities.view
    recruiting: [],
    commercial: false,
    assignmentsByStatus: false,
    unresolvedComplianceAlerts: false,
    openIncidentCount: false,
    financial: true,
  },
  {
    role: "manager", // candidates/workers/jobOrders/assignments/documents/leads/opportunities/invoices/incidents.view: casi todo
    recruiting: RECRUITING_FIELDS,
    commercial: true,
    assignmentsByStatus: true,
    unresolvedComplianceAlerts: true,
    openIncidentCount: true,
    financial: true, // invoices.view alcanza (canViewFinancials = payrollRuns.view || invoices.view)
  },
];

for (const exp of EXPECTATIONS) {
  test(`GET /analytics/executive as ${exp.role}@titan.dev exposes exactly the fields its permissions cover`, async () => {
    const { status, body } = await fetchExecutive(`${exp.role}@titan.dev`);
    assert.equal(status, 200, `${exp.role} debería poder llegar al endpoint (nunca 403)`);

    for (const field of RECRUITING_FIELDS) {
      const shouldBePresent = exp.recruiting.includes(field);
      assert.equal(
        body.recruiting[field] !== undefined,
        shouldBePresent,
        `${exp.role}: recruiting.${field} ${shouldBePresent ? "debería estar presente" : "NO debería estar presente"}`,
      );
    }

    for (const field of COMMERCIAL_FIELDS) {
      assert.equal(
        body.commercial[field] !== undefined,
        exp.commercial,
        `${exp.role}: commercial.${field} ${exp.commercial ? "debería estar presente" : "NO debería estar presente"}`,
      );
    }

    assert.equal(body.operations.assignmentsByStatus !== undefined, exp.assignmentsByStatus, `${exp.role}: operations.assignmentsByStatus`);
    assert.equal(
      body.operations.unresolvedComplianceAlerts !== undefined,
      exp.unresolvedComplianceAlerts,
      `${exp.role}: operations.unresolvedComplianceAlerts`,
    );
    assert.equal(body.operations.openIncidentCount !== undefined, exp.openIncidentCount, `${exp.role}: operations.openIncidentCount`);

    for (const field of FINANCIAL_FIELDS) {
      assert.equal(body.financial[field] !== undefined, exp.financial, `${exp.role}: financial.${field}`);
    }
  });
}

test("ninguna identidad de portal puede alcanzar /analytics/executive (requireInternalIdentity)", async () => {
  for (const devUser of ["worker-portal@titan.dev", "candidate-portal@titan.dev", "client-admin@titan.dev", "client-manager@titan.dev"]) {
    const { status } = await fetchExecutive(devUser);
    assert.equal(status, 403, `${devUser} debería recibir 403`);
  }
});

test("tenancy: el executive dashboard de tenant-titan tiene conteos no negativos y coherentes (spot-check)", async () => {
  const { body } = await fetchExecutive("ceo@titan.dev");
  assert.equal(typeof body.recruiting.activeWorkers, "number");
  assert.ok((body.recruiting.activeWorkers as number) >= 0);
  assert.equal(typeof body.recruiting.fillRate, "number");
  assert.ok((body.recruiting.fillRate as number) >= 0 && (body.recruiting.fillRate as number) <= 1);
  assert.equal(typeof body.commercial.pipelineValue, "string");
});
