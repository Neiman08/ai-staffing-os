import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { DEFAULT_MISSION_RESTRICTIONS, type MissionRestrictions } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../core/tenancy/context";
import type { MissionPlan } from "../ceo-intelligence/contracts";
import { resetProviderHealthForTests, getProviderHealth } from "./tools/provider-health";
import { emptyResult, type ProviderCandidate, type ProviderSearchResult } from "./tools/discovery-providers/types";
import { executeDiscoveryPlan, buildFinalQueries, type DiscoveryProviderPort } from "./mission-executor";
import { emptyWebsiteIntelligenceResult } from "./tools/website-intelligence/types";
import type { WebsiteIntelligencePort } from "./company-enrichment";
import type { ContactProviderPort } from "./contact-enrichment";
import { emptyContactResult } from "./tools/contact-providers/types";
import type { ContactCandidate } from "./tools/contact-providers/types";

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

// F7.4: este archivo prueba exclusivamente la mecánica de F7.3 (queries/
// dedup/límites/estados) — Website Intelligence siempre se inyecta vacía
// acá (cero red real, cero emails) a propósito; el comportamiento real
// de Business Validation/Email Trust tiene su propia batería dedicada en
// business-validation.test.ts/email-trust.test.ts/company-enrichment.test.ts.
const NO_OP_WEBSITE_INTELLIGENCE: WebsiteIntelligencePort = { runWebsiteIntelligence: async () => emptyWebsiteIntelligenceResult() };

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
        websiteIntelligence: NO_OP_WEBSITE_INTELLIGENCE,
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
    searchQueries: [{ searchTerm: "hotel", crmIndustryBucket: null, taxonomyKey: "hospitality" }],
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

// ---------- F7.5: Hiring Signal Intelligence wiring ----------

async function runWithHiring(
  tenantId: string,
  plan: MissionPlan,
  providers: DiscoveryProviderPort,
  websiteIntelligence: WebsiteIntelligencePort,
  targetJobTitles: string[] = [],
  decisionRoles: string[] = [],
  contactProvider?: ContactProviderPort,
) {
  return runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["missions.create"] }, async () => {
    const missionTask = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "daily_revenue_mission" } });
    const report = await executeDiscoveryPlan({
      missionTaskId: missionTask.id,
      plan,
      restrictions: DEFAULT_MISSION_RESTRICTIONS,
      providers,
      googlePlacesApiKey: "fake-key-for-tests",
      websiteIntelligence,
      targetJobTitles,
      decisionRoles,
      contactProvider,
      peopleDataLabsApiKey: contactProvider ? "fake-pdl-key-for-tests" : undefined,
    });
    createdCompanyIds.push(...report.createdCompanyIds);
    return report;
  });
}

function contactCandidateFixture(overrides: Partial<ContactCandidate> = {}): ContactCandidate {
  return {
    firstName: "Jane",
    lastName: "Doe",
    title: "HR Manager",
    fields: {
      firstName: { status: "CONFIRMED", value: "Jane" },
      lastName: { status: "CONFIRMED", value: "Doe" },
      title: { status: "CONFIRMED", value: "HR Manager" },
      linkedinUrl: { status: "NOT_FOUND", value: null },
      email: { status: "NOT_FOUND", value: null },
      phone: { status: "NOT_FOUND", value: null },
    },
    sourceUrl: null,
    ...overrides,
  };
}

test("hiring signals: nunca corre cuando el plan no declara find_hiring_signals", async () => {
  const tenantId = await setupTenant("hiring-not-requested");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const port: WebsiteIntelligencePort = {
    runWebsiteIntelligence: async () => ({ ...emptyWebsiteIntelligenceResult(), hasCareersPage: true, pageTexts: [{ url: "x", text: "now hiring Forklift Operator" }] }),
  };
  const report = await runWithHiring(tenantId, manufacturingPlan({ steps: ["discover_companies"] }), providers, port, ["Forklift Operator"]);
  assert.equal(report.hiringSignalsChecked, 0);
  assert.equal(report.companyValidations[0]!.hiringStatus, null);
});

