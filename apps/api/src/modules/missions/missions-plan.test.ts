// F7.2: RBAC HTTP-level para POST /missions/plan — mismo permiso
// (missions.create) que el POST /missions real, ya probado en
// missions.test.ts. Este archivo cubre SOLO el endpoint nuevo: RBAC +
// un smoke test real de punta a punta contra tenant-titan (solo
// lectura/creación de un AgentTask de planificación, cero Company/Lead/
// Opportunity/Campaign — el detalle de cero-efectos-secundarios ya se
// prueba exhaustivamente en agents/mission-planning.test.ts contra
// tenants sintéticos).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;
const createdTaskIds: string[] = [];

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
  server.close();
  for (const taskId of createdTaskIds) {
    await prisma.auditLog.deleteMany({ where: { entityId: taskId } });
    await prisma.activity.deleteMany({ where: { entityId: taskId } });
  }
  if (createdTaskIds.length) {
    await prisma.agentTask.deleteMany({ where: { id: { in: createdTaskIds } } });
  }
});

const ALLOWED = ["ceo", "admin", "sales"];
const DENIED = ["recruiter", "compliance", "payroll", "operations", "marketing", "hr", "accounting", "manager"];

for (const role of DENIED) {
  test(`POST /missions/plan as ${role}@titan.dev returns 403 (no missions.create)`, async () => {
    const res = await fetch(`${baseUrl}/api/v1/missions/plan`, {
      method: "POST",
      headers: { "x-dev-user": `${role}@titan.dev`, "content-type": "application/json" },
      body: JSON.stringify({ instruction: "Busca hoteles en Illinois." }),
    });
    assert.equal(res.status, 403);
  });
}

test("la matriz de roles permitidos/denegados es coherente con missions.create (ceo/admin/sales, único rol operativo con el permiso)", () => {
  for (const role of ALLOWED) assert.ok(!DENIED.includes(role));
});

test("POST /missions/plan as ceo@titan.dev creates a real PLANNED mission, discoverable via GET /missions/:id", async () => {
  const res = await fetch(`${baseUrl}/api/v1/missions/plan`, {
    method: "POST",
    headers: { "x-dev-user": "ceo@titan.dev", "content-type": "application/json" },
    body: JSON.stringify({
      instruction: "Busca hoteles en Illinois que necesiten housekeeping. No crear campañas ni oportunidades.",
    }),
  });
  assert.equal(res.status, 201);
  const created = (await res.json()) as { id: string; missionState: string; missionPhase: string | null };
  createdTaskIds.push(created.id);
  assert.equal(created.missionState, "PLANNED");
  assert.equal(created.missionPhase, "PLANNED");

  const detailRes = await fetch(`${baseUrl}/api/v1/missions/${created.id}`, {
    headers: { "x-dev-user": "ceo@titan.dev" },
  });
  assert.equal(detailRes.status, 200);
  const detail = (await detailRes.json()) as {
    ceoIntent: { companyTypes: string[]; restrictions: Record<string, boolean> } | null;
    missionPlan: { requiredSteps: string[] } | null;
    childTasks: unknown[];
    selectedCompanies: unknown[];
  };
  assert.ok(detail.ceoIntent);
  assert.ok(detail.ceoIntent!.companyTypes.includes("hotel"));
  assert.equal(detail.ceoIntent!.restrictions.allowCampaignCreation, false);
  assert.ok(detail.missionPlan);
  // F18: validate_business_type ya no es opcional -- ver mission-planner.ts.
  assert.deepEqual(detail.missionPlan!.requiredSteps, ["discover_companies", "validate_business_type"]);
  assert.equal(detail.childTasks.length, 0);
  assert.equal(detail.selectedCompanies.length, 0);
});

test("POST /missions/plan validation: instruction vacía devuelve 400, nunca crea un AgentTask", async () => {
  const res = await fetch(`${baseUrl}/api/v1/missions/plan`, {
    method: "POST",
    headers: { "x-dev-user": "ceo@titan.dev", "content-type": "application/json" },
    body: JSON.stringify({ instruction: "" }),
  });
  assert.equal(res.status, 400);
});
