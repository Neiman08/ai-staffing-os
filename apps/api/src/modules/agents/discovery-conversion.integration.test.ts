import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { DEFAULT_MISSION_RESTRICTIONS, type MissionRestrictions } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../core/tenancy/context";
import type { MissionPlan } from "../ceo-intelligence/contracts";
import { resetProviderHealthForTests } from "./tools/provider-health";
import { emptyResult, type ProviderCandidate, type ProviderSearchResult } from "./tools/discovery-providers/types";
import { executeDiscoveryPlan, type DiscoveryProviderPort } from "./mission-executor";
import { emptyWebsiteIntelligenceResult } from "./tools/website-intelligence/types";
import type { WebsiteIntelligencePort } from "./company-enrichment";
import type { ContactProviderPort } from "./contact-enrichment";
import type { ContactCandidate } from "./tools/contact-providers/types";

/**
 * F14: los 9 escenarios de validación pedidos explícitamente por el PO
 * tras el hallazgo real de "0 leads/0 opportunities" en una misión con
 * 15 empresas reales descubiertas. Cada test corre executeDiscoveryPlan
 * con `convertToCommercialActions: true` (el flag opt-in que activa la
 * conversión real, ver el comentario en ExecuteDiscoveryPlanParams) y
 * verifica tanto el reporte estructurado como el estado real en la base
 * (Lead/Opportunity/ApprovalRequest/Contact) -- nunca solo el reporte,
 * para atrapar cualquier divergencia entre lo que se cuenta y lo que
 * realmente se persiste. Cero llamadas externas -- mismo patrón de
 * fetch-guardado que mission-executor.test.ts.
 */

const originalFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("discovery-conversion.integration.test.ts: intento de llamada de red real — los proveedores deben inyectarse mockeados.");
}) as typeof fetch;

const TEST_PREFIX = "F14-CONV-TEST";
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

// ---------- fixtures (mismos criterios que mission-executor.test.ts) ----------

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
    objective: { type: "find_companies", targetCompanyCount: 1, rawText: "1 empresa de manufactura" },
    searchQueries: [{ searchTerm: "manufacturing company", crmIndustryBucket: "Manufacturing", taxonomyKey: "manufacturing" }],
    exclusions: [],
    cities: [],
    states: ["IL"],
    steps: ["discover_companies", "find_hiring_signals"],
    requiredSteps: ["discover_companies"],
    optionalSteps: ["find_hiring_signals", "find_contacts"],
    stopConditions: { maxCompanies: 1, maxCostUsd: 3, maxDurationMinutes: 60 },
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
      email: { status: "CONFIRMED", value: "jane.doe@acme-mfg.com" },
      phone: { status: "NOT_FOUND", value: null },
    },
    sourceUrl: null,
    ...overrides,
  };
}

// pageText con una frase de contratación genérica pero SIN careers page
// dedicada y SIN mención de un título específico -> POSSIBLE_HIRING
// (hiring-signals.ts: genericPhraseMatched=true, hasCareersPage=false).
const POSSIBLE_HIRING_PAGE = { url: "https://www.acme-mfg.com", text: "We are now hiring across our Chicago operations." };

function websiteIntelligenceWithEmail(email: string | null, extra: Partial<ReturnType<typeof emptyWebsiteIntelligenceResult>> = {}): WebsiteIntelligencePort {
  return {
    runWebsiteIntelligence: async () => ({
      ...emptyWebsiteIntelligenceResult(),
      genericEmails: email ? [{ email, sourceUrl: "https://www.acme-mfg.com/contact" }] : [],
      pageTexts: [POSSIBLE_HIRING_PAGE],
      ...extra,
    }),
  };
}

async function run(
  tenantId: string,
  plan: MissionPlan,
  providers: DiscoveryProviderPort,
  websiteIntelligence: WebsiteIntelligencePort,
  opts: { restrictions?: MissionRestrictions; contactProvider?: ContactProviderPort; targetJobTitles?: string[]; decisionRoles?: string[] } = {},
) {
  return runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["missions.create"] }, async () => {
    const missionTask = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "daily_revenue_mission" } });
    const report = await executeDiscoveryPlan({
      missionTaskId: missionTask.id,
      plan,
      restrictions: opts.restrictions ?? DEFAULT_MISSION_RESTRICTIONS,
      providers,
      googlePlacesApiKey: "fake-key-for-tests",
      websiteIntelligence,
      targetJobTitles: opts.targetJobTitles ?? [],
      decisionRoles: opts.decisionRoles ?? [],
      contactProvider: opts.contactProvider,
      peopleDataLabsApiKey: opts.contactProvider ? "fake-pdl-key-for-tests" : undefined,
      convertToCommercialActions: true,
    });
    createdCompanyIds.push(...report.createdCompanyIds);
    return report;
  });
}

