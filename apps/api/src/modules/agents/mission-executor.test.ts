import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { DEFAULT_MISSION_RESTRICTIONS, type MissionRestrictions } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../core/tenancy/context";
import type { MissionPlan } from "../ceo-intelligence/contracts";
import { resetProviderHealthForTests, getProviderHealth } from "./tools/provider-health";
import { emptyResult, type ProviderCandidate, type ProviderSearchResult } from "./tools/discovery-providers/types";
import { executeDiscoveryPlan, buildFinalQueries, type DiscoveryProviderPort } from "./mission-executor";

/**
 * F7.3: tests del ejecutor real de descubrimiento. Cero llamadas
 * externas — searchGooglePlaces/searchOverpass siempre se inyectan como
 * fakes vía el parámetro `providers` (nunca se importan los módulos
 * reales acá). Guardia extra: se sobreescribe global.fetch para que
 * cualquier intento accidental de red real explote el test en vez de
 * silenciosamente pegarle a internet.
 */

const originalFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("mission-executor.test.ts: intento de llamada de red real — los proveedores deben inyectarse mockeados.");
}) as typeof fetch;

const TEST_PREFIX = "F73-EXEC-TEST";
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
      input: {},
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

// ---------- fixtures ----------

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

function manufacturingPlan(overrides: Partial<MissionPlan> = {}): MissionPlan {
  return {
    schemaVersion: 1,
    objective: { type: "find_companies", targetCompanyCount: 5, rawText: "5 empresas de manufactura" },
    searchQueries: [{ searchTerm: "manufacturing company", crmIndustryBucket: "Manufacturing", taxonomyKey: "manufacturing" }],
    exclusions: [],
    cities: [],
    states: ["IL"],
    steps: ["discover_companies"],
    requiredSteps: ["discover_companies"],
    optionalSteps: [],
    stopConditions: { maxCompanies: 5, maxCostUsd: 3, maxDurationMinutes: 60 },
    dedupStrategy: ["providerPlaceId", "canonicalDomain", "normalizedPhone", "normalizedNameCityState"],
    fallbackStrategy: [{ provider: "Google Places", whenUnavailable: "Usar Overpass." }],
    restrictions: DEFAULT_MISSION_RESTRICTIONS,
    rationale: "fixture",
    ...overrides,
  };
}

function fakeProviders(overrides: Partial<DiscoveryProviderPort> = {}): DiscoveryProviderPort {
  return {
    searchGooglePlaces: async () => emptyResult(),
    searchOverpass: async () => emptyResult(),
    ...overrides,
  };
}

function googleResult(candidates: ProviderCandidate[], extra: Partial<ProviderSearchResult> = {}): ProviderSearchResult {
  return { candidates, costUsd: 0.032, sourcesUsed: ["Google Places (fixture)"], patternsFailed: [], cancelled: false, ...extra };
}

async function run(tenantId: string, plan: MissionPlan, providers: DiscoveryProviderPort, restrictions: MissionRestrictions = DEFAULT_MISSION_RESTRICTIONS) {
  return runWithTenancyContext(
    { tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["missions.create"] },
    async () => {
      const missionTask = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "daily_revenue_mission" } });
      const report = await executeDiscoveryPlan({
        missionTaskId: missionTask.id,
        plan,
        restrictions,
        providers,
        googlePlacesApiKey: "fake-key-for-tests",
      });
      createdCompanyIds.push(...report.createdCompanyIds);
      return report;
    },
  );
}

// ---------- buildFinalQueries (unidad, sin Prisma) ----------

test("buildFinalQueries: colapsa queries duplicadas (mismo termino normalizado)", () => {
  const plan = manufacturingPlan({
    searchQueries: [
      { searchTerm: "Manufacturing Company", crmIndustryBucket: "Manufacturing", taxonomyKey: "manufacturing" },
      { searchTerm: "manufacturing company", crmIndustryBucket: "Manufacturing", taxonomyKey: "manufacturing" },
    ],
  });
  const queries = buildFinalQueries(plan, "IL");
  assert.equal(queries.length, 1);
});

test("buildFinalQueries: multiplica por ciudad — 1 query x 2 ciudades = 2 ejecuciones distintas", () => {
  const plan = manufacturingPlan({ cities: ["Chicago", "Aurora"] });
  const queries = buildFinalQueries(plan, "IL");
  assert.equal(queries.length, 2);
  assert.deepEqual(queries.map((q) => q.city).sort(), ["Aurora", "Chicago"]);
});

test("buildFinalQueries: descarta una query que es exclusivamente un termino de exclusion", () => {
  const plan = manufacturingPlan({
    searchQueries: [
      { searchTerm: "manufacturing company", crmIndustryBucket: "Manufacturing", taxonomyKey: "manufacturing" },
      { searchTerm: "staffing agency", crmIndustryBucket: "Manufacturing", taxonomyKey: "manufacturing" },
    ],
    exclusions: ["staffing agency"],
  });
  const queries = buildFinalQueries(plan, "IL");
  assert.equal(queries.length, 1);
  assert.equal(queries[0]!.searchTerm, "manufacturing company");
});

