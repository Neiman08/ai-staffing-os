import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { DEFAULT_MISSION_RESTRICTIONS, type MissionRestrictions } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../core/tenancy/context";
import type { MissionPlan } from "../ceo-intelligence/contracts";
import { resetProviderHealthForTests } from "./tools/provider-health";
import { emptyResult, type ProviderCandidate } from "./tools/discovery-providers/types";
import { executeDiscoveryPlan, type DiscoveryProviderPort } from "./mission-executor";
import { computeMissionProgress } from "./tools/ceo-tools.impl";
import { emptyWebsiteIntelligenceResult } from "./tools/website-intelligence/types";
import type { WebsiteIntelligencePort } from "./company-enrichment";
import { fakeDraftLLMProvider } from "./draft-generation.test-support";

/**
 * Endurecimiento del motor (hallazgo real de producción, MIS-20260802-0002):
 * una misión de manufactura con 20 empresas pedidas terminó FAILED
 * (missionState=FAILED, companiesTargeted=0, leadsCreated=0,
 * opportunitiesCreated=0) porque UNA sola empresa falló al generar su
 * Draft -- la excepción escapó sin aislamiento, abortó
 * executeDiscoveryPlan entero, y dejó el AgentTask "discover_companies"
 * huérfano en RUNNING para siempre, pese a que ya existían 2
 * ApprovalRequest reales (evidencia de que otras empresas sí se habían
 * procesado bien antes del fallo).
 *
 * Estos tests reproducen esa clase de fallo con evidencia real (Postgres
 * real, sin red real) y demuestran las invariantes:
 *   #1 -- un error real en UNA empresa nunca aborta la misión completa.
 *   #2 -- el AgentTask discover_companies siempre llega a un estado
 *         terminal (DONE), nunca queda huérfano en RUNNING.
 *   #8/#9 -- los totales (computeMissionProgress) coinciden con lo
 *         realmente persistido en la base, incluso cuando una empresa
 *         falló.
 */

const originalFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("mission-executor.resilience.test.ts: intento de llamada de red real — los proveedores deben inyectarse mockeados.");
}) as typeof fetch;

const TEST_PREFIX = "RESIL-TEST";
const createdTenantIds: string[] = [];
const createdTaskIds: string[] = [];
const createdCompanyIds: string[] = [];

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  const discoveryDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "discovery" } });
  await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: discoveryDefinition.id, isActive: true } });
  const missionTask = await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: (await prisma.agentInstance.findFirstOrThrow({ where: { tenantId: tenant.id } })).id,
      type: "daily_revenue_mission",
      input: { businessObjective: { type: "companies_found", target: null, unit: "empresas", rawText: "fixture" } },
      status: "RUNNING",
      triggeredBy: "USER",
    },
  });
  createdTaskIds.push(missionTask.id);
  createdTenantIds.push(tenant.id);
  return tenant.id;
}

after(async () => {
  globalThis.fetch = originalFetch;
  if (createdTenantIds.length) {
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.opportunity.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.lead.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.contact.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.companyContactPoint.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  }
  if (createdCompanyIds.length) {
    await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  }
  for (const taskId of createdTaskIds) {
    await prisma.auditLog.deleteMany({ where: { entityId: taskId } });
    await prisma.activity.deleteMany({ where: { entityId: taskId } });
  }
  await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  if (createdTenantIds.length) {
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

beforeEach(() => resetProviderHealthForTests());

function manufacturingPlan(overrides: Partial<MissionPlan> = {}): MissionPlan {
  return {
    schemaVersion: 1,
    objective: { type: "find_companies", targetCompanyCount: 2, rawText: "2 empresas de manufactura" },
    searchQueries: [{ searchTerm: "manufacturing company", crmIndustryBucket: "Manufacturing", taxonomyKey: "manufacturing" }],
    exclusions: [],
    specificTaxonomyKeys: [],
    literalCompanyTypeTerms: [],
    cities: [],
    states: ["IL"],
    steps: ["discover_companies", "find_hiring_signals"],
    requiredSteps: ["discover_companies"],
    optionalSteps: ["find_hiring_signals", "find_contacts"],
    stopConditions: { maxCompanies: 2, maxCostUsd: 3, maxDurationMinutes: 60 },
    dedupStrategy: ["providerPlaceId", "canonicalDomain", "normalizedPhone", "normalizedNameCityState"],
    fallbackStrategy: [{ provider: "Google Places", whenUnavailable: "Usar Overpass." }],
    restrictions: DEFAULT_MISSION_RESTRICTIONS,
    rationale: "fixture",
    ...overrides,
  };
}

function candidateFixture(overrides: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    name: "Acme Manufacturing",
    fields: {
      website: { status: "CONFIRMED", value: "https://www.acme-mfg.com" },
      phone: { status: "CONFIRMED", value: "(312) 555-0100" },
      city: { status: "CONFIRMED", value: "Chicago" },
      email: { status: "NOT_FOUND", value: null },
      state: { status: "CONFIRMED", value: "IL" },
      address: { status: "NOT_FOUND", value: null },
    },
    sourceUrl: "https://www.google.com/maps/place/?q=place_id:PLACE-1",
    ...overrides,
  };
}

async function run(tenantId: string, plan: MissionPlan, providers: DiscoveryProviderPort, websiteIntelligence: WebsiteIntelligencePort, restrictions?: MissionRestrictions) {
  return runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["missions.create"] }, async () => {
    const missionTask = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "daily_revenue_mission" } });
    const report = await executeDiscoveryPlan({
      missionTaskId: missionTask.id,
      plan,
      restrictions: restrictions ?? DEFAULT_MISSION_RESTRICTIONS,
      providers,
      googlePlacesApiKey: "fake-key-for-tests",
      websiteIntelligence,
      targetJobTitles: [],
      decisionRoles: [],
      convertToCommercialActions: true,
      businessActivities: [],
      llmProvider: fakeDraftLLMProvider().provider,
    });
    createdCompanyIds.push(...report.createdCompanyIds);
    return { report, missionTaskId: missionTask.id };
  });
}

