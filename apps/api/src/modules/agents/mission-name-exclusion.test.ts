import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { runMissionPipeline } from "./mission-orchestrator";

/**
 * F28 (hallazgo real, misión de Hospitality, 2026-07-29, MIS-20260729-0005):
 * el fix del fallback por tradeKey resolvió companiesTargeted=0, pero
 * expuso un gap distinto -- "Cornerstone Inn", ya en el CRM desde una
 * misión anterior (sin esta exclusión), fue seleccionada por ese mismo
 * fallback y llegó a generar Lead+Opportunity reales pese a que la
 * misión excluía explícitamente moteles/inns/bed & breakfast/guest
 * houses. Pedido explícito del PO: "La restricción de la misión debe
 * prevalecer sobre el historial del CRM" -- ninguna Company cuyo nombre
 * matchee un término de exclusión de la misión debe: (a) ser
 * seleccionada por select_target_companies, (b) generar Lead, (c)
 * generar Opportunity, (d) generar Draft, sin importar si es un
 * descubrimiento nuevo o una Company ya existente en el CRM.
 *
 * Este test ejercita el pipeline clásico estático de punta a punta
 * (mission-orchestrator.ts, runMissionPipeline real) contra dos
 * Companies YA existentes (mismo patrón que
 * mission-require-hiring-signal.test.ts): una que matchea un término de
 * exclusión por nombre ("Cornerstone Inn" -> "inn") y otra que no ("The
 * Ivy Hotel"). La instrucción deliberadamente no menciona ningún término
 * de la Business Taxonomy (industryNames se pasa directo, como haría
 * interpretDailyDirective) -- así nunca dispara descubrimiento externo
 * real, cero costo/llamadas de red, mientras sigue ejercitando tanto la
 * capa de selección (campaign-tools.impl.ts) como el gate del loop
 * por-compañía (mission-orchestrator.ts).
 */

const TEST_PREFIX = "F28-NAME-EXCLUSION";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.followUp.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.opportunity.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.lead.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaignCompany.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaign.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupScenario(suffix: string) {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);

  const hospitality = await prisma.industry.findFirstOrThrow({ where: { name: "Hospitality", isGlobal: true } });
  const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
  const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });
  for (const key of ["campaign", "sales", "outreach"]) {
    const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key } });
    await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: definition.id, isActive: true } });
  }

  const innCompany = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: "Cornerstone Inn",
      industryId: hospitality.id,
      state: "IL",
      origin: "API_PROVIDER",
      commercialStatus: "COMMERCIAL_VALIDATED",
    },
  });
  const hotelCompany = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: "The Ivy Hotel",
      industryId: hospitality.id,
      state: "IL",
      origin: "API_PROVIDER",
      commercialStatus: "COMMERCIAL_VALIDATED",
    },
  });

  return { tenant, ceoInstance, hospitality, innCompany, hotelCompany };
}

function baseMissionRestrictions(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    allowOutreach: false,
    allowDraftCreation: false,
    allowMessageSending: false,
    allowCampaignCreation: true,
    allowOpportunityCreation: true,
    requireHiringSignal: false,
    ...overrides,
  };
}

async function createMissionTask(tenantId: string, ceoInstanceId: string, rawInstruction: string, missionRestrictions: ReturnType<typeof baseMissionRestrictions>) {
  return prisma.agentTask.create({
    data: {
      tenantId,
      agentInstanceId: ceoInstanceId,
      type: "daily_revenue_mission",
      status: "RUNNING",
      triggeredBy: "USER",
      input: {
        rawInstruction,
        launchedByUserId: "test-user",
        industryNames: ["Hospitality"],
        state: "IL",
        city: null,
        categoryNames: [],
        desiredVolume: null,
        businessObjective: { type: "companies_found", target: null, unit: "empresas", rawText: rawInstruction },
        unrecognizedTerms: [],
        useExternalDiscovery: false,
        externalSearchTerms: [],
        missionRestrictions,
      },
      output: {
        missionState: "RUNNING",
        companiesTargeted: 0,
        leadsCreated: 0,
        opportunitiesCreated: 0,
        sequencesPlanned: 0,
        draftsAwaitingApproval: 0,
        costUsdSoFar: 0,
        objectiveProgress: { type: "companies_found", target: null, unit: "empresas", current: 0, percentComplete: null, rawText: rawInstruction },
        progressUpdatedAt: new Date().toISOString(),
        error: null,
        appliedRestrictions: missionRestrictions,
        restrictionNotes: [],
      },
    },
  });
}

