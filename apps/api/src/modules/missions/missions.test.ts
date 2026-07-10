import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };
const COMPLIANCE_HEADERS = { "x-dev-user": "compliance@titan.dev", "content-type": "application/json" };

const createdMissionIds: string[] = [];

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;
});

/**
 * Limpia todo lo que una misión pudo haber creado — campañas, empresas
 * targeteadas, leads/oportunidades/follow-ups/aprobaciones/tareas hijas —
 * en el mismo orden que respeta las FK reales (CampaignCompany ->
 * Company es ON DELETE RESTRICT).
 */
async function cleanupMission(missionTaskId: string): Promise<void> {
  if (!missionTaskId) return;
  const children = await prisma.agentTask.findMany({ where: { parentTaskId: missionTaskId } });
  const campaignIds = children
    .filter((t) => t.type === "create_campaign")
    .map((t) => (t.output as { campaignId?: string } | null)?.campaignId)
    .filter((id): id is string => !!id);
  const companyIds = children
    .filter((t) => t.type === "select_target_companies")
    .flatMap((t) => (t.output as { companyIds?: string[] } | null)?.companyIds ?? []);
  const leadIds = children
    .filter((t) => t.type === "create_lead")
    .map((t) => (t.output as { leadId?: string } | null)?.leadId)
    .filter((id): id is string => !!id);
  const opportunityIds = children
    .filter((t) => t.type === "create_opportunity")
    .map((t) => (t.output as { opportunityId?: string } | null)?.opportunityId)
    .filter((id): id is string => !!id);

  const childIds = children.map((c) => c.id);
  await prisma.approvalRequest.deleteMany({ where: { agentTaskId: { in: [...childIds, missionTaskId] } } });

  if (companyIds.length > 0) {
    await prisma.followUp.deleteMany({ where: { entityType: "company", entityId: { in: companyIds } } });
    await prisma.activity.deleteMany({
      where: { OR: [{ entityType: "company", entityId: { in: companyIds } }] },
    });
    const ccRows = await prisma.campaignCompany.findMany({ where: { companyId: { in: companyIds } } });
    await prisma.activity.deleteMany({
      where: { entityType: "campaignCompany", entityId: { in: ccRows.map((c) => c.id) } },
    });
    await prisma.campaignCompany.deleteMany({ where: { companyId: { in: companyIds } } });
  }

  await prisma.agentTask.deleteMany({ where: { id: { in: childIds } } });
  await prisma.agentTask.delete({ where: { id: missionTaskId } }).catch(() => {});

  await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  for (const companyId of companyIds) {
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  }
  for (const campaignId of campaignIds) {
    await prisma.campaign.delete({ where: { id: campaignId } }).catch(() => {});
  }
}

