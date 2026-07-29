import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../../core/tenancy/context";
import { createCampaignTools } from "./campaign-tools.impl";
import type { UsageAccumulator } from "../usage";

/**
 * F28 (aislamiento entre misiones, hallazgo real 2026-07-27): la misión
 * de roofing, que descubrió 25 empresas reales, terminó "seleccionando"
 * 33 para su Campaign -- arrastró empresas de una misión ANTERIOR y sin
 * relación (electrical/data center), porque select_target_companies
 * filtraba solo por industria/estado/ciudad (mismo bucket "Construction"
 * para ambos rubros), nunca por qué misión las descubrió.
 *
 * Este test reproduce el escenario real con dos "misiones" (dos
 * AgentTask de tipo daily_revenue_mission en el mismo tenant): una de
 * electrical/data center, otra de roofing -- y confirma que ninguna
 * empresa de la primera puede aparecer nunca en la selección de la
 * segunda.
 */

const TEST_PREFIX = "F28-CAMPAIGN-ISOLATION";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaignCompany.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaign.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

const fakeDeps = { taskId: "test-task", agentInstanceId: "test-agent-instance", llmProvider: {} as never, usage: { record: () => {} } as unknown as UsageAccumulator };

async function setupScenario(suffix: string) {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);

  const construction = await prisma.industry.findFirstOrThrow({ where: { name: "Construction", isGlobal: true } });
  const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
  const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });

  const electricalMission = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "daily_revenue_mission", input: {}, status: "DONE", triggeredBy: "USER" },
  });
  const roofingMission = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "daily_revenue_mission", input: {}, status: "RUNNING", triggeredBy: "USER" },
  });

  const electricalCompanies = await Promise.all(
    ["CoreSite Chicago Data Center (CH1)", "Bufalo Contracting"].map((name) =>
      prisma.company.create({
        data: { tenantId: tenant.id, name, industryId: construction.id, state: "IL", origin: "API_PROVIDER", discoveredByAgentTaskId: electricalMission.id },
      }),
    ),
  );
  const roofingCompanies = await Promise.all(
    ["ROOF TIGER", "Champion Roofing, Inc."].map((name) =>
      prisma.company.create({
        data: { tenantId: tenant.id, name, industryId: construction.id, state: "IL", origin: "API_PROVIDER", discoveredByAgentTaskId: roofingMission.id },
      }),
    ),
  );

  const campaign = await prisma.campaign.create({
    data: { tenantId: tenant.id, name: "Roofing IL — misión de prueba", industryId: construction.id, state: "IL", createdByAgentTaskId: roofingMission.id },
  });

  return { tenantId: tenant.id, roofingMission, electricalMission, electricalCompanies, roofingCompanies, campaign };
}

test("select_target_companies con restrictToCompanyIds: solo devuelve empresas descubiertas por ESA misión -- ninguna de la misión electrical/data-center anterior", async () => {
  const { tenantId, roofingCompanies, campaign } = await setupScenario("scoped");

  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const tools = createCampaignTools(fakeDeps);
    const selectTool = tools.find((t) => t.name === "selectTargetCompanies")!;
    return selectTool.execute({ campaignId: campaign.id, limit: 50, restrictToCompanyIds: roofingCompanies.map((c) => c.id) }) as Promise<{ companyIds: string[] }>;
  });

  const roofingIds = new Set(roofingCompanies.map((c) => c.id));
  assert.equal(result.companyIds.length, 2, "debe devolver exactamente las 2 empresas de roofing, nunca más");
  for (const id of result.companyIds) {
    assert.ok(roofingIds.has(id), `companyId ${id} no pertenece a la misión de roofing -- fuga de aislamiento`);
  }
});

test("select_target_companies SIN restrictToCompanyIds (comportamiento explícito de 'trabajar sobre la base existente'): sigue devolviendo todo el bucket de industria/estado, incluidas ambas misiones", async () => {
  const { tenantId, electricalCompanies, roofingCompanies, campaign } = await setupScenario("unscoped");

  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const tools = createCampaignTools(fakeDeps);
    const selectTool = tools.find((t) => t.name === "selectTargetCompanies")!;
    return selectTool.execute({ campaignId: campaign.id, limit: 50 }) as Promise<{ companyIds: string[] }>;
  });

  const allIds = new Set([...electricalCompanies, ...roofingCompanies].map((c) => c.id));
  assert.equal(result.companyIds.length, 4, "sin restrictToCompanyIds, la selección amplia sigue igual que siempre (comportamiento preexistente)");
  for (const id of result.companyIds) assert.ok(allIds.has(id));
});

test("aislamiento real de extremo a extremo: ninguna empresa de la misión electrical/data-center aparece jamás en la selección scopeada de la misión roofing", async () => {
  const { electricalMission, tenantId, electricalCompanies, roofingCompanies, campaign } = await setupScenario("e2e");

  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const tools = createCampaignTools(fakeDeps);
    const selectTool = tools.find((t) => t.name === "selectTargetCompanies")!;
    return selectTool.execute({ campaignId: campaign.id, limit: 50, restrictToCompanyIds: roofingCompanies.map((c) => c.id) }) as Promise<{ companyIds: string[] }>;
  });

  for (const electricalCompany of electricalCompanies) {
    assert.ok(!result.companyIds.includes(electricalCompany.id), `"${electricalCompany.name}" (misión ${electricalMission.id}) no debía aparecer en la selección de la misión de roofing`);
  }
});

