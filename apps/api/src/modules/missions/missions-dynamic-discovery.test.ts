// F7.3: prueba de integración real de punta a punta —
// POST /missions con una instrucción que el LLM real
// (interpretDailyDirective) interpreta como useExternalDiscovery=true,
// contra tenant-titan (mismo tenant real que missions.test.ts). Ejercita
// el "pegamento" agregado a mission-orchestrator.ts (runDynamicDiscoveryMission)
// que no está cubierto por mission-executor.test.ts (ese usa providers
// mockeados) — esta es la ÚNICA prueba de esta suite que hace una
// llamada real a Google Places (misma tolerancia a costo real que
// discovery.test.ts, que ya hace lo mismo), acotada a Manufacturing/
// Illinois (bucket real aprobado) y a lo sumo 2 empresas.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };
const createdMissionIds: string[] = [];
const createdCompanyIds: string[] = [];

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
  if (createdCompanyIds.length) {
    await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  }
  for (const id of createdMissionIds) {
    const children = await prisma.agentTask.findMany({ where: { parentTaskId: id } });
    const childIds = children.map((c) => c.id);
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [id, ...childIds] } } });
    await prisma.activity.deleteMany({ where: { entityId: { in: [id, ...childIds] } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: childIds } } });
    await prisma.agentTask.delete({ where: { id } }).catch(() => {});
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitForMissionSettled(missionId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await prisma.agentTask.findUniqueOrThrow({ where: { id: missionId } });
    const missionState = (task.output as { missionState?: string } | null)?.missionState ?? "RUNNING";
    if (missionState !== "RUNNING" && missionState !== "PAUSED_BUDGET") return missionState;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Mission ${missionId} did not settle within ${timeoutMs}ms`);
}

test("una instrucción de descubrimiento externo (Manufacturing/IL, bucket real) ejecuta el nuevo ejecutor dinámico, nunca crea Lead/Opportunity/Campaign/Contact", async () => {
  const [leadsBefore, oppsBefore, campaignsBefore, contactsBefore] = await Promise.all([
    prisma.lead.count({ where: { tenantId: "tenant-titan" } }),
    prisma.opportunity.count({ where: { tenantId: "tenant-titan" } }),
    prisma.campaign.count({ where: { tenantId: "tenant-titan" } }),
    prisma.contact.count({ where: { tenantId: "tenant-titan" } }),
  ]);

  const res = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({
      instruction:
        "Busca empresas de manufactura en Illinois que estén fuera de nuestro CRM, mediante búsqueda externa en fuentes externas/internet. Quiero encontrar 2 empresas nuevas. No crear campañas ni oportunidades.",
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string };
  createdMissionIds.push(body.id);

  const missionState = await waitForMissionSettled(body.id);
  assert.ok(
    ["COMPLETED", "PARTIAL", "NO_RESULTS", "BLOCKED"].includes(missionState),
    `estado final inesperado: ${missionState}`,
  );
  assert.notEqual(missionState, "FAILED");

  const detailRes = await fetch(`${baseUrl}/api/v1/missions/${body.id}`, { headers: SALES_HEADERS });
  const detail = (await detailRes.json()) as {
    discoveryExecution: {
      companiesCreated: number;
      createdCompanyIds: string[];
      missionState: string;
      restrictionsApplied: string[];
      queryExecutions: unknown[];
    } | null;
    missionPhase: string | null;
    childTasks: Array<{ type: string }>;
  };
  assert.ok(detail.discoveryExecution, "debe incluir el reporte del ejecutor dinámico");
  assert.equal(detail.missionPhase, "EXECUTING");
  assert.ok(detail.discoveryExecution!.companiesCreated <= 2);
  createdCompanyIds.push(...detail.discoveryExecution!.createdCompanyIds);
  assert.ok(
    detail.discoveryExecution!.restrictionsApplied.some((n) => n.includes("Lead/Opportunity/Campaign/Contact")),
  );
  assert.equal(
    detail.childTasks.filter((t) => t.type === "discover_companies").length,
    1,
    "exactamente un AgentTask hijo de discover_companies (el del nuevo ejecutor)",
  );

  const [leadsAfter, oppsAfter, campaignsAfter, contactsAfter] = await Promise.all([
    prisma.lead.count({ where: { tenantId: "tenant-titan" } }),
    prisma.opportunity.count({ where: { tenantId: "tenant-titan" } }),
    prisma.campaign.count({ where: { tenantId: "tenant-titan" } }),
    prisma.contact.count({ where: { tenantId: "tenant-titan" } }),
  ]);
  assert.equal(leadsAfter, leadsBefore, "cero Lead creado por el flujo dinámico");
  assert.equal(oppsAfter, oppsBefore, "cero Opportunity creada por el flujo dinámico");
  assert.equal(campaignsAfter, campaignsBefore, "cero Campaign creada por el flujo dinámico");
  assert.equal(contactsAfter, contactsBefore, "cero Contact creado por el flujo dinámico (Contact Intelligence no corre en esta fase)");
});
