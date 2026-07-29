import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../../core/tenancy/context";
import { computeMissionProgress } from "./ceo-tools.impl";

/**
 * F28 (misión real de Hospitality, 2026-07-29): companiesTargeted se
 * calculaba como select_target_companies.addedCount + un conteo aparte
 * de Company.discoveredByAgentTaskId -- ambos sumados directamente. En
 * el camino híbrido real (descubrimiento externo real -- fallback o
 * dinámico -- seguido del loop clásico estático seleccionando esas
 * MISMAS Company vía select_target_companies), una Company terminaba
 * contada dos veces: la misión real MIS-20260729-0001 reportó
 * companiesTargeted=2 con una sola Company real
 * ("Griffin Hotel Management"). El fix toma la UNIÓN de ids reales de
 * ambas fuentes (select_target_companies.companyIds ∪
 * Company.discoveredByAgentTaskId) en vez de sumar conteos -- una misma
 * Company nunca puede contar más de una vez.
 *
 * 3 escenarios, cada uno verificando que companiesTargeted coincide con
 * el número REAL de Company distintas (nunca estimado, siempre contra
 * los ids reales de la base):
 *   1. Pipeline dinámico puro -- sin select_target_companies.
 *   2. Pipeline estático puro -- sin discover_companies (empresas ya
 *      existentes en el CRM, nunca descubiertas por ESTA misión).
 *   3. Pipeline híbrido -- la MISMA Company referenciada por ambos
 *      caminos (el escenario real que causó el bug).
 */

const TEST_PREFIX = "F28-COMPANIES-TARGETED";
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

async function setupTenant(suffix: string) {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
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
  return { tenant, hospitality, ceoInstance, rootMission };
}

test("companiesTargeted -- pipeline dinámico puro: sin select_target_companies, cuenta exactamente las Company reales vía discoveredByAgentTaskId", async () => {
  const { tenant, hospitality, ceoInstance, rootMission } = await setupTenant("dynamic-only");

  const discoverTask = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "discover_companies", parentTaskId: rootMission.id, status: "DONE", triggeredBy: "AGENT", input: {}, output: { companyValidations: [] } },
  });
  const companies = await Promise.all(
    ["Dynamic Hotel A", "Dynamic Hotel B"].map((name) =>
      prisma.company.create({ data: { tenantId: tenant.id, name, industryId: hospitality.id, state: "IL", origin: "API_PROVIDER", discoveredByAgentTaskId: discoverTask.id } }),
    ),
  );

  const progress = await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () => computeMissionProgress(rootMission.id));

  assert.equal(progress.companiesTargeted, companies.length, `esperaba ${companies.length} (número real de Company), obtuvo ${progress.companiesTargeted}`);
});

test("companiesTargeted -- pipeline estático puro: sin discover_companies, cuenta exactamente las Company de select_target_companies.companyIds", async () => {
  const { tenant, hospitality, ceoInstance, rootMission } = await setupTenant("static-only");

  // Empresas YA existentes en el CRM -- nunca descubiertas por esta
  // misión (sin discoveredByAgentTaskId), seleccionadas por el loop
  // clásico vía select_target_companies.
  const companies = await Promise.all(
    ["Existing Hotel A", "Existing Hotel B", "Existing Hotel C"].map((name) =>
      prisma.company.create({ data: { tenantId: tenant.id, name, industryId: hospitality.id, state: "IL", origin: "API_PROVIDER" } }),
    ),
  );
  await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: ceoInstance.id,
      type: "select_target_companies",
      parentTaskId: rootMission.id,
      status: "DONE",
      triggeredBy: "AGENT",
      input: {},
      output: { addedCount: companies.length, companyIds: companies.map((c) => c.id) },
    },
  });

  const progress = await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () => computeMissionProgress(rootMission.id));

  assert.equal(progress.companiesTargeted, companies.length, `esperaba ${companies.length} (número real de Company), obtuvo ${progress.companiesTargeted}`);
});

test("companiesTargeted -- pipeline híbrido (bug real, MIS-20260729-0001): la MISMA Company referenciada por discover_companies Y select_target_companies cuenta UNA sola vez", async () => {
  const { tenant, hospitality, ceoInstance, rootMission } = await setupTenant("hybrid");

  // El escenario real: runAutoExternalDiscoveryFallback descubre una
  // Company nueva (discoveredByAgentTaskId = discover_companies), y el
  // loop estático la selecciona con restrictToCompanyIds (mismo id) --
  // exactamente lo que pasó con "Griffin Hotel Management".
  const discoverTask = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "discover_companies", parentTaskId: rootMission.id, status: "DONE", triggeredBy: "AGENT", input: {}, output: { companyValidations: [] } },
  });
  const company = await prisma.company.create({
    data: { tenantId: tenant.id, name: "Griffin Hotel Management", industryId: hospitality.id, state: "IL", origin: "API_PROVIDER", discoveredByAgentTaskId: discoverTask.id },
  });
  await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: ceoInstance.id,
      type: "select_target_companies",
      parentTaskId: rootMission.id,
      status: "DONE",
      triggeredBy: "AGENT",
      input: {},
      output: { addedCount: 1, companyIds: [company.id] },
    },
  });

  const progress = await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () => computeMissionProgress(rootMission.id));

  assert.equal(progress.companiesTargeted, 1, `una sola Company real nunca debe contar como ${progress.companiesTargeted} -- bug real reproducido si esto falla`);
});

test("companiesTargeted -- pipeline híbrido con empresas DISTINTAS en cada camino: se suman sin dedupe indebido (nunca se pierde una Company real por el fix)", async () => {
  const { tenant, hospitality, ceoInstance, rootMission } = await setupTenant("hybrid-distinct");

  const discoverTask = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: ceoInstance.id, type: "discover_companies", parentTaskId: rootMission.id, status: "DONE", triggeredBy: "AGENT", input: {}, output: { companyValidations: [] } },
  });
  const newlyDiscovered = await prisma.company.create({
    data: { tenantId: tenant.id, name: "Newly Discovered Hotel", industryId: hospitality.id, state: "IL", origin: "API_PROVIDER", discoveredByAgentTaskId: discoverTask.id },
  });
  // Empresa YA existente en el CRM, seleccionada además de la nueva
  // (ej. "trabajar sobre la base existente" -- select_target_companies
  // sin restrictToCompanyIds).
  const preExisting = await prisma.company.create({
    data: { tenantId: tenant.id, name: "Pre-existing Hotel", industryId: hospitality.id, state: "IL", origin: "API_PROVIDER" },
  });
  await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: ceoInstance.id,
      type: "select_target_companies",
      parentTaskId: rootMission.id,
      status: "DONE",
      triggeredBy: "AGENT",
      input: {},
      output: { addedCount: 2, companyIds: [newlyDiscovered.id, preExisting.id] },
    },
  });

  const progress = await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () => computeMissionProgress(rootMission.id));

  assert.equal(progress.companiesTargeted, 2, "2 Company reales y distintas -- el fix de dedupe nunca debe perder una empresa real que no se superpone");
});