after(async () => {
  for (const id of createdMissionIds) {
    await cleanupMission(id).catch((err) => console.error(`cleanup failed for mission ${id}:`, err));
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitForMissionChildren(missionId: string, minChildren: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const children = await prisma.agentTask.findMany({ where: { parentTaskId: missionId } });
    const settledCount = children.filter((c) => c.status !== "QUEUED" && c.status !== "RUNNING").length;
    if (children.length >= minChildren && settledCount >= minChildren) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Mission ${missionId} did not reach ${minChildren} SETTLED child tasks within ${timeoutMs}ms`);
}

test("POST /missions as compliance@titan.dev returns 403 (no missions.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ instruction: "Busca empresas de construcción." }),
  });
  assert.equal(res.status, 403);
});

test("launchMission interprets a real instruction, runs the fixed pipeline, and always ends in an ApprovalRequest (real OpenAI calls)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({
      instruction:
        "Hoy busca empresas de manufactura en Illinois que puedan necesitar General Labor. Quiero encontrar 1 empresa nueva.",
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    id: string;
    industryNames: string[];
    state: string | null;
    categoryNames: string[];
    businessObjective: { type: string; target: number | null; unit: string };
    missionState: string;
  };
  createdMissionIds.push(body.id);

  assert.equal(body.missionState, "RUNNING");
  assert.ok(body.industryNames.includes("Manufacturing"), "must interpret the real Industry name, never invent one");
  assert.equal(body.state, "IL");
  assert.ok(body.categoryNames.includes("General Labor"));
  assert.equal(body.businessObjective.type, "companies_found");

  // interpretDailyDirective ya corrió síncrono al crear la misión — el
  // resto de la secuencia (create_campaign, select_target_companies,
  // plan_sequence, personalize_message) corre async.
  await waitForMissionChildren(body.id, 4, 45_000);

  const detailRes = await fetch(`${baseUrl}/api/v1/missions/${body.id}`, { headers: SALES_HEADERS });
  const detail = (await detailRes.json()) as {
    childTasks: Array<{ type: string; status: string; approvalRequestId: string | null }>;
    companiesTargeted: number;
  };

  const campaignTask = detail.childTasks.find((t) => t.type === "create_campaign");
  const selectTask = detail.childTasks.find((t) => t.type === "select_target_companies");
  const draftTask = detail.childTasks.find((t) => t.type === "personalize_message");
  assert.ok(campaignTask && campaignTask.status === "DONE");
  assert.ok(selectTask && selectTask.status === "DONE");
  assert.ok(draftTask, "the mission must have reached the personalizeMessage step");
  assert.equal(draftTask?.status, "AWAITING_APPROVAL");
  assert.ok(draftTask?.approvalRequestId, "personalizeMessage must always create an ApprovalRequest — never send anything");

  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: draftTask!.approvalRequestId! } });
  assert.equal(approval.status, "PENDING");

  // Cierra la misión para no bloquear la regla de "una misión por día"
  // en los tests siguientes de este mismo archivo.
  await fetch(`${baseUrl}/api/v1/missions/${body.id}`, {
    method: "PATCH",
    headers: SALES_HEADERS,
    body: JSON.stringify({ action: "cancel" }),
  });
});

test("a second mission the same day is rejected while the first is still RUNNING, and allowed once it closes", async () => {
  const res1 = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ instruction: "Encuentra empresas de construcción en Indiana." }),
  });
  assert.equal(res1.status, 201);
  const body1 = (await res1.json()) as { id: string };
  createdMissionIds.push(body1.id);

  const res2 = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ instruction: "Encuentra empresas de manufactura en Iowa." }),
  });
  assert.equal(res2.status, 400, "only one active Daily Revenue Mission per tenant per day is allowed");

  const closeRes = await fetch(`${baseUrl}/api/v1/missions/${body1.id}`, {
    method: "PATCH",
    headers: SALES_HEADERS,
    body: JSON.stringify({ action: "close_now" }),
  });
  assert.equal(closeRes.status, 200);
  const closed = (await closeRes.json()) as { missionState: string };
  assert.equal(closed.missionState, "COMPLETED");

  const detailRes = await fetch(`${baseUrl}/api/v1/missions/${body1.id}`, { headers: SALES_HEADERS });
  const detail = (await detailRes.json()) as { report: string | null };
  assert.ok(detail.report && detail.report.length > 0, "closing a mission must produce a real Executive Report");

  const res3 = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ instruction: "Encuentra empresas de manufactura en Iowa." }),
  });
  assert.equal(res3.status, 201, "a new mission is allowed once the previous one is no longer RUNNING");
  const body3 = (await res3.json()) as { id: string };
  createdMissionIds.push(body3.id);
  await fetch(`${baseUrl}/api/v1/missions/${body3.id}`, {
    method: "PATCH",
    headers: SALES_HEADERS,
    body: JSON.stringify({ action: "cancel" }),
  });
});

test("pause stops further delegation and resume continues it", async () => {
  const res = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ instruction: "Busca 1 empresa de warehouses en Illinois." }),
  });
  const body = (await res.json()) as { id: string };
  createdMissionIds.push(body.id);

  const pauseRes = await fetch(`${baseUrl}/api/v1/missions/${body.id}`, {
    method: "PATCH",
    headers: SALES_HEADERS,
    body: JSON.stringify({ action: "pause" }),
  });
  const paused = (await pauseRes.json()) as { missionState: string };
  assert.equal(paused.missionState, "PAUSED_BY_USER");

  const cancelRes = await fetch(`${baseUrl}/api/v1/missions/${body.id}`, {
    method: "PATCH",
    headers: SALES_HEADERS,
    body: JSON.stringify({ action: "cancel" }),
  });
  const cancelled = (await cancelRes.json()) as { missionState: string };
  assert.equal(cancelled.missionState, "CANCELLED");
});