// ---------- 1. EXACT + Possible Hiring + email verificado -> Company + Lead + Opportunity en revisión + Draft ----------

test("escenario 1: EXACT + Possible Hiring + email verificado crea Company, Lead, Opportunity REVIEW_REQUIRED y Draft", async () => {
  const tenantId = await setupTenant("scenario-1");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const websiteIntelligence = websiteIntelligenceWithEmail("info@acme-mfg.com");
  const report = await run(tenantId, manufacturingPlan(), providers, websiteIntelligence);

  assert.equal(report.companiesCreated, 1);
  assert.equal(report.leadsCreated, 1);
  assert.equal(report.opportunitiesCreated, 1);
  assert.equal(report.draftsCreated, 1);

  const validation = report.companyValidations[0]!;
  assert.equal(validation.businessConfidence, "EXACT");
  assert.equal(validation.hiringStatus, "POSSIBLE_HIRING");
  assert.ok(validation.conversion);
  assert.equal(validation.conversion!.decision.rule, "EXACT_POSSIBLE_HIRING_WITH_EVIDENCE");
  assert.equal(validation.conversion!.decision.opportunityReviewRequired, true);

  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: validation.conversion!.leadId! } });
  assert.equal(lead.companyId, report.createdCompanyIds[0]);

  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id: validation.conversion!.opportunityId! } });
  assert.equal(opportunity.reviewRequired, true);
  assert.equal(opportunity.conversionRule, "EXACT_POSSIBLE_HIRING_WITH_EVIDENCE");

  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: validation.conversion!.approvalRequestId! } });
  assert.equal(approval.status, "PENDING");
  const proposedAction = approval.proposedAction as { to?: string; subject?: string; body?: string };
  assert.equal(proposedAction.to, "info@acme-mfg.com");
  assert.ok(proposedAction.subject);
  assert.ok(proposedAction.body);
});

// ---------- 2. EXACT + Possible Hiring + teléfono, sin email -> Lead + Opportunity, sin Draft ----------

test("escenario 2: EXACT + Possible Hiring + teléfono confirmado pero sin email crea Lead y Opportunity, nunca un Draft", async () => {
  const tenantId = await setupTenant("scenario-2");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const websiteIntelligence = websiteIntelligenceWithEmail(null); // sin ningún email genérico
  const report = await run(tenantId, manufacturingPlan(), providers, websiteIntelligence);

  assert.equal(report.companiesCreated, 1);
  assert.equal(report.leadsCreated, 1);
  assert.equal(report.opportunitiesCreated, 1);
  assert.equal(report.draftsCreated, 0);

  const validation = report.companyValidations[0]!;
  assert.equal(validation.conversion!.decision.createOpportunity, true);
  assert.equal(validation.conversion!.draftCreated, false);
  assert.equal(validation.conversion!.draftEligibility?.eligible, false);

  const opportunities = await prisma.opportunity.count({ where: { tenantId } });
  assert.equal(opportunities, 1);
  const approvals = await prisma.approvalRequest.count({ where: { tenantId } });
  assert.equal(approvals, 0);
});

// ---------- 3. APPROXIMATE + Possible Hiring -> Lead de investigación, Opportunity condicionada a revisión manual ----------