test("hiring signals: CONFIRMED_HIRING se persiste en discoveryMetadata y en el reporte", async () => {
  const tenantId = await setupTenant("hiring-confirmed");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const port: WebsiteIntelligencePort = {
    runWebsiteIntelligence: async () => ({
      ...emptyWebsiteIntelligenceResult(),
      hasCareersPage: true,
      careersPageUrl: "https://acme-mfg.com/careers",
      pageTexts: [{ url: "https://acme-mfg.com/careers", text: "We are now hiring a Forklift Operator for our warehouse." }],
    }),
  };
  const plan = manufacturingPlan({ steps: ["discover_companies", "find_hiring_signals"], requiredSteps: ["discover_companies"], optionalSteps: ["find_hiring_signals"] });
  const report = await runWithHiring(tenantId, plan, providers, port, ["Forklift Operator"]);

  assert.equal(report.hiringSignalsChecked, 1);
  assert.equal(report.companiesConfirmedHiring, 1);
  assert.equal(report.companyValidations[0]!.hiringStatus, "CONFIRMED_HIRING");
  assert.deepEqual(report.companyValidations[0]!.targetTitlesMatched, ["Forklift Operator"]);

  const company = await prisma.company.findUniqueOrThrow({ where: { id: report.createdCompanyIds[0]! } });
  const metadata = company.discoveryMetadata as { hiringSignal?: { hiringStatus?: string } } | null;
  assert.equal(metadata?.hiringSignal?.hiringStatus, "CONFIRMED_HIRING");
});

test("hiring signals: NO_SIGNAL cuando no hay evidencia, nunca inventa una senal", async () => {
  const tenantId = await setupTenant("hiring-no-signal");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const port: WebsiteIntelligencePort = {
    runWebsiteIntelligence: async () => ({ ...emptyWebsiteIntelligenceResult(), pageTexts: [{ url: "https://acme-mfg.com", text: "We manufacture parts since 1990." }] }),
  };
  const plan = manufacturingPlan({ steps: ["discover_companies", "find_hiring_signals"], requiredSteps: ["discover_companies"], optionalSteps: ["find_hiring_signals"] });
  const report = await runWithHiring(tenantId, plan, providers, port, ["Forklift Operator"]);

  assert.equal(report.companiesNoHiringSignal, 1);
  assert.equal(report.companyValidations[0]!.hiringStatus, "NO_SIGNAL");
});

// ---------- F7.6: Decision-Maker Role Planning wiring ----------

test("role plan: nunca corre cuando el plan no declara find_contacts", async () => {
  const tenantId = await setupTenant("roleplan-not-requested");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const report = await runWithHiring(
    tenantId,
    manufacturingPlan({ steps: ["discover_companies"] }),
    providers,
    NO_OP_WEBSITE_INTELLIGENCE,
    [],
    ["HR Manager"],
  );
  assert.equal(report.rolePlansBuilt, 0);
  assert.equal(report.companyValidations[0]!.rolePlan, null);
});

test("role plan: se construye y persiste cuando el plan declara find_contacts", async () => {
  const tenantId = await setupTenant("roleplan-built");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const plan = manufacturingPlan({
    steps: ["discover_companies", "find_contacts"],
    requiredSteps: ["discover_companies"],
    optionalSteps: ["find_contacts"],
  });
  const report = await runWithHiring(tenantId, plan, providers, NO_OP_WEBSITE_INTELLIGENCE, [], ["HR Manager"]);

  assert.equal(report.rolePlansBuilt, 1);
  const rolePlan = report.companyValidations[0]!.rolePlan;
  assert.ok(rolePlan);
  assert.equal(rolePlan!.targetRoles[0]!.role, "HR Manager");
  assert.equal(rolePlan!.targetRoles[0]!.source, "intent");

  const company = await prisma.company.findUniqueOrThrow({ where: { id: report.createdCompanyIds[0]! } });
  const metadata = company.discoveryMetadata as { rolePlan?: { targetRoles?: unknown[] } } | null;
  assert.ok(metadata?.rolePlan);
  assert.equal((metadata!.rolePlan!.targetRoles as unknown[]).length, rolePlan!.targetRoles.length);
});