// ---------- ejecución real (Prisma + providers mockeados) ----------

test("query ejecutada una sola vez: 1 query planificada -> 1 queryExecution, cuenta cruda/aceptada correctas", async () => {
  const tenantId = await setupTenant("single-query");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const report = await run(tenantId, manufacturingPlan(), providers);

  assert.equal(report.queriesExecuted, 1);
  assert.equal(report.rawResults, 1);
  assert.equal(report.acceptedResults, 1);
  assert.equal(report.companiesCreated, 1);
  assert.equal(report.missionState, "PARTIAL"); // 1 de 5 pedidas
});

test("limite global: pide 2, el proveedor devuelve 5 -> solo se crean 2, stopReason limit_reached, missionState COMPLETED", async () => {
  const tenantId = await setupTenant("global-limit");
  const candidates = Array.from({ length: 5 }, (_, i) =>
    candidateFixture({
      name: `Acme ${i}`,
      sourceUrl: `https://www.google.com/maps/place/?q=place_id:P${i}`,
      fields: {
        ...candidateFixture().fields,
        website: { status: "CONFIRMED", value: `https://www.acme-${i}.com` },
        phone: { status: "CONFIRMED", value: `(312) 555-010${i}` },
      },
    }),
  );
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult(candidates) });
  const report = await run(tenantId, manufacturingPlan({ stopConditions: { maxCompanies: 2, maxCostUsd: 3, maxDurationMinutes: 60 } }), providers);

  assert.equal(report.companiesCreated, 2);
  assert.equal(report.stopReason, "limit_reached");
  assert.equal(report.missionState, "COMPLETED");
});

test("proveedor primario falla (402) -> se marca CREDIT_EXHAUSTED y se usa Overpass como respaldo", async () => {
  const tenantId = await setupTenant("provider-fallback");
  const providers: DiscoveryProviderPort = {
    searchGooglePlaces: async () => ({ candidates: [], costUsd: 0.032, sourcesUsed: [], patternsFailed: ["manufacturing company:google_places_text_search (HTTP 402: no credits)"], cancelled: false }),
    searchOverpass: async () => ({ candidates: [candidateFixture({ name: "Overpass Fallback Co" })], costUsd: 0, sourcesUsed: ["OpenStreetMap Overpass"], patternsFailed: [], cancelled: false }),
  };
  const report = await run(tenantId, manufacturingPlan(), providers);

  assert.equal(report.companiesCreated, 1);
  assert.ok(report.providersUsed.includes("OpenStreetMap Overpass"));
  const health = getProviderHealth("google_places_text_search");
  assert.equal(health?.status, "CREDIT_EXHAUSTED");
});

test("todos los proveedores sin resultados -> NO_RESULTS, nunca COMPLETED con 0 empresas", async () => {
  const tenantId = await setupTenant("no-results");
  const report = await run(tenantId, manufacturingPlan(), fakeProviders());
  assert.equal(report.companiesCreated, 0);
  assert.equal(report.missionState, "NO_RESULTS");
  assert.notEqual(report.missionState, "COMPLETED");
});

test("BLOCKED: plan sin ningun estado soportado", async () => {
  const tenantId = await setupTenant("blocked-no-state");
  const report = await run(tenantId, manufacturingPlan({ states: [] }), fakeProviders());
  assert.equal(report.missionState, "BLOCKED");
  assert.equal(report.companiesCreated, 0);
});

test("BLOCKED: plan sin ninguna query de descubrimiento", async () => {
  const tenantId = await setupTenant("blocked-no-queries");
  const report = await run(tenantId, manufacturingPlan({ searchQueries: [], steps: [] }), fakeProviders());
  assert.equal(report.missionState, "BLOCKED");
});

test("dedup: mismo providerPlaceId dentro de la misma query -> 1 unica Company creada", async () => {
  const tenantId = await setupTenant("dedup-placeid");
  const dup = [candidateFixture(), candidateFixture({ name: "Acme Manufacturing (variante)" })]; // mismo sourceUrl/place_id
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult(dup) });
  const report = await run(tenantId, manufacturingPlan(), providers);
  assert.equal(report.companiesCreated, 1);
  assert.equal(report.duplicatesWithinMission, 1);
});

test("dedup: candidato coincide con una Company ya existente en el CRM (mismo dominio) -> no se crea de nuevo", async () => {
  const tenantId = await setupTenant("dedup-existing");
  const industry = await prisma.industry.findFirstOrThrow({ where: { name: "Manufacturing" } });
  const existing = await runWithTenancyContext({ tenantId, userId: "setup", permissions: [] }, () =>
    prisma.company.create({ data: { tenantId, name: "Already Here Inc", industryId: industry.id, status: "LEAD", website: "https://www.acme-mfg.com" } }),
  );
  createdCompanyIds.push(existing.id);

  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const report = await run(tenantId, manufacturingPlan(), providers);
  assert.equal(report.companiesCreated, 0);
  assert.equal(report.duplicatesAlreadyInCrm, 1);
});

