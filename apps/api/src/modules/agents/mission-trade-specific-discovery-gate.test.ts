import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { runMissionPipeline } from "./mission-orchestrator";

/**
 * F28 (roofing IL, misión real 2026-07-27 -- segundo hallazgo, más
 * profundo que el aislamiento de campañas): antes de este fix, el gate
 * que decide si correr descubrimiento+validación externa real
 * (executeDiscoveryPlan, donde viven los fixes C/E: geo estricta y
 * evidencia real de trade) SOLO se activaba cuando la Industry amplia del
 * CRM ("Construction") estaba vacía o se pidió un volumen explícito. Una
 * instrucción real como "roofing contractors en Illinois", con el CRM ya
 * teniendo CUALQUIER empresa de Construction (de otro trade, de una
 * misión anterior, o del seed), nunca pasaba por ahí -- se resolvía
 * enteramente contra el bucket amplio existente, sin ninguna validación
 * de trade específico. Este test reproduce exactamente ese escenario:
 * una empresa de Construction YA existente (no roofing) sembrada antes
 * de correr la misión, y confirma que el descubrimiento externo real
 * corre de todos modos porque la instrucción matcheó un trade específico
 * (roofing, isGenericFallback=false).
 *
 * Usa runMissionPipeline directo (exportado solo para este test) para
 * saltear interpretDailyDirective (LLM) -- interpretBusinessIntent
 * (F7.1, determinista) es lo que realmente calcula el match de
 * taxonomía, así que construir el input a mano es fiel al camino real.
 * Sí hace una llamada real a Google Places (Discovery real, sin LLM) --
 * mismo costo/naturaleza que otros tests de este módulo que ya dependen
 * de proveedores reales.
 */

const TEST_PREFIX = "F28-TRADE-GATE";
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
  "runMissionPipeline: una instrucción de trade específico (roofing) SIEMPRE corre descubrimiento+validación externa real, aunque el CRM ya tenga otras empresas de Construction (bug real: el gate se saltaba por completo)",
  { skip: process.env.GOOGLE_PLACES_API_KEY ? false : "requiere GOOGLE_PLACES_API_KEY real" },
  async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `${TEST_PREFIX}-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-${Date.now()}` },
    });
    createdTenantIds.push(tenant.id);

    const construction = await prisma.industry.findFirstOrThrow({ where: { name: "Construction", isGlobal: true } });
    const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
    const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });
    // El pipeline real delega a discovery/campaign/sales/outreach además
    // de ceo -- cada uno necesita su propia AgentInstance en el tenant.
    for (const key of ["discovery", "campaign", "sales", "outreach"]) {
      const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key } });
      await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: definition.id, isActive: true } });
    }

    // Simula el estado real reportado: el bucket amplio "Construction" en
    // IL YA tiene una empresa (de otro trade), antes de correr esta
    // misión de roofing.
    await prisma.company.create({
      data: {
        tenantId: tenant.id,
        name: "Old Electrical Contractor (pre-existente, otro trade)",
        industryId: construction.id,
        state: "IL",
        origin: "API_PROVIDER",
      },
    });

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
          // Ciudad chica y específica (no "Illinois" a secas) a propósito
          // -- mantiene la llamada real a Google Places barata/rápida
          // (pocos resultados reales) sin dejar de ejercitar el camino
          // real: interpretBusinessIntent detecta ciudad+estado del mismo
          // rawInstruction que arma la query real.
          rawInstruction: "Busca roofing contractors en Decatur, Illinois. Crea Leads, Opportunities y Drafts únicamente. No envíes correos automáticamente.",
          launchedByUserId: "test-user",
          industryNames: ["Construction"],
          state: "IL",
          city: "Decatur",
          categoryNames: [],
          desiredVolume: null,
          businessObjective: { type: "companies_found", target: null, unit: "empresas", rawText: "roofing contractors en Illinois" },
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
          objectiveProgress: { type: "companies_found", target: null, unit: "empresas", current: 0, percentComplete: null, rawText: "roofing contractors en Illinois" },
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

    const finished = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    const output = finished.output as { discoveryFallback?: unknown } | null;

    assert.ok(
      output?.discoveryFallback,
      "el descubrimiento externo real (executeDiscoveryPlan, con las validaciones de geo/trade C y E) nunca corrió -- el gate se saltó por completo pese a pedir un trade específico (roofing) con Construction ya poblado",
    );
  },
);