test("role plan: sin roles explicitos, usa los decisionMakers de la taxonomia real de manufacturing", async () => {
  const tenantId = await setupTenant("roleplan-taxonomy-default");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const plan = manufacturingPlan({
    steps: ["discover_companies", "find_contacts"],
    requiredSteps: ["discover_companies"],
    optionalSteps: ["find_contacts"],
  });
  const report = await runWithHiring(tenantId, plan, providers, NO_OP_WEBSITE_INTELLIGENCE);

  const rolePlan = report.companyValidations[0]!.rolePlan;
  assert.ok(rolePlan);
  assert.ok(rolePlan!.targetRoles.length > 0);
  assert.ok(rolePlan!.targetRoles.every((r) => r.source === "taxonomy"));
});

// ---------- F7.7: Contact Intelligence wiring ----------

function contactPlan(overrides: Partial<MissionPlan> = {}): MissionPlan {
  return manufacturingPlan({
    steps: ["discover_companies", "find_contacts"],
    requiredSteps: ["discover_companies"],
    optionalSteps: ["find_contacts"],
    ...overrides,
  });
}

test("contact intelligence: nunca llama al proveedor cuando rolePlan no tiene roles planificados", async () => {
  const tenantId = await setupTenant("contacts-no-roleplan");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  let called = false;
  const contactProvider: ContactProviderPort = {
    searchPeopleDataLabs: async () => {
      called = true;
      return emptyContactResult();
    },
  };
  // Plan sin find_contacts -> rolePlan queda null -> Contact Intelligence no corre.
  const report = await runWithHiring(tenantId, manufacturingPlan({ steps: ["discover_companies"] }), providers, NO_OP_WEBSITE_INTELLIGENCE, [], [], contactProvider);
  assert.equal(called, false);
  assert.equal(report.contactsCreatedTotal, 0);
  assert.equal(report.companyValidations[0]!.contactsFound, 0);
});

test("contact intelligence: crea un Contact real cuando PDL devuelve un candidato con nombre y rol matcheado", async () => {
  const tenantId = await setupTenant("contacts-created");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const contactProvider: ContactProviderPort = {
    searchPeopleDataLabs: async () => ({
      candidates: [contactCandidateFixture()],
      costUsd: 0.05,
      sourcesUsed: ["People Data Labs (test)"],
      patternsFailed: [],
      cancelled: false,
      providerStatus: "AVAILABLE",
    }),
  };
  const report = await runWithHiring(tenantId, contactPlan(), providers, NO_OP_WEBSITE_INTELLIGENCE, [], ["HR Manager"], contactProvider);

  assert.equal(report.contactsCreatedTotal, 1);
  assert.equal(report.companiesWithContactsFound, 1);
  assert.equal(report.companyValidations[0]!.contactsFound, 1);
  // El rolePlan real (F7.6) agrega también los decisionMakers de la
  // taxonomía de manufacturing además del rol explícito pedido -- solo
  // "HR Manager" tuvo un candidato real, el resto queda honestamente
  // sin contacto (nunca se inventa uno para completarlos).
  assert.ok(!report.companyValidations[0]!.rolesWithoutContact.includes("HR Manager"));
  assert.ok(report.costUsd >= 0.05);

  const contact = await prisma.contact.findFirstOrThrow({ where: { companyId: report.createdCompanyIds[0]! } });
  assert.equal(contact.firstName, "Jane");
  assert.equal(contact.lastName, "Doe");
  assert.equal(contact.source, "People Data Labs");
  assert.equal(contact.verificationStatus, "CONFIRMED");
});

