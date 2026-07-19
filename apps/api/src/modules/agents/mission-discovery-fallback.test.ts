// F13 (auditoría PO, 2026-07-19): pruebas reales del fallback automático
// de descubrimiento externo en mission-orchestrator.ts
// (runAutoExternalDiscoveryFallback) -- el flujo por defecto de una
// misión ("Busca N empresas de X en Y", sin frases mágicas tipo "fuera
// del CRM") corre real contra Google Places cuando el CRM no tiene
// suficiente oferta interna. Reutiliza el mismo servidor real de
// missions.test.ts (createApp(), dev-bypass, tenant-titan) -- llamadas
// reales a OpenAI (interpretación) y Google Places (descubrimiento),
// mismo criterio de costo real ya aceptado en el resto de la suite.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };

const createdMissionIds: string[] = [];

/**
 * F13: deja la oferta interna de Hospitality/IL en 0 empresas reales
 * antes de correr esta suite -- sin esto, corridas manuales/anteriores
 * de esta misma suite (o de la validación real de F13, ver
 * F13_DISCOVERY_VALIDATION_REPORT.md) dejan empresas reales ya
 * persistidas, y el test de "el fallback descubre empresas reales"
 * dejaría de disparar el fallback (oferta interna ya suficiente) en la
 * segunda corrida en adelante -- nunca toca Company.origin=DEMO_SEED.
 */
async function resetHospitalitySupply(): Promise<void> {
  const companies = await prisma.company.findMany({
    where: { industryId: "industry-hospitality", state: "IL", origin: { not: "DEMO_SEED" } },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  if (companyIds.length === 0) return;

  const leads = await prisma.lead.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  const leadIds = leads.map((l) => l.id);
  const opportunities = await prisma.opportunity.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  const opportunityIds = opportunities.map((o) => o.id);

  await prisma.followUp.deleteMany({ where: { entityType: "company", entityId: { in: companyIds } } });
  if (opportunityIds.length) await prisma.followUp.deleteMany({ where: { entityType: "opportunity", entityId: { in: opportunityIds } } });
  if (leadIds.length) await prisma.followUp.deleteMany({ where: { entityType: "lead", entityId: { in: leadIds } } });
  await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  const ccRows = await prisma.campaignCompany.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  await prisma.activity.deleteMany({ where: { entityType: "campaignCompany", entityId: { in: ccRows.map((c) => c.id) } } });
  await prisma.campaignCompany.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.companyContactPoint.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.activity.deleteMany({ where: { entityType: "company", entityId: { in: companyIds } } });
  await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
}

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;
  await resetHospitalitySupply();
});

async function cleanupMission(missionTaskId: string): Promise<void> {
  if (!missionTaskId) return;
  const children = await prisma.agentTask.findMany({ where: { parentTaskId: missionTaskId } });
  const discoveryChild = children.find((t) => t.type === "discover_companies");
  const createdCompanyIds = (discoveryChild?.output as { createdCompanyIds?: string[] } | null)?.createdCompanyIds ?? [];
  const campaignIds = children
    .filter((t) => t.type === "create_campaign")
    .map((t) => (t.output as { campaignId?: string } | null)?.campaignId)
    .filter((id): id is string => !!id);
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

  if (createdCompanyIds.length > 0) {
    await prisma.followUp.deleteMany({ where: { entityType: "company", entityId: { in: createdCompanyIds } } });
    await prisma.activity.deleteMany({ where: { entityType: "company", entityId: { in: createdCompanyIds } } });
    const ccRows = await prisma.campaignCompany.findMany({ where: { companyId: { in: createdCompanyIds } } });
    await prisma.activity.deleteMany({ where: { entityType: "campaignCompany", entityId: { in: ccRows.map((c) => c.id) } } });
    await prisma.campaignCompany.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
    await prisma.companyContactPoint.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
  }

  await prisma.agentTask.deleteMany({ where: { id: { in: childIds } } });
  await prisma.agentTask.delete({ where: { id: missionTaskId } }).catch(() => {});

  await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  for (const companyId of createdCompanyIds) {
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

async function waitForCompletion(missionId: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/v1/missions/${missionId}`, { headers: SALES_HEADERS });
    const body = (await res.json()) as { missionState: string };
    if (body.missionState !== "RUNNING") return body as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`Mission ${missionId} did not settle within ${timeoutMs}ms`);
}

// F13: regresión directa del bug real reportado por el PO -- una
// instrucción que pide una industria SIN Industry real en el CRM
// (Retail: taxonomía la reconoce, pero crmIndustryBucket sigue null a
// propósito) antes caía a "sin filtro de industria" y devolvía
// CUALQUIER empresa del estado sin relación con lo pedido. Ahora debe
// quedar en 0 empresas targeteadas -- honesto, nunca una empresa
// equivocada.
test("una industria que la taxonomía reconoce pero el CRM no tiene todavía nunca selecciona una empresa sin relación (regresión del bug real)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ instruction: "Busca 2 tiendas minoristas reales en Illinois." }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string };
  createdMissionIds.push(body.id);

  const detail = await waitForCompletion(body.id);
  assert.equal(detail.missionState, "COMPLETED");
  assert.equal(detail.companiesTargeted, 0, "sin Industry real de Retail en el CRM, nunca debe reportar empresas targeteadas");
  const selected = detail.selectedCompanies as Array<{ industryName: string }>;
  assert.equal(selected.length, 0, "nunca debe seleccionar una empresa de OTRA industria (Construction/Manufacturing/etc.) solo porque el filtro quedó vacío");
});

// F13: prueba positiva real del fallback -- Hospitality no tenía ninguna
// Company real en el CRM antes de F13 (Industry nueva). Confirma que el
// fallback descubre empresas reales (nunca Demo), las conecta con
// possibleCategories reales (fix del bug de selectTargetCompanies), y
// llegan a lead/oportunidad como cualquier empresa ya existente.
test("el fallback automático descubre empresas reales de Hospitality y las lleva a lead/oportunidad real (nunca Demo)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ instruction: "Busca 2 hoteles reales en Illinois que puedan necesitar Housekeeping." }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string; industryNames: string[] };
  createdMissionIds.push(body.id);
  assert.deepEqual(body.industryNames, ["Hospitality"], "Hospitality ahora es una Industry real -- F13");

  const detail = await waitForCompletion(body.id);
  assert.equal(detail.missionState, "COMPLETED");
  assert.ok((detail.companiesTargeted as number) > 0, "el fallback debe haber descubierto al menos 1 hotel real");
  assert.equal(detail.leadsCreated, detail.companiesTargeted, "cada empresa recién descubierta debe llegar a un lead real");

  const discoveryFallback = detail.discoveryFallback as { providersUsed: string[]; companiesCreated: number } | null;
  assert.ok(discoveryFallback, "discoveryFallback debe quedar poblado y visible en la respuesta real de la API");
  assert.ok(discoveryFallback!.providersUsed.includes("Google Places"));
  assert.ok(discoveryFallback!.companiesCreated > 0);

  const selected = detail.selectedCompanies as Array<{ companyName: string; origin: string; industryName: string }>;
  assert.ok(selected.length > 0);
  for (const company of selected) {
    assert.notEqual(company.origin, "DEMO_SEED", `"${company.companyName}" debe ser real (API_PROVIDER), nunca Demo`);
    assert.equal(company.industryName, "Hospitality");
  }
});