/**
 * F32 (hallazgo real, MIS-20260731-0011, 2026-07-31): mismo bug
 * estructural que el test de arriba (F28, roofing), un nivel más
 * profundo -- para un término LITERAL (un tipo de empresa que la
 * taxonomía no reconoce todavía, ej. "instalación de paneles solares
 * comerciales"), hasSpecificTradeMatch (arriba) es SIEMPRE falso
 * (matchedTaxonomyKeys=[] -- no hay ninguna entrada de taxonomía
 * involucrada). La misión real usó exactamente este input
 * (industryNames=["Construction"], la industria aproximada que
 * interpretDailyDirective adivinó solo para archivar -- ver el prompt
 * en ceo-tools.impl.ts) con el CRM ya teniendo oferta de Construction de
 * OTRO trade: el gate nunca se activaba, discoveryFallback quedaba
 * completamente ausente del output, y la misión terminaba "COMPLETED"
 * con 0 empresas sin haber intentado nada.
 */
test(
  "runMissionPipeline: un término literal sin taxonomía SIEMPRE corre descubrimiento+validación externa real, aunque industryNames traiga una industria aproximada ya poblada (caso real MIS-20260731-0011)",
  { skip: process.env.GOOGLE_PLACES_API_KEY ? false : "requiere GOOGLE_PLACES_API_KEY real" },
  async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `${TEST_PREFIX}-LITERAL-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-literal-${Date.now()}` },
    });
    createdTenantIds.push(tenant.id);

    const construction = await prisma.industry.findFirstOrThrow({ where: { name: "Construction", isGlobal: true } });
    const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
    const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });
    for (const key of ["discovery", "campaign", "sales", "outreach"]) {
      const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key } });
      await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: definition.id, isActive: true } });
    }

    // Mismo escenario real: el bucket amplio "Construction" en IL YA
    // tiene oferta (de un trade completamente ajeno al pedido).
    await prisma.company.create({
      data: {
        tenantId: tenant.id,
        name: "Old Roofing Company (pre-existente, otro rubro por completo)",
        industryId: construction.id,
        state: "IL",
        origin: "API_PROVIDER",
      },
    });

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
          rawInstruction:
            "Busca hasta 3 empresas nuevas de instalación de paneles solares comerciales en Decatur, Illinois que puedan necesitar personal de campo.",
          launchedByUserId: "test-user",
          // Mismo input real observado en producción: el LLM adivinó
          // "Construction" como industria de archivo aproximada, sin
          // useExternalDiscovery ni externalSearchTerms -- exactamente lo
          // que hace que este camino (auto-fallback clásico) sea la
          // única red de seguridad real.
          industryNames: ["Construction"],
          state: "IL",
          city: "Decatur",
          categoryNames: [],
          desiredVolume: null,
          businessObjective: { type: "companies_found", target: null, unit: "empresas", rawText: "instalación de paneles solares comerciales en Illinois" },
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
          objectiveProgress: { type: "companies_found", target: null, unit: "empresas", current: 0, percentComplete: null, rawText: "instalación de paneles solares comerciales en Illinois" },
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

    const finished = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    const output = finished.output as {
      discoveryFallback?: { queryExecutions?: Array<{ query?: string }> };
    } | null;

    assert.ok(
      output?.discoveryFallback,
      "el descubrimiento externo real nunca corrió -- el gate se saltó por completo pese a un término literal, exactamente el bug real de MIS-20260731-0011",
    );
    // F32 (bugfix real encontrado ejecutando ESTE mismo test, 2026-07-31):
    // este camino (clásico + auto-fallback, a diferencia del
    // completamente dinámico) nunca persiste ceoIntent en su output --
    // la trazabilidad real que SÍ se puede verificar acá es que la query
    // ejecutada de verdad sea el término literal limpio, nunca un
    // fragmento roto por el calificador geográfico ("Illinois" suelto,
    // el bug real que este mismo test atrapó antes de este fix).
    const queries = (output?.discoveryFallback?.queryExecutions ?? []).map((q) => q.query);
    assert.ok(
      queries.some((q) => q?.toLowerCase().includes("paneles solares") || q?.toLowerCase().includes("solar")),
      `la query ejecutada debe ser el término literal real, nunca un fragmento geográfico roto -- queries reales: ${JSON.stringify(queries)}`,
    );
    assert.ok(
      !queries.some((q) => q === "Illinois" || q?.toLowerCase() === "illinois"),
      `ninguna query debe ser un fragmento geográfico suelto ("Illinois" solo) -- bug real encontrado y corregido en esta misma investigación: queries reales: ${JSON.stringify(queries)}`,
    );
  },
);