test("contact intelligence: candidato sin apellido se descarta (insufficientDataSkipped), nunca crea Contact sin nombre real", async () => {
  const tenantId = await setupTenant("contacts-insufficient-data");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const contactProvider: ContactProviderPort = {
    searchPeopleDataLabs: async () => ({
      candidates: [contactCandidateFixture({ lastName: null })],
      costUsd: 0,
      sourcesUsed: [],
      patternsFailed: [],
      cancelled: false,
      providerStatus: "AVAILABLE",
    }),
  };
  const report = await runWithHiring(tenantId, contactPlan(), providers, NO_OP_WEBSITE_INTELLIGENCE, [], ["HR Manager"], contactProvider);
  assert.equal(report.contactsCreatedTotal, 0);
  // Ningún candidato con nombre real -> ningún rol planificado (incluido
  // "HR Manager") recibió contacto -- honesto, nunca se inventa uno.
  assert.ok(report.companyValidations[0]!.rolesWithoutContact.includes("HR Manager"));
});

test("contact intelligence: candidato con nombre pero rol irrelevante se descarta (roleMismatchSkipped), nunca se persiste fuera del rolePlan", async () => {
  const tenantId = await setupTenant("contacts-role-mismatch");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const contactProvider: ContactProviderPort = {
    searchPeopleDataLabs: async () => ({
      candidates: [contactCandidateFixture({ title: "Accounts Receivable Associate" })],
      costUsd: 0,
      sourcesUsed: [],
      patternsFailed: [],
      cancelled: false,
      providerStatus: "AVAILABLE",
    }),
  };
  const report = await runWithHiring(tenantId, contactPlan(), providers, NO_OP_WEBSITE_INTELLIGENCE, [], ["HR Manager"], contactProvider);
  assert.equal(report.contactsCreatedTotal, 0);
  assert.equal(report.contactRoleMismatchSkipped, 1);

  const contacts = await prisma.contact.count({ where: { companyId: report.createdCompanyIds[0]! } });
  assert.equal(contacts, 0);
});

test("contact intelligence: un contacto ya existente (mismo nombre+empresa) se deduplica, nunca se crea dos veces", async () => {
  const tenantId = await setupTenant("contacts-dedup");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const contactProvider: ContactProviderPort = {
    searchPeopleDataLabs: async () => ({
      candidates: [contactCandidateFixture()],
      costUsd: 0.05,
      sourcesUsed: ["People Data Labs (test)"],
      patternsFailed: [],
      cancelled: false,
      providerStatus: "AVAILABLE",
    }),
  };
  const report = await runWithHiring(tenantId, contactPlan(), providers, NO_OP_WEBSITE_INTELLIGENCE, [], ["HR Manager"], contactProvider);
  assert.equal(report.contactsCreatedTotal, 1);

  // Segunda misión, mismo tenant/Company no aplica (Company nueva cada
  // vez) -- se verifica la deduplicación directamente contra un Contact
  // ya presente en la MISMA Company creada arriba, simulando una
  // segunda corrida de Contact Intelligence sobre la misma Company.
  const contactEnrichment = await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["missions.create"] }, async () => {
    const { enrichCompanyWithDecisionContacts } = await import("./contact-enrichment");
    return enrichCompanyWithDecisionContacts({
      taskId: "fake-task-id",
      companyId: report.createdCompanyIds[0]!,
      companyName: "Acme Manufacturing",
      companyWebsite: null,
      companyState: "IL",
      companyCity: null,
      industryName: "Manufacturing",
      rolePlan: { companyId: report.createdCompanyIds[0]!, targetRoles: [{ role: "HR Manager", priority: 1, rationale: "test", source: "intent" }], excludedRoles: [], confidence: 0.9, taxonomySource: "test", hiringSignalSource: null, planVersion: 1 },
      contactProvider,
    });
  });
  assert.equal(contactEnrichment.duplicatesSkipped, 1);
  assert.equal(contactEnrichment.contactsCreated.length, 0);
});

// ---------- F7.9: propagación de cancelación entre pasos pagos ----------

