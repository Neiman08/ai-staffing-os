import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { getMissionDetail } from "./service";

/**
 * F28 (misión real 2026-07-27, roofing IL): la misión reusó una Campaign
 * ya existente ("reused": true en el output de create_campaign) y
 * `GET /missions/:id` reportó 33 "empresas seleccionadas" -- incluyendo
 * DEMO_SEED y data centers de una misión eléctrica anterior -- pese a que
 * companiesTargeted/leadsCreated/opportunitiesCreated eran correctamente
 * 4. El aislamiento real (select_target_companies, ver
 * campaign-tools.integration.test.ts) ya estaba arreglado; este era un
 * segundo bug, en la capa de REPORTE (`getMissionDetail`), que leía TODAS
 * las CampaignCompany de la campaña reusada en vez de filtrar por lo que
 * esta misión concreta seleccionó.
 */

const TEST_PREFIX = "F28-DETAIL-ISOLATION";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaignCompany.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaign.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

test("getMissionDetail: al reusar una Campaign existente, 'selectedCompanies' solo muestra lo que ESTA misión seleccionó -- nunca el historial de una misión anterior no relacionada", async () => {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);

  const construction = await prisma.industry.findFirstOrThrow({ where: { name: "Construction", isGlobal: true } });
  const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
  const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });

  const oldMission = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "daily_revenue_mission", input: {}, status: "DONE", triggeredBy: "USER" },
  });
  const newMission = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "daily_revenue_mission", input: {}, status: "DONE", triggeredBy: "USER" },
  });

  const oldCompanies = await Promise.all(
    ["Midwest Data Center Builders", "Equinix Data Centers"].map((name) =>
      prisma.company.create({
        data: { tenantId: tenant.id, name, industryId: construction.id, state: "IL", origin: "DEMO_SEED", discoveredByAgentTaskId: oldMission.id },
      }),
    ),
  );
  const newCompanies = await Promise.all(
    ["ROOF TIGER", "Champion Roofing, Inc."].map((name) =>
      prisma.company.create({
        data: { tenantId: tenant.id, name, industryId: construction.id, state: "IL", origin: "API_PROVIDER", discoveredByAgentTaskId: newMission.id },
      }),
    ),
  );

  // La campaña se creó "por" la misión vieja, y la misión nueva la REUSA
  // -- exactamente lo que reportó create_campaign en la misión real
  // (output.reused === true, mismo campaignId).
  const campaign = await prisma.campaign.create({
    data: { tenantId: tenant.id, name: "Construction IL — reusada", industryId: construction.id, state: "IL", createdByAgentTaskId: oldMission.id },
  });

  for (const c of [...oldCompanies, ...newCompanies]) {
    await prisma.campaignCompany.create({
      data: { tenantId: tenant.id, campaignId: campaign.id, companyId: c.id, createdByAgentTaskId: oldCompanies.includes(c) ? oldMission.id : newMission.id },
    });
  }

  await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: ceoInstance.id,
      type: "create_campaign",
      parentTaskId: newMission.id,
      input: {},
      output: { reused: true, campaignId: campaign.id },
      status: "DONE",
      triggeredBy: "AGENT",
    },
  });
  await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: ceoInstance.id,
      type: "select_target_companies",
      parentTaskId: newMission.id,
      input: { campaignId: campaign.id },
      output: { addedCount: newCompanies.length, companyIds: newCompanies.map((c) => c.id) },
      status: "DONE",
      triggeredBy: "AGENT",
    },
  });

  const detail = await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () => getMissionDetail(newMission.id));

  const selectedIds = new Set(detail.selectedCompanies.map((c) => c.companyId));
  for (const c of newCompanies) assert.ok(selectedIds.has(c.id), `"${c.name}" (misión nueva) debía aparecer en selectedCompanies`);
  for (const c of oldCompanies) assert.ok(!selectedIds.has(c.id), `"${c.name}" (misión ANTERIOR, DEMO_SEED) no debía filtrarse a la misión nueva`);
  assert.equal(detail.selectedCompanies.length, newCompanies.length, "selectedCompanies no debe traer de más -- ni demo seed ni historial de otra misión");
});

/**
 * F32 (auditoría arquitectónica, hallazgo real MIS-20260731-0003,
 * 2026-07-31): variante del bug de arriba, NO cubierta por el test F28 --
 * cuando select_target_companies SÍ corrió (con restrictToTradeKeys) pero
 * legítimamente encontró 0 empresas reutilizables (el CRM no tenía
 * ninguna Company con ese tradeKey específico), el código anterior caía
 * al mismo branch que "select_target_companies nunca corrió" (ambos
 * casos tenían missionSelectedCompanyIds.size === 0) y mostraba TODO el
 * historial de la campaña compartida -- 43 empresas de roofing/data
 * centers/contratistas generales para una misión de "electrical
 * contractor" que targeteó 0. Este test fija que un select_target_companies
 * que CORRIÓ (sin importar cuántos ids devolvió) siempre gana sobre el
 * historial de la campaña.
 */
test("getMissionDetail: select_target_companies que CORRIÓ y legítimamente encontró 0 empresas -- selectedCompanies debe quedar VACÍO, nunca caer al historial completo de la campaña (caso real MIS-20260731-0003)", async () => {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-ZERO-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-zero-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);

  const construction = await prisma.industry.findFirstOrThrow({ where: { name: "Construction", isGlobal: true } });
  const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
  const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });

  const oldMission = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "daily_revenue_mission", input: {}, status: "DONE", triggeredBy: "USER" },
  });
  const newMission = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "daily_revenue_mission", input: {}, status: "DONE", triggeredBy: "USER" },
  });

  // Historial real de una misión anterior de roofing/general contracting
  // -- ninguna es un "electrical contractor" real.
  const unrelatedCompanies = await Promise.all(
    ["ROOF TIGER", "Champion Roofing, Inc.", "CoreSite Chicago Data Center"].map((name) =>
      prisma.company.create({
        data: { tenantId: tenant.id, name, industryId: construction.id, state: "IL", origin: "API_PROVIDER", discoveredByAgentTaskId: oldMission.id },
      }),
    ),
  );

  const campaign = await prisma.campaign.create({
    data: { tenantId: tenant.id, name: "Construction IL — reusada", industryId: construction.id, state: "IL", createdByAgentTaskId: oldMission.id },
  });
  for (const c of unrelatedCompanies) {
    await prisma.campaignCompany.create({
      data: { tenantId: tenant.id, campaignId: campaign.id, companyId: c.id, createdByAgentTaskId: oldMission.id },
    });
  }

  await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: ceoInstance.id,
      type: "create_campaign",
      parentTaskId: newMission.id,
      input: {},
      output: { reused: true, campaignId: campaign.id },
      status: "DONE",
      triggeredBy: "AGENT",
    },
  });
  // El caso real: CORRIÓ, con restrictToTradeKeys=["electrical"], y
  // legítimamente devolvió companyIds=[] -- ninguna Company del CRM
  // tenía tradeKey="electrical".
  await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: ceoInstance.id,
      type: "select_target_companies",
      parentTaskId: newMission.id,
      input: { campaignId: campaign.id, restrictToTradeKeys: ["electrical"] },
      output: { addedCount: 0, companyIds: [] },
      status: "DONE",
      triggeredBy: "AGENT",
    },
  });

  const detail = await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () => getMissionDetail(newMission.id));

  assert.deepEqual(
    detail.selectedCompanies,
    [],
    "select_target_companies CORRIÓ y encontró 0 -- selectedCompanies debe reflejar honestamente 0, nunca el historial completo de la campaña compartida",
  );
});