/**
 * F33 (auditoría de regresión reportada, 2026-08-01, hallazgo real
 * MIS-20260801-0005): una industria GENÉRICA (isGenericFallback=true,
 * ej. "manufactura" sin trade específico) con oferta interna REAL pero
 * SIN VALIDAR comercialmente (Company.commercialStatus=DISCOVERY_CANDIDATE
 * -- confianza WEAK/REJECTED al momento del descubrimiento original)
 * hacía que internalSupply pareciera "suficiente" (contaba TODAS las
 * Company del bucket, sin filtrar por commercialStatus) y el gate se
 * saltaba el descubrimiento real -- pero select_target_companies, con su
 * propio filtro más estricto (commercialStatus="COMMERCIAL_VALIDATED",
 * F18), no encontraba NADA que seleccionar. La misión terminaba
 * "COMPLETED" con 0 empresas, sin haber intentado nunca un
 * descubrimiento real, pese a pedir explícitamente "empresas nuevas".
 */
test(
  "runMissionPipeline: una industria genérica con oferta interna NO validada comercialmente SIEMPRE fuerza descubrimiento real, nunca se saltea el gate por un conteo que ignora commercialStatus (caso real MIS-20260801-0005)",
  { skip: process.env.GOOGLE_PLACES_API_KEY ? false : "requiere GOOGLE_PLACES_API_KEY real" },
  async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `${TEST_PREFIX}-COMMSTATUS-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-commstatus-${Date.now()}` },
    });
    createdTenantIds.push(tenant.id);

    const manufacturing = await prisma.industry.findFirstOrThrow({ where: { name: "Manufacturing", isGlobal: true } });
    const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
    const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });
    for (const key of ["discovery", "campaign", "sales", "outreach"]) {
      const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key } });
      await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: definition.id, isActive: true } });
    }

    // Oferta interna REAL (más que perCampaignVolume) pero NUNCA
    // validada comercialmente -- exactamente el estado real que
    // internalSupply ignoraba antes de este fix.
    for (let i = 0; i < 5; i++) {
      await prisma.company.create({
        data: {
          tenantId: tenant.id,
          name: `Unvalidated Manufacturing Co ${i}`,
          industryId: manufacturing.id,
          state: "IL",
          origin: "API_PROVIDER",
          commercialStatus: "DISCOVERY_CANDIDATE",
        },
      });
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
          rawInstruction: "Busca hasta 3 empresas nuevas de manufactura en Decatur, Illinois que puedan necesitar personal de campo.",
          launchedByUserId: "test-user",
          industryNames: ["Manufacturing"],
          state: "IL",
          city: "Decatur",
          categoryNames: [],
          desiredVolume: 3,
          businessObjective: { type: "companies_found", target: 3, unit: "empresas", rawText: "empresas de manufactura en Illinois" },
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
          objectiveProgress: { type: "companies_found", target: 3, unit: "empresas", current: 0, percentComplete: 0, rawText: "empresas de manufactura en Illinois" },
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

    const finished = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    const output = finished.output as { discoveryFallback?: unknown } | null;

    assert.ok(
      output?.discoveryFallback,
      "el descubrimiento externo real nunca corrió -- internalSupply contó 5 empresas sin validar comercialmente como si fueran oferta real, y el gate se saltó pese a pedir explícitamente empresas nuevas (bug real MIS-20260801-0005)",
    );
  },
);