test("escenario 3: APPROXIMATE + Possible Hiring crea un Lead de investigación y una Opportunity condicionada a revisión manual", async () => {
  const tenantId = await setupTenant("scenario-3");
  // Nombre sin "manufactur*"/"factory"/etc y sin dominio que matchee
  // companyTypes -- searchTerm del plan ("manufacturing company") sí
  // coincide con googleSearchPhrases de la taxonomía -> APPROXIMATE
  // (business-validation.ts: nameMatches/domainMatches/description
  // vacíos, pero searchTermMatchesTaxonomyQuery true).
  const candidate = candidateFixture({
    name: "Zenith Industries LLC",
    fields: { ...candidateFixture().fields, website: { status: "CONFIRMED", value: "https://www.zenith-corp.com" } },
  });
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidate]) });
  const websiteIntelligence = websiteIntelligenceWithEmail("info@zenith-corp.com");
  const report = await run(tenantId, manufacturingPlan(), providers, websiteIntelligence);

  assert.equal(report.companiesCreated, 1);
  const validation = report.companyValidations[0]!;
  assert.equal(validation.businessConfidence, "APPROXIMATE");
  assert.equal(validation.hiringStatus, "POSSIBLE_HIRING");
  assert.equal(validation.conversion!.decision.rule, "APPROXIMATE_SIGNAL_WITH_EVIDENCE");
  assert.equal(validation.conversion!.decision.createLead, true);
  assert.equal(validation.conversion!.decision.createOpportunity, true);
  assert.equal(validation.conversion!.decision.opportunityReviewRequired, true);

  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id: validation.conversion!.opportunityId! } });
  assert.equal(opportunity.reviewRequired, true);
});

// ---------- 4. No Signal nunca genera Opportunity automática ----------

test("escenario 4: No Signal (sin evidencia de contratación) nunca crea una Opportunity automática, pero conserva el Lead de investigación", async () => {
  const tenantId = await setupTenant("scenario-4");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const websiteIntelligence: WebsiteIntelligencePort = {
    runWebsiteIntelligence: async () => ({
      ...emptyWebsiteIntelligenceResult(),
      genericEmails: [{ email: "info@acme-mfg.com", sourceUrl: "https://www.acme-mfg.com" }],
      pageTexts: [{ url: "https://www.acme-mfg.com", text: "We manufacture precision parts since 1990." }],
    }),
  };
  const report = await run(tenantId, manufacturingPlan(), providers, websiteIntelligence);

  const validation = report.companyValidations[0]!;
  assert.equal(validation.hiringStatus, "NO_SIGNAL");
  assert.equal(validation.conversion!.decision.rule, "NO_SIGNAL_LEAD_ONLY");
  assert.equal(validation.conversion!.decision.createLead, true);
  assert.equal(validation.conversion!.decision.createOpportunity, false);
  assert.equal(report.opportunitiesCreated, 0);
  assert.equal(report.leadsCreated, 1);

  const opportunities = await prisma.opportunity.count({ where: { tenantId } });
  assert.equal(opportunities, 0);
});

// ---------- 5. Blocked / identidad dudosa -> nunca Lead ni Opportunity ----------

test("escenario 5: hiringStatus BLOCKED (sin website confirmado) nunca crea Lead ni Opportunity", async () => {
  const tenantId = await setupTenant("scenario-5-blocked");
  const candidate = candidateFixture({ fields: { ...candidateFixture().fields, website: { status: "NOT_FOUND", value: null } } });
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidate]) });
  const report = await run(tenantId, manufacturingPlan(), providers, { runWebsiteIntelligence: async () => emptyWebsiteIntelligenceResult() });

  const validation = report.companyValidations[0]!;
  assert.equal(validation.hiringStatus, "BLOCKED");
  assert.equal(validation.conversion!.decision.rule, "BLOCKED_OR_DUBIOUS_IDENTITY");
  assert.equal(validation.conversion!.decision.createLead, false);
  assert.equal(validation.conversion!.decision.createOpportunity, false);
  assert.equal(report.leadsCreated, 0);
  assert.equal(report.opportunitiesCreated, 0);
});

test("escenario 5b: identidad de negocio dudosa (WEAK) nunca crea Lead ni Opportunity aunque haya canal real", async () => {
  const tenantId = await setupTenant("scenario-5-weak");
  // searchTerm distinto de los googleSearchPhrases de la taxonomía y
  // nombre/dominio que no matchean companyTypes -> WEAK (ningún branch
  // de confidence en business-validation.ts aplica salvo el default).
  const candidate = candidateFixture({ name: "Generic Holdings Inc", fields: { ...candidateFixture().fields, website: { status: "CONFIRMED", value: "https://www.genericholdings.com" } } });
  const plan = manufacturingPlan({ searchQueries: [{ searchTerm: "generic business search term", crmIndustryBucket: "Manufacturing", taxonomyKey: "manufacturing" }] });
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidate]) });
  const websiteIntelligence = websiteIntelligenceWithEmail("info@genericholdings.com");
  const report = await run(tenantId, plan, providers, websiteIntelligence);

  const validation = report.companyValidations[0]!;
  assert.equal(validation.businessConfidence, "WEAK");
  assert.equal(validation.conversion!.decision.rule, "BLOCKED_OR_DUBIOUS_IDENTITY");
  assert.equal(report.leadsCreated, 0);
  assert.equal(report.opportunitiesCreated, 0);
});

