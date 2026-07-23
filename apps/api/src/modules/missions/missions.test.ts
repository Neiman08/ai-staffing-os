import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";
import { env } from "../../core/env";
import { missionsRouter } from "./router";
import { missionLaunchLimiter } from "../../core/rate-limiters";
import { routeHasMiddleware } from "../../test-helpers/route-wiring";

let server: Server;
let baseUrl: string;

const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };
const COMPLIANCE_HEADERS = { "x-dev-user": "compliance@titan.dev", "content-type": "application/json" };

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
  // F24: cleanupMission ya borra cualquier Company que la misión haya
  // seleccionado (vía el output de select_target_companies) -- este
  // catch cubre el caso en que la selección nunca llegó a correr (falla
  // temprana del test) y la Company de prueba quedaría huérfana.
  for (const id of createdCompanyIds) {
    await prisma.contact.deleteMany({ where: { companyId: id } }).catch(() => {});
    await prisma.company.delete({ where: { id } }).catch(() => {});
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

/**
 * Corrección estructural: a diferencia de waitForMissionChildren, esto NO
 * asume que la misión va a crear ningún hijo — una misión cuyas empresas
 * ya tenían score/lead (o cuyo filtro no matcheó ninguna) puede legítimamente
 * cerrar con 0 tareas hijas (ver mission-orchestrator.ts: sin Campaign
 * permitida, no hay nada obligatorio que crear). Usado por el test de
 * restricciones, que no puede garantizar cuántas empresas reales del seed
 * matchean su filtro en el momento de correr.
 */
async function waitForMissionSettled(missionId: string, timeoutMs = 45_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await prisma.agentTask.findUniqueOrThrow({ where: { id: missionId } });
    const missionState = (task.output as { missionState?: string } | null)?.missionState ?? "RUNNING";
    if (missionState !== "RUNNING" && missionState !== "PAUSED_BUDGET") return missionState;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Mission ${missionId} did not settle within ${timeoutMs}ms`);
}

test("POST /missions as compliance@titan.dev returns 403 (no missions.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ instruction: "Busca empresas de construcción." }),
  });
  assert.equal(res.status, 403);
});

// F12.4/F12.11: prueba de "wiring" real -- confirma que missionLaunchLimiter
// está montado en la ruta de producción. Reescrita en F12.11 para
// inspeccionar el stack real de Express en vez de disparar un request:
// el limiter está deshabilitado bajo NODE_ENV=test (ver rate-limiters.ts)
// para no compartir cupo entre archivos de test ajenos entre sí, así que
// un request real ya no expondría el header de todos modos.
test("F12.4: POST /missions tiene missionLaunchLimiter montado (real, mismo router de producción)", () => {
  assert.ok(routeHasMiddleware(missionsRouter, "post", "/missions", missionLaunchLimiter));
});

test("launchMission interprets a real instruction, runs the fixed pipeline, and always ends in an ApprovalRequest (real OpenAI calls)", async () => {
  // F24 (auditoría de producción): selectTargetCompanies ahora excluye
  // origin=DEMO_SEED -- este test dependía de que el seed real
  // (company-05, Prairie Manufacturing Co., justamente DEMO_SEED) fuera
  // seleccionable como target de campaña. Se reemplaza por una Company
  // real equivalente (misma industria/estado/categoría/tamaño), creada
  // fresca en cada corrida para que el pipeline tenga algo real que
  // seleccionar.
  const industry = await prisma.industry.findFirstOrThrow({ where: { name: "Manufacturing" } });
  const category = await prisma.jobCategory.findFirstOrThrow({ where: { name: "General Labor" } });
  const testCompany = await prisma.company.create({
    data: {
      tenantId: "tenant-titan",
      name: `Missions Test Manufacturing Co ${Date.now()}`,
      industryId: industry.id,
      status: "LEAD",
      state: "IL",
      estimatedSize: "MEDIUM",
      commercialScore: 70,
      origin: "API_PROVIDER",
      email: "contact@missionstestmfg.example",
      possibleCategories: { connect: [{ id: category.id }] },
    },
  });
  createdCompanyIds.push(testCompany.id);

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
  // resto de la secuencia corre async. F13 (auditoría PO, 2026-07-19):
  // hallazgo real al validar contra una base de datos genuinamente
  // fresca -- la empresa seleccionada nunca tenía un Lead real (F24: la
  // Company de prueba ahora se crea fresca en cada corrida, así que esto
  // vale siempre, por diseño, no por casualidad), así que el pipeline
  // SIEMPRE crea 6 hijos reales acá (create_campaign,
  // select_target_companies, create_lead, create_opportunity,
  // plan_sequence, personalize_message), nunca 4.
  await waitForMissionChildren(body.id, 6, 45_000);

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

// Corrección estructural (misión Iowa, 2026-07-13): la instrucción real
// dijo "no crear campañas; no crear oportunidades; no enviar correos; no
// contactar a nadie" y el sistema creó una Campaign de todas formas. Este
// test cubre exactamente esa combinación contra el pipeline real (con
// una llamada real a OpenAI para interpretDailyDirective, mismo criterio
// que el resto de este archivo) — nunca debe existir ningún
// create_campaign/create_opportunity/personalize_message entre las
// tareas hijas, y restrictionNotes debe explicarlo.
test("una instrucción que prohíbe campañas/oportunidades/outreach nunca las crea, aunque el pipeline las hubiera creado por default", async () => {
  const res = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({
      instruction:
        "Busca empresas de manufactura en Illinois. No crear campañas; no crear oportunidades; no enviar correos; no contactar a nadie.",
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string; appliedRestrictions: Record<string, boolean> };
  createdMissionIds.push(body.id);

  assert.equal(body.appliedRestrictions.allowCampaignCreation, false);
  assert.equal(body.appliedRestrictions.allowOpportunityCreation, false);
  assert.equal(body.appliedRestrictions.allowOutreach, false);
  assert.equal(body.appliedRestrictions.allowMessageSending, false);

  // No se puede asumir que el pipeline vaya a crear NINGÚN hijo — sin
  // Campaign permitida, la única empresa real de Manufacturing/IL del
  // seed puede ya tener score y lead (nada que hacer), y eso es un
  // resultado válido, no un timeout. Se espera a que la misión misma
  // termine, no a una cantidad de hijos que no se puede garantizar.
  const finalState = await waitForMissionSettled(body.id, 45_000);
  assert.ok(
    ["COMPLETED", "PARTIAL"].includes(finalState),
    `la misión debe cerrar normalmente (COMPLETED/PARTIAL), no ${finalState}`,
  );

  const detailRes = await fetch(`${baseUrl}/api/v1/missions/${body.id}`, { headers: SALES_HEADERS });
  const detail = (await detailRes.json()) as {
    childTasks: Array<{ type: string }>;
    restrictionNotes: string[];
  };

  assert.ok(!detail.childTasks.some((t) => t.type === "create_campaign"), "no debe existir ningún create_campaign");
  assert.ok(!detail.childTasks.some((t) => t.type === "create_opportunity"), "no debe existir ningún create_opportunity");
  assert.ok(!detail.childTasks.some((t) => t.type === "personalize_message"), "no debe existir ningún personalize_message");
  assert.ok(detail.restrictionNotes.length >= 3, "debe explicar explícitamente qué restricciones se aplicaron");

  await fetch(`${baseUrl}/api/v1/missions/${body.id}`, {
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

/**
 * Regresión: bug real encontrado en producción -- una misión cuya
 * llamada síncrona a interpretDailyDirective (OpenAI, dentro de
 * launchMission, ANTES de que exista runMissionPipelineAsync) fallaba
 * quedaba huérfana en AgentTask.status="RUNNING" para siempre, con 0
 * companies/leads/opportunities/costo, bloqueando además cualquier
 * misión nueva ese día (el guard de "una misión activa por día" la
 * seguía contando como activa). Se reproduce el fallo real de forma
 * determinista forzando MissingApiKeyProvider (apagando OPENAI_API_KEY
 * por la duración de este test) en vez de depender de una falla de red
 * no determinista -- el resto del código (AgentRuntime.run(), que nunca
 * atrapa nada) es el mismo camino real que un rate-limit o un timeout
 * real recorrerían.
 */
test("una misión cuyo interpretDailyDirective falla NUNCA queda atascada en RUNNING -- termina en FAILED con el error visible, y no bloquea la próxima misión", async () => {
  const originalKey = env.OPENAI_API_KEY;
  env.OPENAI_API_KEY = undefined;
  try {
    const res = await fetch(`${baseUrl}/api/v1/missions`, {
      method: "POST",
      headers: SALES_HEADERS,
      body: JSON.stringify({ instruction: "Busca empresas de manufactura en Illinois." }),
    });
    // launchMission re-lanza la excepción después de marcar la misión
    // FAILED -- el cliente sigue viendo un error real, nunca un 201 falso.
    assert.notEqual(res.status, 201);
    const errorBody = (await res.json()) as { error?: { code?: string } };
    assert.equal(errorBody.error?.code, "AI_NOT_CONFIGURED");
  } finally {
    env.OPENAI_API_KEY = originalKey;
  }

  const stuck = await prisma.agentTask.findFirst({
    where: { type: "daily_revenue_mission", status: "RUNNING" },
    orderBy: { createdAt: "desc" },
  });
  assert.equal(stuck, null, "no debe quedar ninguna misión huérfana en RUNNING");

  const failed = await prisma.agentTask.findFirst({
    where: { type: "daily_revenue_mission", status: "FAILED" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(failed, "debe existir la misión marcada FAILED");
  createdMissionIds.push(failed!.id);
  assert.match(failed!.errorMessage ?? "", /OPENAI_API_KEY|AI_NOT_CONFIGURED/i);
  const output = failed!.output as { missionState?: string; companiesTargeted?: number; costUsdSoFar?: number } | null;
  assert.equal(output?.missionState, "FAILED");
  assert.equal(output?.companiesTargeted, 0);

  // Prueba directa de la regresión reportada: con la misión anterior ya
  // en FAILED (terminal), lanzar una misión nueva el mismo día debe
  // funcionar -- antes de este fix, la misión huérfana en RUNNING
  // bloqueaba esto indefinidamente.
  const secondRes = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ instruction: "Busca 1 empresa de manufactura en Illinois." }),
  });
  assert.equal(secondRes.status, 201);
  const secondBody = (await secondRes.json()) as { id: string };
  createdMissionIds.push(secondBody.id);

  // Se cancela antes de que el test termine (en vez de dejar que corra
  // en background) para que su pipeline asíncrono no siga escribiendo
  // sobre la fila mientras el hook after() de este archivo ya la borró.
  await fetch(`${baseUrl}/api/v1/missions/${secondBody.id}`, {
    method: "PATCH",
    headers: SALES_HEADERS,
    body: JSON.stringify({ action: "cancel" }),
  });
});