test("invariante #1/#2/#8: un error real (Website Intelligence) en UNA empresa no aborta la misión -- la otra se procesa completa, discover_companies llega a DONE, companyErrors registra el fallo, y los totales coinciden con la DB", async () => {
  const tenantId = await setupTenant("one-company-fails");
  const failingCandidate = candidateFixture({
    name: "Failing Manufacturing Co",
    fields: {
      ...candidateFixture().fields,
      website: { status: "CONFIRMED", value: "https://www.failing-co.example" },
      phone: { status: "CONFIRMED", value: "(312) 555-0101" },
    },
    sourceUrl: "https://www.google.com/maps/place/?q=place_id:PLACE-FAILING",
  });
  const okCandidate = candidateFixture({
    name: "Working Manufacturing Co",
    fields: {
      ...candidateFixture().fields,
      website: { status: "CONFIRMED", value: "https://www.working-co.example" },
      phone: { status: "CONFIRMED", value: "(312) 555-0102" },
    },
    sourceUrl: "https://www.google.com/maps/place/?q=place_id:PLACE-WORKING",
  });
  const providers: DiscoveryProviderPort = {
    searchGooglePlaces: async () => ({
      candidates: [failingCandidate, okCandidate],
      costUsd: 0.032,
      sourcesUsed: ["Google Places (fixture)"],
      patternsFailed: [],
      cancelled: false,
    }),
    searchOverpass: async () => emptyResult(),
  };
  const websiteIntelligence: WebsiteIntelligencePort = {
    runWebsiteIntelligence: async (params) => {
      if (params.website.includes("failing-co")) {
        throw new Error("Simulated real Website Intelligence crash for Failing Co (e.g. an unhandled provider exception).");
      }
      return {
        ...emptyWebsiteIntelligenceResult(),
        genericEmails: [{ email: "info@working-co.example", sourceUrl: "https://www.working-co.example/contact" }],
        pageTexts: [{ url: "https://www.working-co.example", text: "We are now hiring across our operations." }],
      };
    },
  };

  const { report, missionTaskId } = await run(tenantId, manufacturingPlan(), providers, websiteIntelligence);

  // La misión NUNCA aborta -- ambas Companies se crean (invariante #1).
  assert.equal(report.companiesCreated, 2, "ambas Companies deben crearse, incluso la que después falló en enrichment");
  assert.equal(report.createdCompanyIds.length, 2);

  // El error real de Failing Co queda registrado por candidato, nunca oculto.
  assert.equal(report.companyErrors.length, 1);
  assert.equal(report.companyErrors[0]!.candidateName, "Failing Manufacturing Co");
  assert.match(report.companyErrors[0]!.message, /Simulated real Website Intelligence crash/);
  assert.ok(report.companyErrors[0]!.companyId, "companyId debe estar presente -- la Company ya se había persistido antes del fallo");

  // Working Co sí llegó hasta el final -- Lead/Opportunity/Draft reales.
  assert.equal(report.leadsCreated, 1, "Working Co debe tener su Lead real (Failing Co no llegó tan lejos)");

  // Invariante #2: el AgentTask discover_companies SIEMPRE llega a un
  // estado terminal -- nunca queda huérfano en RUNNING (el bug real de
  // MIS-20260802-0002).
  const childTask = await prisma.agentTask.findFirstOrThrow({ where: { parentTaskId: missionTaskId, type: "discover_companies" } });
  assert.equal(childTask.status, "DONE");
  assert.ok(childTask.completedAt);

  // Invariante #8/#9: computeMissionProgress (usado por failMission/
  // closeMission/el reporte de la misión) refleja la realidad persistida,
  // nunca 0 solo porque una empresa falló después.
  const progress = await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: [] }, () => computeMissionProgress(missionTaskId));
  assert.equal(progress.companiesTargeted, 2);
  assert.equal(progress.leadsCreated, 1);

  const realCompanyCount = await prisma.company.count({ where: { id: { in: report.createdCompanyIds } } });
  assert.equal(realCompanyCount, 2, "ambas Company deben existir de verdad en la base");
});