// ---------- 6. PDL 402, pero Hunter/Website Intelligence encuentra un email válido -> el flujo continúa ----------

test("escenario 6: PDL devuelve 402 (CREDIT_EXHAUSTED) pero el email organizacional verificado igual permite Lead + Opportunity + Draft", async () => {
  const tenantId = await setupTenant("scenario-6-pdl-402");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const websiteIntelligence = websiteIntelligenceWithEmail("info@acme-mfg.com");
  const contactProvider: ContactProviderPort = {
    searchPeopleDataLabs: async () => ({
      candidates: [],
      costUsd: 0,
      sourcesUsed: [],
      patternsFailed: ["HR Manager:people_data_labs (HTTP 402: no credits)"],
      cancelled: false,
      providerStatus: "CREDIT_EXHAUSTED",
    }),
  };
  const plan = manufacturingPlan({
    steps: ["discover_companies", "find_hiring_signals", "find_contacts"],
    optionalSteps: ["find_hiring_signals", "find_contacts"],
  });
  const report = await run(tenantId, plan, providers, websiteIntelligence, { contactProvider, decisionRoles: ["HR Manager"] });

  // PDL nunca encontró un contacto real (402), pero el resto del flujo
  // -- incluida la conversión F14 -- nunca se bloquea por eso.
  assert.equal(report.contactsCreatedTotal, 0);
  assert.equal(report.companiesCreated, 1);
  assert.equal(report.leadsCreated, 1);
  assert.equal(report.opportunitiesCreated, 1);
  assert.equal(report.draftsCreated, 1);

  const validation = report.companyValidations[0]!;
  assert.equal(validation.conversion!.decision.createOpportunity, true);
  assert.equal(validation.conversion!.draftCreated, true);
  // El borrador usó el email organizacional (Website Intelligence),
  // nunca un contacto de PDL -- PDL no aportó nada en este escenario.
  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: validation.conversion!.approvalRequestId! } });
  const proposedAction = approval.proposedAction as { to?: string; contactId?: string | null };
  assert.equal(proposedAction.to, "info@acme-mfg.com");
  assert.equal(proposedAction.contactId, null);
});

// ---------- 7. La misión autoriza opportunities/mensajes -> nunca se detiene tras discover_companies ----------

test("escenario 7: con opportunities y outreach autorizados, la conversión corre y no se detiene en el discovery puro", async () => {
  const tenantId = await setupTenant("scenario-7-continues");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const websiteIntelligence = websiteIntelligenceWithEmail("info@acme-mfg.com");
  const restrictions: MissionRestrictions = { ...DEFAULT_MISSION_RESTRICTIONS, allowOpportunityCreation: true, allowOutreach: true, allowMessageSending: true };
  const report = await run(tenantId, manufacturingPlan(), providers, websiteIntelligence, { restrictions });

  // Nunca se queda solo en discovery -- Lead, Opportunity y Draft real
  // se crean en la MISMA corrida de executeDiscoveryPlan, exactamente
  // el bug reportado por el PO (0 leads/0 opportunities pese a que la
  // misión autorizaba estas acciones).
  assert.equal(report.companiesCreated, 1);
  assert.equal(report.leadsCreated, 1);
  assert.equal(report.opportunitiesCreated, 1);
  assert.equal(report.draftsCreated, 1);
  assert.ok(!report.restrictionsApplied.some((n) => n.toLowerCase().includes("no se crea ninguna lead")));
});

