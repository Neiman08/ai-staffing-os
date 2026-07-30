import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { runMissionPipeline } from "./mission-orchestrator";

/**
 * F29 (hallazgo real, MIS-20260729-0009, 2026-07-29): una misión real que
 * pidió empresas en 3 industrias distintas (Manufacturing, Warehouse/
 * Logistics, Hospitality) descubrió 21 empresas reales, 2 con
 * hiringStatus=LIKELY_HIRING, 1 con recomendación CREATE_OPPORTUNITY --
 * pero terminó con 0 Leads, 0 Opportunities, 0 Drafts. Causa raíz
 * confirmada con evidencia real (ver commit): 18/21 empresas quedaron en
 * businessConfidence=WEAK (companyTypes de packaging/food_manufacturing
 * demasiado angostos, ver taxonomy.ts) -- incluidas AMBAS con
 * LIKELY_HIRING -- así que nunca llegaron a
 * Company.commercialStatus=COMMERCIAL_VALIDATED y por lo tanto nunca
 * fueron elegibles para select_target_companies, sin importar su señal
 * de contratación real.
 *
 * Este test ejercita el pipeline clásico estático de punta a punta
 * (mission-orchestrator.ts, runMissionPipeline real) con 3 Companies YA
 * existentes en 3 industrias distintas -- mismo patrón que
 * mission-require-hiring-signal.test.ts/mission-name-exclusion.test.ts
 * (instrucción sin ningún término de taxonomía real, industryNames
 * pasado directo, cero descubrimiento real, cero costo de red) --
 * confirma que el mecanismo multi-industria (3 create_campaign/
 * select_target_companies, uno por industria) sigue funcionando
 * correctamente y que toda Company con señal de contratación válida
 * (sin importar en qué industria esté) avanza a Lead/Opportunity, y que
 * un Draft (ApprovalRequest real) solo se crea cuando existe un email
 * válido -- las demás quedan con una tarea alternativa (FollowUp), nunca
 * un borrador inventado.
 */

const TEST_PREFIX = "F29-MULTI-INDUSTRY";
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

test("runMissionPipeline: misión multiindustria (Hospitality + Manufacturing + Warehouse/Logistics) -- toda Company con señal válida genera Lead/Opportunity sin importar la industria, y solo la que tiene email real recibe un Draft", async () => {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);

  const [hospitality, manufacturing, warehouseLogistics] = await Promise.all([
    prisma.industry.findFirstOrThrow({ where: { name: "Hospitality", isGlobal: true } }),
    prisma.industry.findFirstOrThrow({ where: { name: "Manufacturing", isGlobal: true } }),
    prisma.industry.findFirstOrThrow({ where: { name: "Warehouse/Logistics", isGlobal: true } }),
  ]);

  const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
  const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });
  for (const key of ["campaign", "sales", "outreach"]) {
    const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key } });
    await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: definition.id, isActive: true } });
  }

  const hotelWithEmail = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: "Multi-Industry Hotel",
      industryId: hospitality.id,
      state: "IL",
      origin: "API_PROVIDER",
      commercialStatus: "COMMERCIAL_VALIDATED",
      email: "info@multiindustryhotel.com",
      discoveryMetadata: { hiringSignal: { hiringStatus: "CONFIRMED_HIRING" } },
    },
  });
  const manufacturerNoEmail = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: "Multi-Industry Manufacturing Co",
      industryId: manufacturing.id,
      state: "IL",
      origin: "API_PROVIDER",
      commercialStatus: "COMMERCIAL_VALIDATED",
      discoveryMetadata: { hiringSignal: { hiringStatus: "LIKELY_HIRING" } },
    },
  });
  const warehouseNoEmail = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: "Multi-Industry Warehouse LLC",
      industryId: warehouseLogistics.id,
      state: "IL",
      origin: "API_PROVIDER",
      commercialStatus: "COMMERCIAL_VALIDATED",
      discoveryMetadata: { hiringSignal: { hiringStatus: "POSSIBLE_HIRING" } },
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
        // Deliberadamente sin ningún término de taxonomía real -- cero
        // descubrimiento externo, cero llamadas de red (mismo criterio
        // que mission-require-hiring-signal.test.ts). industryNames se
        // pasa directo, como lo haría interpretDailyDirective en
        // producción real.
        rawInstruction: "Procesa las empresas existentes que estén contratando en las tres industrias.",
        launchedByUserId: "test-user",
        industryNames: ["Hospitality", "Manufacturing", "Warehouse/Logistics"],
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

  // Las 3 Companies, en 3 industrias distintas, generaron Lead +
  // Opportunity -- ninguna quedó bloqueada solo por pertenecer a
  // Manufacturing/Warehouse/Logistics en vez de Hospitality.
  for (const company of [hotelWithEmail, manufacturerNoEmail, warehouseNoEmail]) {
    const lead = await prisma.lead.findFirst({ where: { companyId: company.id } });
    assert.ok(lead, `"${company.name}" (${company.industryId}) debía recibir un Lead -- tiene señal de contratación válida`);
    const opportunity = await prisma.opportunity.findFirst({ where: { companyId: company.id } });
    assert.ok(opportunity, `"${company.name}" debía recibir una Opportunity`);
  }

  // Solo la Company con email real llega a un Draft de verdad
  // (ApprovalRequest) -- las otras dos, sin ningún canal de email,
  // quedan con una tarea alternativa (FollowUp), nunca un borrador
  // inventado.
  const hotelApproval = await prisma.approvalRequest.findFirst({ where: { companyId: hotelWithEmail.id } });
  assert.ok(hotelApproval, "'Multi-Industry Hotel' tiene email real -- debía generar un Draft (ApprovalRequest)");

  for (const company of [manufacturerNoEmail, warehouseNoEmail]) {
    const approval = await prisma.approvalRequest.findFirst({ where: { companyId: company.id } });
    assert.equal(approval, null, `"${company.name}" no tiene ningún email real -- nunca debía generar un Draft`);
    const altFollowUp = await prisma.followUp.findFirst({ where: { entityType: "company", entityId: company.id, notes: { contains: "Sin email disponible" } } });
    assert.ok(altFollowUp, `"${company.name}" debía recibir una tarea alternativa (FollowUp) en su lugar`);
  }
});