/**
 * F28 (misión real de Hospitality, 2026-07-29, MIS-20260729-0003): una
 * misión de Hospitality/IL terminó con companiesTargeted=0, cero
 * contactos, cero Leads, cero Drafts -- pese a que el CRM ya tenía
 * empresas de Hospitality reales y validadas (descubiertas por 2
 * misiones anteriores el mismo día). Causa raíz exacta: cuando el
 * descubrimiento de ESTA misión corría pero no encontraba NADA nuevo
 * (todo duplicado), `discoveredCompanyIdsThisMission` quedaba en `[]`
 * (array vacío, no `null`) -- y `[] ?? undefined` sigue siendo `[]`, así
 * que `restrictToCompanyIds` terminaba restringiendo a CERO empresas en
 * vez de caer al comportamiento amplio ("trabajar sobre la base
 * existente") que el propio comentario del código ya describía como el
 * comportamiento correcto para ese caso.
 *
 * El fix (mission-orchestrator.ts) convierte `[]` a `undefined` igual
 * que `null` -- pero caer a la selección amplia sin más generaría el
 * MISMO bug de aislamiento original si se aplicara sin acotar (varios
 * trades comparten Industry, ej. roofing/electrical en "Construction").
 * Por eso el fallback ahora se acota por Company.tradeKey
 * (restrictToTradeKeys) a los taxonomyKey específicos que la misión
 * actual pidió -- nunca al bucket amplio de Industry completo.
 */
async function setupTradeKeyScenario() {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-tradekey-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-tradekey-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);

  const construction = await prisma.industry.findFirstOrThrow({ where: { name: "Construction", isGlobal: true } });
  const roofingCompanies = await Promise.all(
    ["ROOF TIGER", "Champion Roofing, Inc."].map((name) =>
      prisma.company.create({ data: { tenantId: tenant.id, name, industryId: construction.id, state: "IL", origin: "API_PROVIDER", tradeKey: "roofing" } }),
    ),
  );
  const electricalCompanies = await Promise.all(
    ["Tri-City Electric", "Bufalo Contracting"].map((name) =>
      prisma.company.create({ data: { tenantId: tenant.id, name, industryId: construction.id, state: "IL", origin: "API_PROVIDER", tradeKey: "electrical" } }),
    ),
  );
  const campaign = await prisma.campaign.create({
    data: { tenantId: tenant.id, name: "Construction IL — misión de prueba", industryId: construction.id, state: "IL" },
  });

  return { tenantId: tenant.id, roofingCompanies, electricalCompanies, campaign };
}

test("select_target_companies con restrictToTradeKeys (bug real MIS-20260729-0003): sin restrictToCompanyIds, encuentra las empresas del trade pedido -- ya no devuelve 0", async () => {
  const { tenantId, roofingCompanies, campaign } = await setupTradeKeyScenario();

  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const tools = createCampaignTools(fakeDeps);
    const selectTool = tools.find((t) => t.name === "selectTargetCompanies")!;
    return selectTool.execute({ campaignId: campaign.id, limit: 50, restrictToTradeKeys: ["roofing"] }) as Promise<{ companyIds: string[] }>;
  });

  const roofingIds = new Set(roofingCompanies.map((c) => c.id));
  assert.equal(result.companyIds.length, 2, "debía encontrar las 2 empresas reales de roofing ya validadas, nunca 0");
  for (const id of result.companyIds) assert.ok(roofingIds.has(id));
});

test("select_target_companies con restrictToTradeKeys: NUNCA reintroduce el bug de aislamiento original -- electrical no aparece en una selección de roofing pese a compartir Industry", async () => {
  const { tenantId, electricalCompanies, campaign } = await setupTradeKeyScenario();

  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const tools = createCampaignTools(fakeDeps);
    const selectTool = tools.find((t) => t.name === "selectTargetCompanies")!;
    return selectTool.execute({ campaignId: campaign.id, limit: 50, restrictToTradeKeys: ["roofing"] }) as Promise<{ companyIds: string[] }>;
  });

  for (const electricalCompany of electricalCompanies) {
    assert.ok(!result.companyIds.includes(electricalCompany.id), `"${electricalCompany.name}" (tradeKey=electrical) no debía aparecer en una selección acotada a roofing`);
  }
});

test("select_target_companies: restrictToCompanyIds (cuando SÍ hay descubrimiento nuevo real) sigue ganando por sobre restrictToTradeKeys -- nunca se ignora evidencia más específica", async () => {
  const { tenantId, roofingCompanies, campaign } = await setupTradeKeyScenario();

  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const tools = createCampaignTools(fakeDeps);
    const selectTool = tools.find((t) => t.name === "selectTargetCompanies")!;
    return selectTool.execute({
      campaignId: campaign.id,
      limit: 50,
      restrictToCompanyIds: [roofingCompanies[0]!.id],
      restrictToTradeKeys: ["roofing"],
    }) as Promise<{ companyIds: string[] }>;
  });

  assert.deepEqual(result.companyIds, [roofingCompanies[0]!.id], "restrictToCompanyIds ya es más específico que restrictToTradeKeys -- debe ganar, nunca ampliarse");
});