test("escenario 7b: restricción explícita allowOpportunityCreation=false SÍ bloquea la Opportunity (y por lo tanto el Draft), pero el Lead se crea igual", async () => {
  const tenantId = await setupTenant("scenario-7b-restricted");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const websiteIntelligence = websiteIntelligenceWithEmail("info@acme-mfg.com");
  const restrictions: MissionRestrictions = { ...DEFAULT_MISSION_RESTRICTIONS, allowOpportunityCreation: false };
  const report = await run(tenantId, manufacturingPlan(), providers, websiteIntelligence, { restrictions });

  assert.equal(report.leadsCreated, 1);
  assert.equal(report.opportunitiesCreated, 0);
  assert.equal(report.opportunitiesBlockedByRestriction, 1);
  assert.equal(report.draftsCreated, 0);

  const validation = report.companyValidations[0]!;
  assert.equal(validation.conversion!.opportunityBlockedByRestriction, true);
  const opportunities = await prisma.opportunity.count({ where: { tenantId } });
  assert.equal(opportunities, 0);
});

// ---------- 8. Nunca se crea un contacto personal sin nombre real y evidencia ----------

test("escenario 8: sin ningún candidato de PDL con nombre real, nunca se crea un Contact -- el email organizacional sigue siendo el único canal", async () => {
  const tenantId = await setupTenant("scenario-8-no-fake-contact");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const websiteIntelligence = websiteIntelligenceWithEmail("info@acme-mfg.com");
  const contactProvider: ContactProviderPort = {
    // PDL devuelve un candidato sin apellido -- contact-enrichment.ts ya
    // descarta esto (insufficientDataSkipped), nunca inventa un apellido
    // para completarlo.
    searchPeopleDataLabs: async () => ({
      candidates: [contactCandidateFixture({ lastName: null })],
      costUsd: 0,
      sourcesUsed: [],
      patternsFailed: [],
      cancelled: false,
      providerStatus: "AVAILABLE",
    }),
  };
  const plan = manufacturingPlan({
    steps: ["discover_companies", "find_hiring_signals", "find_contacts"],
    optionalSteps: ["find_hiring_signals", "find_contacts"],
  });
  const report = await run(tenantId, plan, providers, websiteIntelligence, { contactProvider, decisionRoles: ["HR Manager"] });

  assert.equal(report.contactsCreatedTotal, 0);
  const contacts = await prisma.contact.count({ where: { companyId: report.createdCompanyIds[0]! } });
  assert.equal(contacts, 0);

  // La conversión F14 igual crea Lead/Opportunity/Draft -- pero basados
  // ÚNICAMENTE en el email organizacional real (info@acme-mfg.com,
  // nunca en un nombre inventado). El borrador nunca lleva un saludo
  // personalizado con un nombre fabricado.
  const validation = report.companyValidations[0]!;
  assert.equal(validation.conversion!.draftCreated, true);
  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: validation.conversion!.approvalRequestId! } });
  const proposedAction = approval.proposedAction as { body?: string; contactId?: string | null };
  assert.equal(proposedAction.contactId, null);
  assert.ok(proposedAction.body?.startsWith("Hola,"), "sin contacto real, el saludo debe quedar genérico, nunca con un nombre inventado");
});

// ---------- 9. Taxonomía: Industrial/Commercial/data centers/infraestructura eléctrica ----------
// (cubierto de forma dedicada y aislada en tools/ceo-tools.impl.test.ts
// -- filterActuallyUnrecognizedTerms -- porque ese es un problema del
// intérprete LLM/taxonomía, no de executeDiscoveryPlan. Test adicional
// acá: la taxonomía "electrical" real SÍ reconoce esas variantes y
// genera Companies reales de ese sector, cerrando el círculo completo.)

test("escenario 9: la taxonomía electrical (industrial/commercial/data center) valida una Company real como EXACT", async () => {
  const tenantId = await setupTenant("scenario-9-electrical-taxonomy");
  const candidate = candidateFixture({
    name: "Lone Star Industrial Electrical Contractors",
    fields: { ...candidateFixture().fields, website: { status: "CONFIRMED", value: "https://www.lonestar-electrical.com" }, state: { status: "CONFIRMED", value: "IL" } },
  });
  const plan = manufacturingPlan({
    searchQueries: [{ searchTerm: "industrial electrical contractor", crmIndustryBucket: "Construction", taxonomyKey: "electrical" }],
  });
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidate]) });
  const websiteIntelligence = websiteIntelligenceWithEmail("info@lonestar-electrical.com");
  const report = await run(tenantId, plan, providers, websiteIntelligence);

  assert.equal(report.companiesCreated, 1);
  const validation = report.companyValidations[0]!;
  assert.equal(validation.businessConfidence, "EXACT");
  assert.equal(validation.detectedBusinessType, "electrical contractor");
});
