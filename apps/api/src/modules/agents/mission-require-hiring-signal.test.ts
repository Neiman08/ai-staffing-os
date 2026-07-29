import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { runMissionPipeline } from "./mission-orchestrator";

/**
 * F28 (misión real de Hospitality, 2026-07-28, pedido explícito del PO):
 * "cuando la misión especifique explícitamente 'que estén contratando',
 * solo se creen Leads y Opportunities para empresas con Confirmed,
 * Probable o Possible. Las empresas con No Signal o Unknown pueden
 * registrarse como Company, pero no avanzar en el pipeline comercial."
 *
 * Este test ejercita el pipeline clásico estático (mission-orchestrator.ts,
 * el loop real que crea create_lead/create_opportunity) contra dos
 * Companies YA existentes con distinta señal de contratación real
 * (Company.discoveryMetadata.hiringSignal.hiringStatus, el mismo campo
 * que persiste mission-executor.ts durante discovery real). Usa una
 * instrucción que no matchea ningún término de la taxonomía a propósito
 * (industryNames se pasa directo en el input, como haría interpretDailyDirective)
 * -- así nunca dispara descubrimiento externo real, cero costo/llamadas
 * de red, mientras sigue ejercitando el loop real de creación de Lead.
 */

const TEST_PREFIX = "F28-REQUIRE-HIRING";
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

test("runMissionPipeline: con requireHiringSignal=true, solo la Company con señal de contratación positiva recibe Lead/Opportunity -- la otra queda registrada, sin avanzar", async () => {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);

  const hospitality = await prisma.industry.findFirstOrThrow({ where: { name: "Hospitality", isGlobal: true } });
  const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
  const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });
  for (const key of ["campaign", "sales", "outreach"]) {
    const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key } });
    await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: definition.id, isActive: true } });
  }

  const hiringCompany = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: "Confirmed Hiring Hotel",
      industryId: hospitality.id,
      state: "IL",
      origin: "API_PROVIDER",
      commercialStatus: "COMMERCIAL_VALIDATED",
      discoveryMetadata: { hiringSignal: { hiringStatus: "CONFIRMED_HIRING" } },
    },
  });
  const noSignalCompany = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: "No Signal Hotel",
      industryId: hospitality.id,
      state: "IL",
      origin: "API_PROVIDER",
      commercialStatus: "COMMERCIAL_VALIDATED",
      discoveryMetadata: { hiringSignal: { hiringStatus: "NO_SIGNAL" } },
    },
  });

  const missionRestrictions = {
    allowOutreach: false,
    allowDraftCreation: true,
    allowMessageSending: false,
    allowCampaignCreation: true,
    allowOpportunityCreation: true,
    requireHiringSignal: true,
  };

  const task = await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: ceoInstance.id,
      type: "daily_revenue_mission",
      status: "RUNNING",
      triggeredBy: "USER",
      input: {
        // Deliberadamente sin ningún término de taxonomía real (nunca
        // dice "hotel"/"resort"/etc.) -- externalPlan.searchQueries
        // queda vacío, así que el descubrimiento externo real nunca
        // dispara, cero llamadas de red. industryNames se pasa directo,
        // como lo haría interpretDailyDirective en producción.
        rawInstruction: "Procesa las empresas existentes que estén contratando.",
        launchedByUserId: "test-user",
        industryNames: ["Hospitality"],
        state: "IL",
        city: null,
        categoryNames: [],
        desiredVolume: null,
        businessObjective: { type: "companies_found", target: null, unit: "empresas", rawText: "empresas existentes que estén contratando" },
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
        objectiveProgress: { type: "companies_found", target: null, unit: "empresas", current: 0, percentComplete: null, rawText: "empresas existentes que estén contratando" },
        progressUpdatedAt: new Date().toISOString(),
        error: null,
        appliedRestrictions: missionRestrictions,
        restrictionNotes: [],
      },
    },
  });

  await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () =>
    runMissionPipeline(task.id, tenant.id, "test-user"),
  );

  const [hiringLead, noSignalLead] = await Promise.all([
    prisma.lead.findFirst({ where: { companyId: hiringCompany.id } }),
    prisma.lead.findFirst({ where: { companyId: noSignalCompany.id } }),
  ]);

  assert.ok(hiringLead, "la Company con CONFIRMED_HIRING debía recibir un Lead");
  assert.equal(noSignalLead, null, "la Company con NO_SIGNAL nunca debía recibir un Lead -- requireHiringSignal lo exige");

  // Ambas Companies siguen existiendo -- requireHiringSignal nunca las
  // borra ni las bloquea a nivel de discovery, solo detiene su avance en
  // el pipeline comercial.
  const stillExists = await prisma.company.count({ where: { id: { in: [hiringCompany.id, noSignalCompany.id] } } });
  assert.equal(stillExists, 2);
});