test("invariante #1: un proveedor de discovery que lanza para UNA query no aborta el resto -- la otra query sigue corriendo, el error queda en queryExecutions", async () => {
  const tenantId = await setupTenant("query-provider-fails");
  const plan = manufacturingPlan({
    searchQueries: [
      { searchTerm: "manufacturing company", crmIndustryBucket: "Manufacturing", taxonomyKey: "manufacturing" },
      { searchTerm: "factory", crmIndustryBucket: "Manufacturing", taxonomyKey: "manufacturing" },
    ],
  });
  let call = 0;
  const providers: DiscoveryProviderPort = {
    searchGooglePlaces: async (params) => {
      call += 1;
      if (params.queryPhrase === "manufacturing company") {
        throw new Error("Simulated real network exception escaping the provider layer.");
      }
      return {
        candidates: [candidateFixture({ name: "Second Query Co", fields: { ...candidateFixture().fields, website: { status: "CONFIRMED", value: "https://www.second-query-co.example" } } })],
        costUsd: 0.032,
        sourcesUsed: ["Google Places (fixture)"],
        patternsFailed: [],
        cancelled: false,
      };
    },
    searchOverpass: async () => emptyResult(),
  };
  const websiteIntelligence: WebsiteIntelligencePort = {
    runWebsiteIntelligence: async () => ({
      ...emptyWebsiteIntelligenceResult(),
      genericEmails: [{ email: "info@second-query-co.example", sourceUrl: "https://www.second-query-co.example/contact" }],
    }),
  };

  const { report } = await run(tenantId, plan, providers, websiteIntelligence);

  assert.equal(call, 2, "ambas queries deben haberse intentado -- la primera falla nunca detiene el loop de queries");
  assert.equal(report.companiesCreated, 1, "la segunda query sí debe haber creado su Company real");
  const failedQuery = report.queryExecutions.find((q) => q.query === "manufacturing company");
  assert.ok(failedQuery);
  assert.match(failedQuery!.error ?? "", /Simulated real network exception/);
});

test("invariante #4: reanudar una misión (una 2da corrida de executeDiscoveryPlan con el mismo candidato real) nunca duplica la Company, el Lead ni el Draft ya persistidos", async () => {
  const tenantId = await setupTenant("resume-no-duplicates");
  const candidate = candidateFixture({
    name: "Resumable Manufacturing Co",
    fields: { ...candidateFixture().fields, website: { status: "CONFIRMED", value: "https://www.resumable-mfg.example" } },
  });
  const providers: DiscoveryProviderPort = {
    searchGooglePlaces: async () => ({
      candidates: [candidate],
      costUsd: 0.032,
      sourcesUsed: ["Google Places (fixture)"],
      patternsFailed: [],
      cancelled: false,
    }),
    searchOverpass: async () => emptyResult(),
  };
  const websiteIntelligence: WebsiteIntelligencePort = {
    runWebsiteIntelligence: async () => ({
      ...emptyWebsiteIntelligenceResult(),
      genericEmails: [{ email: "info@resumable-mfg.example", sourceUrl: "https://www.resumable-mfg.example/contact" }],
      pageTexts: [{ url: "https://www.resumable-mfg.example", text: "We are now hiring across our operations." }],
    }),
  };

  // 1ra corrida (ej. la misión original, que luego se interrumpió por
  // cualquier motivo real). Crea la Company/Lead/Opportunity/Draft reales.
  const first = await run(tenantId, manufacturingPlan(), providers, websiteIntelligence);
  assert.equal(first.report.companiesCreated, 1);
  assert.equal(first.report.leadsCreated, 1);

  // 2da corrida -- "resume" real: el mismo proveedor devuelve EL MISMO
  // candidato real (Google Places lo sigue indexando). deduplicateDiscoveryCandidates
  // se seedea con TODAS las Company reales del tenant (existingKeys, ver
  // mission-executor.ts) -- nunca depende de qué misión las creó, así
  // que debe reconocerla como ya existente y NO crear una segunda Company.
  const second = await run(tenantId, manufacturingPlan(), providers, websiteIntelligence);
  assert.equal(second.report.companiesCreated, 0, "la Company ya existe -- una reanudación nunca debe duplicarla");
  assert.equal(second.report.duplicatesAlreadyInCrm, 1);

  const realCompanies = await prisma.company.count({ where: { tenantId, name: "Resumable Manufacturing Co" } });
  assert.equal(realCompanies, 1, "nunca debe existir más de una Company real para el mismo negocio tras una reanudación");
  const realLeads = await prisma.lead.count({ where: { tenantId } });
  assert.equal(realLeads, 1, "nunca debe existir más de un Lead real para la misma Company tras una reanudación");
  const realApprovals = await prisma.approvalRequest.count({ where: { tenantId } });
  assert.equal(realApprovals, 1, "nunca debe existir más de un Draft/ApprovalRequest real para la misma Company tras una reanudación");
});