test("cancelación durante Contact Intelligence (F7.7) detiene la misión de inmediato, nunca sigue gastando en el resto de candidatos", async () => {
  const tenantId = await setupTenant("cancel-during-contacts");
  const providers = fakeProviders({
    searchGooglePlaces: async () =>
      googleResult([
        candidateFixture({ name: "Acme Manufacturing", sourceUrl: "https://www.google.com/maps/place/?q=place_id:PLACE-1" }),
        candidateFixture({ name: "Zenith Manufacturing", sourceUrl: "https://www.google.com/maps/place/?q=place_id:PLACE-2" }),
      ]),
  });
  let contactProviderCalls = 0;
  const contactProvider: ContactProviderPort = {
    searchPeopleDataLabs: async () => {
      contactProviderCalls += 1;
      return { candidates: [], costUsd: 0, sourcesUsed: [], patternsFailed: ["cancelled by user"], cancelled: true, providerStatus: "AVAILABLE" };
    },
  };
  const report = await runWithHiring(tenantId, contactPlan(), providers, NO_OP_WEBSITE_INTELLIGENCE, [], ["HR Manager"], contactProvider);

  assert.equal(contactProviderCalls, 1, "nunca debe llamar al proveedor pago para el segundo candidato tras la cancelación del primero");
  assert.equal(report.missionState, "PARTIAL");
  assert.equal(report.stopReason, "cancelled");
  // La primera Company sí se persistió (evidencia real ya reunida antes
  // de la cancelación) y su registro parcial se reporta honestamente;
  // la segunda Company de la misma query nunca se procesa.
  assert.equal(report.createdCompanyIds.length, 1);
  assert.equal(report.companyValidations.length, 1);
});

test("reporte final integra las 10 piezas: intent -> plan -> discovery -> business validation -> email trust -> hiring signals -> role planning -> contact intelligence -> ranking -> reporte", async () => {
  const tenantId = await setupTenant("full-pipeline-report");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const contactProvider: ContactProviderPort = {
    searchPeopleDataLabs: async () => ({
      candidates: [contactCandidateFixture()],
      costUsd: 0.05,
      sourcesUsed: ["People Data Labs (test)"],
      patternsFailed: [],
      cancelled: false,
      providerStatus: "AVAILABLE",
    }),
  };
  const plan = manufacturingPlan({
    steps: ["discover_companies", "find_hiring_signals", "find_contacts"],
    requiredSteps: ["discover_companies"],
    optionalSteps: ["find_hiring_signals", "find_contacts"],
  });
  const port: WebsiteIntelligencePort = {
    runWebsiteIntelligence: async () => ({
      ...emptyWebsiteIntelligenceResult(),
      hasCareersPage: true,
      careersPageUrl: "https://acme-mfg.com/careers",
      pageTexts: [{ url: "https://acme-mfg.com/careers", text: "We are now hiring a Forklift Operator." }],
    }),
  };
  const report = await runWithHiring(tenantId, plan, providers, port, ["Forklift Operator"], ["HR Manager"], contactProvider);

  // (1)-(3) intent/plan/discovery: una Company real creada.
  assert.equal(report.companiesCreated, 1);
  // (4)-(5) business validation + email trust: siempre presentes.
  assert.ok(report.companyValidations[0]!.businessConfidence);
  // (6) hiring signals.
  assert.equal(report.companyValidations[0]!.hiringStatus, "CONFIRMED_HIRING");
  // (7) role planning.
  assert.ok(report.companyValidations[0]!.rolePlan);
  // (8) contact intelligence.
  assert.equal(report.companyValidations[0]!.contactsFound, 1);
  // (9) ranking: el contacto real creado tiene un tier -- verificado vía
  // el agregado del reporte final (10), nunca 0 cuando sí se creó un contacto.
  const totalRanked = report.contactsHighConfidence + report.contactsMediumConfidence + report.contactsLowConfidence + report.contactsRejected;
  assert.equal(totalRanked, 1);
});