/**
 * F33 (auditoría de regresión reportada, 2026-08-01, hallazgo real
 * MIS-20260801-0006): SEGUNDO gap real en internalSupply, encontrado
 * corriendo una misión real inmediatamente después del fix de
 * commercialStatus de arriba -- oferta interna REAL y comercialmente
 * validada, pero YA targeteada en otra Campaign ACTIVE del tenant
 * (CampaignCompany.status en TARGETED/SEQUENCING/HOT/RECOVERED).
 * select_target_companies excluye esas empresas SIEMPRE
 * (`excludedElsewhere`, campaign-tools.impl.ts) sin importar de qué
 * campaña vengan, pero internalSupply tampoco lo replicaba -- mismo
 * síntoma exacto: la misión "veía" oferta suficiente, forzaba el
 * camino de reutilización de CRM, y select_target_companies no
 * encontraba nada real que seleccionar.
 */
test(
  "runMissionPipeline: oferta interna REAL y validada comercialmente pero YA targeteada en otra campaña activa SIEMPRE fuerza descubrimiento real (caso real MIS-20260801-0006)",
  { skip: process.env.GOOGLE_PLACES_API_KEY ? false : "requiere GOOGLE_PLACES_API_KEY real" },
  async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `${TEST_PREFIX}-ELSEWHERE-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-elsewhere-${Date.now()}` },
    });
    createdTenantIds.push(tenant.id);

    const manufacturing = await prisma.industry.findFirstOrThrow({ where: { name: "Manufacturing", isGlobal: true } });
    const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
    const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });
    for (const key of ["discovery", "campaign", "sales", "outreach"]) {
      const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key } });
      await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: definition.id, isActive: true } });
    }

    // Oferta interna REAL, comercialmente VALIDADA (a diferencia del test
    // anterior) -- pero ya targeteada en OTRA Campaign ACTIVE, exactamente
    // el estado real que select_target_companies excluye siempre.
    const otherCampaign = await prisma.campaign.create({
      data: { tenantId: tenant.id, name: "Otra campaña ya activa", industryId: manufacturing.id, state: "IL", status: "ACTIVE" },
    });
    for (let i = 0; i < 5; i++) {
      const company = await prisma.company.create({
        data: {
          tenantId: tenant.id,
          name: `Already Targeted Manufacturing Co ${i}`,
          industryId: manufacturing.id,
          state: "IL",
          origin: "API_PROVIDER",
          commercialStatus: "COMMERCIAL_VALIDATED",
        },
      });
      await prisma.campaignCompany.create({
        data: { tenantId: tenant.id, campaignId: otherCampaign.id, companyId: company.id, status: "TARGETED" },
      });
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
          rawInstruction: "Busca hasta 3 empresas nuevas de manufactura en Decatur, Illinois que puedan necesitar personal de campo.",
          launchedByUserId: "test-user",
          industryNames: ["Manufacturing"],
          state: "IL",
          city: "Decatur",
          categoryNames: [],
          desiredVolume: 3,
          businessObjective: { type: "companies_found", target: 3, unit: "empresas", rawText: "empresas de manufactura en Illinois" },
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
          objectiveProgress: { type: "companies_found", target: 3, unit: "empresas", current: 0, percentComplete: 0, rawText: "empresas de manufactura en Illinois" },
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

    const finished = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    const output = finished.output as { discoveryFallback?: unknown } | null;

    assert.ok(
      output?.discoveryFallback,
      "el descubrimiento externo real nunca corrió -- internalSupply contó 5 empresas ya targeteadas en otra campaña activa como si fueran oferta real disponible (bug real MIS-20260801-0006)",
    );
  },
);
