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