test("runMissionPipeline: con exclusión explícita de 'inn', la Company 'Cornerstone Inn' nunca es seleccionada ni recibe Lead/Opportunity -- 'The Ivy Hotel' sí avanza normalmente", async () => {
  const { tenant, ceoInstance, innCompany, hotelCompany } = await setupScenario("blocked");

  const task = await createMissionTask(
    tenant.id,
    ceoInstance.id,
    "Procesa las empresas existentes que estén contratando. Excluye inn, guest house.",
    baseMissionRestrictions(),
  );

  await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () =>
    runMissionPipeline(task.id, tenant.id, "test-user"),
  );

  // (a) nunca seleccionada por select_target_companies -- ni siquiera
  // entra a la Campaign.
  const innCampaignCompany = await prisma.campaignCompany.findFirst({ where: { companyId: innCompany.id } });
  assert.equal(innCampaignCompany, null, "'Cornerstone Inn' no debía ser seleccionada por select_target_companies -- coincide con la exclusión explícita de la misión");

  // (b)/(c) nunca genera Lead ni Opportunity.
  const innLead = await prisma.lead.findFirst({ where: { companyId: innCompany.id } });
  assert.equal(innLead, null, "'Cornerstone Inn' no debía recibir un Lead");
  const innOpportunity = await prisma.opportunity.findFirst({ where: { companyId: innCompany.id } });
  assert.equal(innOpportunity, null, "'Cornerstone Inn' no debía recibir una Opportunity");

  // Control positivo: un hotel real, sin exclusión aplicable, sigue
  // avanzando con normalidad -- la exclusión nunca debe bloquear
  // negocio legítimo.
  const hotelCampaignCompany = await prisma.campaignCompany.findFirst({ where: { companyId: hotelCompany.id } });
  assert.ok(hotelCampaignCompany, "'The Ivy Hotel' sí debía ser seleccionada -- no matchea ningún término excluido");
  const hotelLead = await prisma.lead.findFirst({ where: { companyId: hotelCompany.id } });
  assert.ok(hotelLead, "'The Ivy Hotel' sí debía recibir un Lead");
  const hotelOpportunity = await prisma.opportunity.findFirst({ where: { companyId: hotelCompany.id } });
  assert.ok(hotelOpportunity, "'The Ivy Hotel' sí debía recibir una Opportunity");

  // Igual que requireHiringSignal: la exclusión nunca borra la Company
  // ni le impide quedar registrada, solo detiene su avance comercial.
  const stillExists = await prisma.company.count({ where: { id: { in: [innCompany.id, hotelCompany.id] } } });
  assert.equal(stillExists, 2);
});

test("runMissionPipeline: SIN exclusión explícita en la instrucción, 'Cornerstone Inn' sigue pudiendo seleccionarse y avanzar normalmente (no se rompe el caso de uso existente)", async () => {
  const { tenant, ceoInstance, innCompany } = await setupScenario("unblocked");

  const task = await createMissionTask(
    tenant.id,
    ceoInstance.id,
    "Procesa las empresas existentes que estén contratando.",
    baseMissionRestrictions(),
  );

  await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () =>
    runMissionPipeline(task.id, tenant.id, "test-user"),
  );

  const innCampaignCompany = await prisma.campaignCompany.findFirst({ where: { companyId: innCompany.id } });
  assert.ok(innCampaignCompany, "sin exclusión explícita en la instrucción, 'Cornerstone Inn' debía seguir siendo seleccionable como cualquier otra Company");
  const innLead = await prisma.lead.findFirst({ where: { companyId: innCompany.id } });
  assert.ok(innLead, "sin exclusión explícita, 'Cornerstone Inn' debía seguir pudiendo recibir un Lead");
});
