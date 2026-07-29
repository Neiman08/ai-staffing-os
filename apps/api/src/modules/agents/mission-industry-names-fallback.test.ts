import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { runMissionPipeline } from "./mission-orchestrator";

/**
 * F28 (misión real de Hospitality, 2026-07-28): interpretDailyDirective
 * (LLM) devolvió industryNames=[] para 3 misiones reales seguidas con
 * instrucciones largas/con formato de lista -- pese a que el intérprete
 * determinista (interpretBusinessIntent, sin LLM) sí matcheó
 * "hospitality" y armó queries reales con crmIndustryBucket="Hospitality".
 * Con industryNames vacío, industryTargets quedaba [] y el loop entero
 * de create_campaign/select_target_companies/create_lead/
 * create_opportunity nunca corría -- las 3 misiones reales terminaron
 * con 0 Leads/Opportunities pese a haber descubierto y validado empresas
 * reales. Este test reproduce el escenario exacto (industryNames=[] en
 * el input, simulando la respuesta real del LLM) y confirma que el
 * loop estático ahora sí corre, usando el crmIndustryBucket determinista
 * como respaldo.
 */

const TEST_PREFIX = "F28-INDUSTRY-FALLBACK";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.followUp.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.opportunity.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.lead.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaignCompany.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaign.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.contact.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

test(
  "runMissionPipeline: con industryNames=[] del LLM (bug real, Hospitality 2026-07-28), el loop estático (create_campaign/select_target_companies) igual corre usando el crmIndustryBucket determinista como respaldo",
  { skip: process.env.GOOGLE_PLACES_API_KEY ? false : "requiere GOOGLE_PLACES_API_KEY real" },
  async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `${TEST_PREFIX}-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-${Date.now()}` },
    });
    createdTenantIds.push(tenant.id);

    const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
    const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });
    for (const key of ["discovery", "campaign", "sales", "outreach"]) {
      const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key } });
      await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: definition.id, isActive: true } });
    }

    const missionRestrictions = {
      allowOutreach: false,
      allowDraftCreation: true,
      allowMessageSending: false,
      allowCampaignCreation: true,
      allowOpportunityCreation: true,
    };

    const task = await prisma.agentTask.create({
      data: {
        tenantId: tenant.id,
        agentInstanceId: ceoInstance.id,
        type: "daily_revenue_mission",
        status: "RUNNING",
        triggeredBy: "USER",
        input: {
          rawInstruction: "Busca hoteles en Decatur, Illinois. Crea Leads, Opportunities y Drafts únicamente. No envíes correos automáticamente.",
          launchedByUserId: "test-user",
          // El bug real: el LLM devolvió [] pese a que la instrucción
          // claramente pide hoteles -- se simula acá directamente en vez
          // de depender de que el LLM falle de la misma forma otra vez.
          industryNames: [],
          state: "IL",
          city: "Decatur",
          categoryNames: [],
          desiredVolume: null,
          businessObjective: { type: "companies_found", target: null, unit: "empresas", rawText: "hoteles en Illinois" },
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
          objectiveProgress: { type: "companies_found", target: null, unit: "empresas", current: 0, percentComplete: null, rawText: "hoteles en Illinois" },
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

    const children = await prisma.agentTask.findMany({ where: { parentTaskId: task.id } });
    const childTypes = children.map((c) => c.type);

    assert.ok(
      childTypes.includes("create_campaign"),
      `el loop estático nunca corrió (industryTargets quedó vacío) -- childTasks reales: ${childTypes.join(", ") || "ninguna"}`,
    );
  },
);
