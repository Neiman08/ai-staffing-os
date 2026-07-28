import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../../core/tenancy/context";
import { computeMissionProgress } from "./ceo-tools.impl";

/**
 * F28 (misión real de Hospitality, 2026-07-28): el Executive Report
 * decía "0 empresas, 0 oportunidades" pese a que existían Companies/
 * Leads/Opportunities/Drafts reales -- porque computeMissionProgress
 * solo contaba AgentTask hijas de tipo create_lead/create_opportunity/
 * select_target_companies/personalize_message (las que crea el pipeline
 * clásico estático). Una misión que corre por el camino dinámico
 * (runDynamicDiscoveryMission -> executeDiscoveryPlan con
 * convertToCommercialActions=true, mission-orchestrator.ts) crea esos
 * mismos registros DENTRO de la única AgentTask "discover_companies"
 * (discovery-conversion.ts, convertDiscoveredCompany) -- nunca como
 * hijas separadas. Este test reproduce ese escenario real con datos
 * reales en la base (Company/Lead/Opportunity/ApprovalRequest, cada uno
 * con su createdByAgentTaskId/discoveredByAgentTaskId/agentTaskId real
 * apuntando al discover_companies) y confirma que computeMissionProgress
 * ahora sí los ve.
 */

const TEST_PREFIX = "F28-DYNAMIC-PROGRESS";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.opportunity.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.lead.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

test("computeMissionProgress: ve Companies/Leads/Opportunities/Drafts reales creados por el camino dinámico (convertToCommercialActions), no solo por el pipeline clásico estático", async () => {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);

  const hospitality = await prisma.industry.findFirstOrThrow({ where: { name: "Hospitality", isGlobal: true } });
  const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
  const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });

  const rootMission = await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: ceoInstance.id,
      type: "daily_revenue_mission",
      status: "DONE",
      triggeredBy: "USER",
      input: { businessObjective: { type: "companies_found", target: null, unit: "empresas", rawText: "busca hoteles en Illinois" } },
    },
  });

  // El camino dinámico crea UNA sola AgentTask hija -- discover_companies
  // -- y todo el trabajo real (Company/Lead/Opportunity/Draft) cuelga de
  // ahí, nunca de hijas separadas.
  const discoverTask = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "discover_companies", parentTaskId: rootMission.id, status: "DONE", triggeredBy: "AGENT", input: {}, output: { companyValidations: [] } },
  });

  const company = await prisma.company.create({
    data: { tenantId: tenant.id, name: "Riverside Conference Hotel", industryId: hospitality.id, state: "IL", origin: "API_PROVIDER", discoveredByAgentTaskId: discoverTask.id },
  });
  await prisma.lead.create({
    data: { tenantId: tenant.id, companyId: company.id, industryId: hospitality.id, source: "external_discovery", priority: "MEDIUM", status: "NEW", createdByAgentTaskId: discoverTask.id },
  });
  await prisma.opportunity.create({
    data: {
      tenantId: tenant.id,
      companyId: company.id,
      title: "Riverside Conference Hotel — descubrimiento externo",
      stage: "MEETING_SCHEDULED",
      probability: 15,
      estimatedRevenue: 5000,
      createdByAgentTaskId: discoverTask.id,
    },
  });
  await prisma.approvalRequest.create({
    data: {
      tenantId: tenant.id,
      agentTaskId: discoverTask.id,
      companyId: company.id,
      summary: "Borrador para Riverside Conference Hotel",
      proposedAction: { to: "gm@riversideconference.com", subject: "test", body: "test" },
      riskLevel: "MEDIUM",
      status: "PENDING",
    },
  });

  const progress = await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () => computeMissionProgress(rootMission.id));

  assert.equal(progress.companiesTargeted, 1, "computeMissionProgress no vio la Company creada por el camino dinámico");
  assert.equal(progress.leadsCreated, 1, "computeMissionProgress no vio el Lead creado por el camino dinámico");
  assert.equal(progress.opportunitiesCreated, 1, "computeMissionProgress no vio la Opportunity creada por el camino dinámico");
  assert.equal(progress.pipelineValueUsd, 5000, "pipelineValueUsd debe reflejar la Opportunity real del camino dinámico");
  assert.equal(progress.draftsAwaitingApproval, 1, "computeMissionProgress no vio el Draft (ApprovalRequest PENDING) creado por el camino dinámico");
  assert.equal(progress.emailsSentCount, 0);
});

test("computeMissionProgress: sigue sumando correctamente cuando AMBOS caminos participaron (clásico + dinámico) en la misma misión", async () => {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-both-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-both-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);

  const hospitality = await prisma.industry.findFirstOrThrow({ where: { name: "Hospitality", isGlobal: true } });
  const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
  const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });

  const rootMission = await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: ceoInstance.id,
      type: "daily_revenue_mission",
      status: "DONE",
      triggeredBy: "USER",
      input: { businessObjective: { type: "companies_found", target: null, unit: "empresas", rawText: "busca hoteles en Illinois" } },
    },
  });

  // Rama clásica: una AgentTask create_lead separada (como el pipeline
  // estático real).
  const classicCompany = await prisma.company.create({
    data: { tenantId: tenant.id, name: "Classic Hotel", industryId: hospitality.id, state: "IL", origin: "API_PROVIDER" },
  });
  const classicLead = await prisma.lead.create({
    data: { tenantId: tenant.id, companyId: classicCompany.id, industryId: hospitality.id, source: "daily-revenue-mission", priority: "MEDIUM", status: "NEW" },
  });
  await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "create_lead", parentTaskId: rootMission.id, status: "DONE", triggeredBy: "AGENT", input: {}, output: { leadId: classicLead.id } },
  });

  // Rama dinámica: discover_companies con conversión directa.
  const discoverTask = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "discover_companies", parentTaskId: rootMission.id, status: "DONE", triggeredBy: "AGENT", input: {}, output: { companyValidations: [] } },
  });
  const dynamicCompany = await prisma.company.create({
    data: { tenantId: tenant.id, name: "Dynamic Hotel", industryId: hospitality.id, state: "IL", origin: "API_PROVIDER", discoveredByAgentTaskId: discoverTask.id },
  });
  await prisma.lead.create({
    data: { tenantId: tenant.id, companyId: dynamicCompany.id, industryId: hospitality.id, source: "external_discovery", priority: "MEDIUM", status: "NEW", createdByAgentTaskId: discoverTask.id },
  });

  const progress = await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () => computeMissionProgress(rootMission.id));

  assert.equal(progress.leadsCreated, 2, "debe sumar 1 del pipeline clásico + 1 del dinámico, nunca perder ninguno");
});