test("Prairie Manufacturing Co. (DEMO_SEED) nunca se re-crea como descubrimiento nuevo", async () => {
  const tenantId = await setupTenant("demo-seed-exclusion");
  const industry = await prisma.industry.findFirstOrThrow({ where: { name: "Manufacturing" } });
  const demo = await runWithTenancyContext({ tenantId, userId: "setup", permissions: [] }, () =>
    prisma.company.create({
      data: { tenantId, name: "Prairie Manufacturing Co.", industryId: industry.id, status: "LEAD", origin: "DEMO_SEED", city: "Chicago", state: "IL" },
    }),
  );
  createdCompanyIds.push(demo.id);

  const providers = fakeProviders({
    searchGooglePlaces: async () => googleResult([candidateFixture({ name: "Prairie Manufacturing Co.", fields: { ...candidateFixture().fields, website: { status: "NOT_FOUND", value: null } } })]),
  });
  const report = await run(tenantId, manufacturingPlan(), providers);
  assert.equal(report.companiesCreated, 0, "un candidato con el mismo nombre+ciudad+estado que un DEMO_SEED nunca debe crearse como nuevo");
  assert.equal(report.duplicatesAlreadyInCrm, 1);
});

test("Discovery en F7.3 crea Company, pero nunca Lead/Opportunity/Campaign/Contact/CompanyContactPoint", async () => {
  const tenantId = await setupTenant("no-lead-side-effects");
  const [leadsBefore, oppsBefore, campaignsBefore, contactsBefore, pointsBefore] = await Promise.all([
    prisma.lead.count({ where: { tenantId } }),
    prisma.opportunity.count({ where: { tenantId } }),
    prisma.campaign.count({ where: { tenantId } }),
    prisma.contact.count({ where: { tenantId } }),
    prisma.companyContactPoint.count({ where: { tenantId } }),
  ]);

  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const report = await run(tenantId, manufacturingPlan(), providers);
  assert.equal(report.companiesCreated, 1);

  const [leadsAfter, oppsAfter, campaignsAfter, contactsAfter, pointsAfter] = await Promise.all([
    prisma.lead.count({ where: { tenantId } }),
    prisma.opportunity.count({ where: { tenantId } }),
    prisma.campaign.count({ where: { tenantId } }),
    prisma.contact.count({ where: { tenantId } }),
    prisma.companyContactPoint.count({ where: { tenantId } }),
  ]);
  assert.equal(leadsAfter, leadsBefore);
  assert.equal(oppsAfter, oppsBefore);
  assert.equal(campaignsAfter, campaignsBefore);
  assert.equal(contactsAfter, contactsBefore);
  assert.equal(pointsAfter, pointsBefore);
});

test("categoria sin bucket de Industry real (hospitality): se ejecuta la query por honestidad de costo, pero se rechaza sin persistir", async () => {
  const tenantId = await setupTenant("no-bucket");
  const hotelPlan = manufacturingPlan({
    searchQueries: [{ searchTerm: "hotel", crmIndustryBucket: null, taxonomyKey: "hotel" }],
  });
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture({ name: "Grand Hotel Chicago" })]) });
  const report = await run(tenantId, hotelPlan, providers);

  assert.equal(report.companiesCreated, 0);
  assert.equal(report.queriesExecuted, 1, "la query se ejecuta igual, por honestidad de costo/conteo");
  assert.equal(report.rejectedResults, 1);
  assert.ok(report.rejectedCandidates[0]!.reason.includes("bucket"));
});

test("restricciones: no crear campañas ni oportunidades sigue documentado en restrictionsApplied, y nunca se crea ninguna de las dos igualmente", async () => {
  const tenantId = await setupTenant("restrictions-applied");
  const restrictions: MissionRestrictions = { ...DEFAULT_MISSION_RESTRICTIONS, allowCampaignCreation: false, allowOpportunityCreation: false };
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const report = await run(tenantId, manufacturingPlan(), providers, restrictions);

  assert.ok(report.restrictionsApplied.some((n) => n.includes("Campaign")));
  assert.ok(report.restrictionsApplied.some((n) => n.includes("Opportunities") || n.includes("Opportunity")));
  const [campaigns, opportunities] = await Promise.all([
    prisma.campaign.count({ where: { tenantId } }),
    prisma.opportunity.count({ where: { tenantId } }),
  ]);
  assert.equal(campaigns, 0);
  assert.equal(opportunities, 0);
});

test("tenancy: las Companies creadas en un tenant no son visibles desde otro", async () => {
  const tenantA = await setupTenant("tenancy-a");
  const tenantB = await setupTenant("tenancy-b");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  await run(tenantA, manufacturingPlan(), providers);

  const visibleFromB = await runWithTenancyContext({ tenantId: tenantB, userId: "u", permissions: [] }, () =>
    prisma.company.findMany({ where: { tenantId: tenantB, name: "Acme Manufacturing" } }),
  );
  assert.equal(visibleFromB.length, 0);
});
