import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { DEFAULT_MISSION_RESTRICTIONS, type MissionRestrictions } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../core/tenancy/context";
import type { MissionPlan } from "../ceo-intelligence/contracts";
import { resetProviderHealthForTests, getProviderHealth } from "./tools/provider-health";
import { emptyResult, type ProviderCandidate, type ProviderSearchResult } from "./tools/discovery-providers/types";
import {
  executeDiscoveryPlan,
  buildFinalQueries,
  buildRefinementQueries,
  summarizeDelegatedWork,
  type DiscoveryProviderPort,
  type CompanyValidationRecord,
} from "./mission-executor";
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
    await prisma.discoveryQueryExecution.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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
    // F14: target por defecto bajado de 5 a 1 -- con el refinamiento
    // geográfico progresivo (mission-executor.ts, buildRefinementQueries),
    // cualquier fixture que pida más de lo que el proveedor fake devuelve
    // en ronda 1 ahora dispara rondas adicionales contra los estados
    // vecinos de IL (IN/WI/IA/MO). La mayoría de los tests de este
    // archivo no son sobre refinamiento -- bajar el default evita que lo
    // disparen por accidente. Los tests que sí ejercitan refinamiento a
    // propósito sobreescriben stopConditions/objective explícitamente.
    objective: { type: "find_companies", targetCompanyCount: 1, rawText: "1 empresa de manufactura" },
    searchQueries: [{ searchTerm: "manufacturing company", crmIndustryBucket: "Manufacturing", taxonomyKey: "manufacturing" }],
    exclusions: [],
    specificTaxonomyKeys: [],
    literalCompanyTypeTerms: [],
    cities: [],
    states: ["IL"],
    steps: ["discover_companies"],
    requiredSteps: ["discover_companies"],
    optionalSteps: [],
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

// ---------- buildRefinementQueries (unidad, sin Prisma) ----------
//
// F28 (misión real de Hospitality, 2026-07-28): la ronda 3 (estados
// vecinos, NEARBY_SUPPORTED_STATES) corría SIEMPRE que la ronda 1 no
// alcanzara el volumen pedido, sin mirar si la instrucción restringía la
// misión a un solo estado -- generaba queries reales contra IN/WI/IA/MO
// para "en Illinois" a secas, nunca autorizado. Ahora exige
// plan.states.length > 1 (la misma señal que ya usa geo.ts para "el
// usuario autorizó expansión real").

test("buildRefinementQueries: con plan.states=['IL'] (un solo estado, el caso normal), la ronda 3 NUNCA genera queries de estados vecinos", () => {
  const plan = manufacturingPlan({ states: ["IL"] });
  const queries = buildRefinementQueries(plan, "IL");
  const round3 = queries.filter((q) => q.refinementRound === 3);
  assert.equal(round3.length, 0, "ronda 3 no debe generar nada para una misión de un solo estado");
  assert.ok(!round3.some((q) => q.state !== "IL"), "ninguna query de ronda 3 debería apuntar a un estado distinto de IL");
});

test("buildRefinementQueries: con plan.states con más de un estado (expansión ya autorizada -- 'estados vecinos'/'Midwest'), la ronda 3 SÍ genera queries de estados vecinos reales", () => {
  const plan = manufacturingPlan({ states: ["IL", "IN", "WI"] });
  const queries = buildRefinementQueries(plan, "IL");
  const round3States = new Set(queries.filter((q) => q.refinementRound === 3).map((q) => q.state));
  assert.ok(round3States.size > 0, "con expansión ya autorizada, la ronda 3 sigue funcionando");
  assert.ok(!round3States.has("IL"), "la ronda 3 nunca repite el estado primario -- solo vecinos reales");
});

// ---------- summarizeDelegatedWork (unidad, sin Prisma) ----------
//
// F28 (misión real de Hospitality, 2026-07-28): "Tareas delegadas" en
// Mission Detail solo mostraba 1 fila (discovery) para el camino
// dinámico -- Website Intelligence/Contact Intelligence/Email
// Verification/Sales sí corrieron de verdad DENTRO de esa única
// AgentTask, solo que nunca como AgentTask hijas propias.

function companyValidationFixture(overrides: Partial<CompanyValidationRecord> = {}): CompanyValidationRecord {
  return {
    companyId: "company-1",
    name: "Acme Co",
    taxonomyKey: "manufacturing",
    businessConfidence: "EXACT",
    detectedBusinessType: "manufacturing company",
    detectedSector: "Manufacturing",
    matchedEvidence: [],
    missingEvidence: [],
    emailsExtracted: 0,
    emailsVerified: 0,
    emailsRisky: 0,
    emailsInvalid: 0,
    companyContactPointsCreated: 0,
    hasValidEmail: false,
    hiringStatus: null,
    hiringConfidence: null,
    targetTitlesMatched: [],
    rolePlan: null,
    contactsFound: 0,
    rolesWithoutContact: [],
    readyForOrganizationalContact: false,
    providerTypes: [],
    isClientOwnerCandidate: false,
    clientOwnerAssociations: [],
    hiringConfidenceTier: "NONE",
    hiringConfidenceConcreteEvidence: false,
    opportunityRecommendation: { recommendation: "INVESTIGATE_MORE", score: 0.5, reasons: [], risks: [], missingEvidence: [], nextBestAction: "", requiresApproval: true, recommendationVersion: 1 },
    conversion: null,
    ...overrides,
  } as CompanyValidationRecord;
}

test("summarizeDelegatedWork: cuenta trabajo real de Website Intelligence/Contact Intelligence/Email Verification/Sales -- nunca inventa una AgentTask nueva, solo resume companyValidations real", () => {
  const validations = [
    companyValidationFixture({ emailsExtracted: 3, emailsVerified: 2, contactsFound: 1, companyContactPointsCreated: 2 }),
    companyValidationFixture({ emailsExtracted: 0, emailsVerified: 0, contactsFound: 0, companyContactPointsCreated: 0 }),
    companyValidationFixture({ emailsExtracted: 1, emailsVerified: 1, contactsFound: 2, companyContactPointsCreated: 1 }),
  ];
  const summary = summarizeDelegatedWork(validations);
  assert.equal(summary.companiesEvaluated, 3);
  // 2 de 3 tuvieron señal real de Website Intelligence (email extraído o contact point creado).
  assert.equal(summary.websiteIntelligenceCompanies, 2);
  assert.equal(summary.contactIntelligenceContactsFound, 3); // 1 + 0 + 2
  assert.equal(summary.emailVerificationVerifiedCount, 3); // 2 + 0 + 1
  assert.equal(summary.salesConversionEvaluated, 3); // las 3 tienen opportunityRecommendation real
});

test("summarizeDelegatedWork: sin ninguna empresa, todo en 0 -- nunca un valor inventado", () => {
  const summary = summarizeDelegatedWork([]);
  assert.deepEqual(summary, {
    companiesEvaluated: 0,
    websiteIntelligenceCompanies: 0,
    contactIntelligenceContactsFound: 0,
    emailVerificationVerifiedCount: 0,
    salesConversionEvaluated: 0,
  });
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
  assert.equal(report.missionState, "COMPLETED"); // 1 de 1 pedida (target por defecto del fixture)
});

// F34: commercialMetrics se computa a partir de los MISMOS conteos reales
// del reporte, nunca una segunda fuente de verdad -- sent/delivered/
// reply/meeting quedan null a este nivel (nunca 0 fabricado).
test("commercialMetrics: se computa correctamente a partir de los conteos reales del reporte", async () => {
  const tenantId = await setupTenant("commercial-metrics");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const report = await run(tenantId, manufacturingPlan(), providers);

  assert.equal(report.commercialMetrics.noveltyRate, 1, "1 aceptado de 1 crudo -> 100% novedad");
  assert.equal(report.commercialMetrics.validatedCompanyRate, 1, "candidateFixture trae evidencia EXACT -> validada");
  assert.equal(report.commercialMetrics.replyRate, null, "sin dato real de respuestas a este nivel -- nunca 0 fabricado");
  assert.equal(report.commercialMetrics.deliveredRate, null);
  assert.equal(report.commercialMetrics.costPerValidatedCompany, report.costUsd > 0 ? report.costUsd : null);
});

// ============================================================
// F34 (auditoría arquitectónica transversal, hallazgo real: 71.9% de
// discovery duplicado / 48.4% de queries sin ninguna empresa nueva sobre
// 10 misiones de producción, 2026-08-05): memoria de saturación de
// queries -- estos tests reproducen el escenario real (misma query
// repetida entre misiones del mismo tenant, sin resultados nuevos) y
// prueban tanto la persistencia (DiscoveryQueryExecution) como el skip
// real (nunca se llama al proveedor fake para una query saturada --
// prueba costo evitado de verdad, no solo el conteo del reporte).
// ============================================================

test("F34: cada query ejecutada persiste una fila real en DiscoveryQueryExecution (tenantId/query/taxonomyKey/estado/counts correctos)", async () => {
  const tenantId = await setupTenant("query-saturation-persist");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  await run(tenantId, manufacturingPlan(), providers);

  const rows = await prisma.discoveryQueryExecution.findMany({ where: { tenantId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.normalizedQuery, "manufacturing company");
  assert.equal(rows[0]!.taxonomyKey, "manufacturing");
  assert.equal(rows[0]!.state, "IL");
  assert.equal(rows[0]!.rawResultCount, 1);
  assert.equal(rows[0]!.acceptedCount, 1);
});

test("F34 regresión real: una query con >90% de duplicados en su historial reciente (mismo tenant) se omite -- el proveedor NUNCA se llama, cero costo real", async () => {
  const tenantId = await setupTenant("query-saturation-skip");
  // Historial real de 2 ejecuciones previas de la MISMA query real
  // (normalizedQuery/state/taxonomyKey exactos) -- 40 resultados crudos,
  // 1 solo aceptado -> ratio de novedad 2.5%, muy por debajo del umbral
  // de saturación (10%).
  await prisma.discoveryQueryExecution.createMany({
    data: [
      {
        tenantId,
        normalizedQuery: "manufacturing company",
        rawQuery: "manufacturing company",
        taxonomyKey: "manufacturing",
        state: "IL",
        provider: "Google Places",
        rawResultCount: 20,
        acceptedCount: 1,
        duplicateCount: 19,
        rejectedCount: 0,
      },
      {
        tenantId,
        normalizedQuery: "manufacturing company",
        rawQuery: "manufacturing company",
        taxonomyKey: "manufacturing",
        state: "IL",
        provider: "Google Places",
        rawResultCount: 20,
        acceptedCount: 0,
        duplicateCount: 20,
        rejectedCount: 0,
      },
    ],
  });

  let providerCalled = false;
  const providers = fakeProviders({
    searchGooglePlaces: async () => {
      providerCalled = true;
      return googleResult([candidateFixture()]);
    },
  });
  const report = await run(tenantId, manufacturingPlan(), providers);

  assert.equal(providerCalled, false, "el proveedor real (fake en el test) nunca debe llamarse para una query saturada -- costo evitado de verdad");
  assert.equal(report.queriesSkippedForSaturation, 1);
  assert.equal(report.queryExecutions.length, 1);
  assert.equal(report.queryExecutions[0]!.skippedForSaturation, true);
  assert.equal(report.queryExecutions[0]!.rawResultCount, 0, "nunca se inventa un resultado para una query que no corrió");
  assert.match(report.queryExecutions[0]!.error ?? "", /[Ss]aturad/);
  assert.equal(report.missionState, "NO_RESULTS", "la única query del plan estaba saturada y se omitió -- 0 empresas encontradas, nunca COMPLETED");
});

test("F34: una query SIN historial de saturación (query nueva) se ejecuta normalmente -- el fallback FRESH nunca bloquea discovery real", async () => {
  const tenantId = await setupTenant("query-saturation-fresh");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const report = await run(tenantId, manufacturingPlan(), providers);

  assert.equal(report.queriesSkippedForSaturation, 0);
  assert.equal(report.queryExecutions[0]!.skippedForSaturation, false);
  assert.equal(report.companiesCreated, 1);
});

// F28 (aislamiento entre misiones, hallazgo real 2026-07-27): documenta
// EXPLÍCITAMENTE el hecho real del que depende el fix de aislamiento en
// campaign-tools.impl.ts -- Company.discoveredByAgentTaskId apunta al
// child AgentTask "discover_companies" que executeDiscoveryPlan crea
// (línea ~712, ver createQueuedTask), NUNCA al id de la misión raíz
// (daily_revenue_mission). Confundir los dos fue un error real cometido
// al implementar el fix -- este test existe para que nunca vuelva a
// pasar desapercibido: si alguien "simplifica" persistAcceptedCandidate
// para usar el id de la misión raíz en vez del child task, este test lo
// atrapa de inmediato.
test("F28: Company.discoveredByAgentTaskId es el child task 'discover_companies', NUNCA el id de la misión raíz", async () => {
  const tenantId = await setupTenant("discovered-by-child-task-not-root");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const report = await run(tenantId, manufacturingPlan(), providers);

  const companyId = report.createdCompanyIds[0]!;
  const company = await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: [] }, () =>
    prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
  );
  const rootMission = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "daily_revenue_mission" } });
  const discoverChildTask = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "discover_companies", parentTaskId: rootMission.id } });

  assert.equal(company.discoveredByAgentTaskId, discoverChildTask.id, "debe ser el child task discover_companies");
  assert.notEqual(company.discoveredByAgentTaskId, rootMission.id, "NUNCA debe ser el id de la misión raíz -- esa confusión es exactamente el bug que este test previene");
});

// F28 (misión real de Hospitality, 2026-07-28, pedido explícito del PO):
// este test validaba el comportamiento VIEJO -- ronda 3 (estados
// vecinos) disparaba siempre que la ronda 1 no alcanzara el volumen
// pedido, aunque la misión pidiera explícitamente un solo estado. Eso
// generaba búsquedas reales contra IN/WI/IA/MO para "en Illinois" a
// secas, nunca autorizado. Se reemplaza por dos tests: el caso normal
// (un solo estado, nunca expande) y el caso con expansión ya autorizada
// (plan.states con más de un estado -- "estados vecinos"/"Midwest" ya
// detectado por geo.ts -- ahí sí corresponde).

test("F28: un solo estado en el plan (el caso normal, 'en Illinois' a secas) -- la ronda 3 NUNCA se dispara aunque la ronda 1 no cubra el objetivo", async () => {
  const tenantId = await setupTenant("refinement-single-state-never-expands");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const plan = manufacturingPlan({
    objective: { type: "find_companies", targetCompanyCount: 5, rawText: "5 empresas de manufactura" },
    stopConditions: { maxCompanies: 5, maxCostUsd: 3, maxDurationMinutes: 60 },
    states: ["IL"],
  });
  const report = await run(tenantId, plan, providers);

  // Sin ronda 3: solo la ronda 1 (1 query) corre -- nunca IN/WI/IA/MO.
  assert.equal(report.queriesExecuted, 1);
  assert.equal(report.rawResults, 1);
  assert.equal(report.acceptedResults, 1);
  assert.equal(report.companiesCreated, 1);
  assert.equal(report.duplicatesWithinMission, 0);
  assert.equal(report.missionState, "PARTIAL"); // 1 de 5 pedidas, nunca se intentó expandir sin autorización
});

test("F28: plan con expansión ya autorizada (varios estados, ej. 'Illinois y estados vecinos') -- la ronda 3 sí corre contra los vecinos reales", async () => {
  const tenantId = await setupTenant("refinement-multi-state-authorized");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const plan = manufacturingPlan({
    objective: { type: "find_companies", targetCompanyCount: 5, rawText: "5 empresas de manufactura" },
    stopConditions: { maxCompanies: 5, maxCostUsd: 3, maxDurationMinutes: 60 },
    states: ["IL", "IN", "WI", "IA", "MO"],
  });
  const report = await run(tenantId, plan, providers);

  // IL (estado primario) tiene 4 vecinos soportados en NEARBY_SUPPORTED_
  // STATES (IN, WI, IA, MO) -- ronda 1 (1 query) + ronda 3 (4 queries, una
  // por vecino) = 5 ejecuciones. plan.cities está vacío, así que la ronda
  // 2 (mismos términos, sin ciudad) no aporta queries nuevas.
  assert.equal(report.queriesExecuted, 5);
  assert.equal(report.rawResults, 5);
  assert.equal(report.acceptedResults, 1);
  assert.equal(report.companiesCreated, 1);
  // El mismo candidato fijo vuelve a aparecer en las 4 queries de
  // refinamiento y se deduplica contra la Company ya creada en ronda 1.
  assert.equal(report.duplicatesWithinMission, 4);
  assert.equal(report.missionState, "PARTIAL"); // 1 de 5 pedidas, refinamiento agotado sin encontrar más
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

test("Bug real encontrado en auditoría: el presupuesto de proveedor de datos se ve a sí mismo DENTRO de la misma misión, antes de que termine y persista su costo", async () => {
  const tenantId = await setupTenant("mid-mission-budget");
  await prisma.tenant.update({ where: { id: tenantId }, data: { settings: { dataProviderBudgetUsd: 0.03 } } }); // justo debajo del costo de 1 query (0.032)

  let googlePlacesCalls = 0;
  const providers: DiscoveryProviderPort = {
    searchGooglePlaces: async () => {
      googlePlacesCalls += 1;
      return googleResult([candidateFixture({ name: `Mid Mission Co ${googlePlacesCalls}` })]);
    },
    searchOverpass: async () => emptyResult(),
  };

  // 2 ciudades -> 2 queries reales dentro de la MISMA corrida de
  // executeDiscoveryPlan -- antes de este fix, getDataProviderBudgetStatus
  // nunca veía el gasto de la query 1 (solo persistido al final de toda
  // la misión), así que la query 2 también le pegaba a Google Places sin
  // ningún guardia real.
  const plan = manufacturingPlan({
    cities: ["Chicago", "Aurora"],
    objective: { type: "find_companies", targetCompanyCount: 5, rawText: "5 empresas de manufactura" },
    stopConditions: { maxCompanies: 5, maxCostUsd: 3, maxDurationMinutes: 60 },
  });
  const report = await run(tenantId, plan, providers);

  assert.equal(googlePlacesCalls, 1, "la query 2 nunca debe llegar a Google Places -- el presupuesto ya se vio excedido por el gasto de la query 1 dentro de la misma misión");
  assert.ok(
    report.providersOmitted.some((note) => note.includes("presupuesto de proveedor de datos excedido")),
    "debe quedar registrado explícitamente que se omitió por presupuesto, no en silencio",
  );
  assert.equal(report.companiesCreated, 1, "solo la empresa de la query 1 (antes de agotar presupuesto) debe crearse");
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
  // F28 (antes F14): el plan por default es de un solo estado (IL) --
  // aunque ninguna empresa NUEVA se cree nunca (el único candidato
  // siempre matchea el dominio ya existente) y el objetivo (1) nunca se
  // cubra, la ronda 3 (estados vecinos) ya no dispara sin autorización
  // explícita -- el duplicado se detecta solo 1 vez (ronda 1), nunca 5.
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
  // F28 (antes F14): el plan por default es de un solo estado (IL) -- el
  // objetivo (1) nunca se cubre (0 creadas), pero la ronda 3 (estados
  // vecinos) ya no dispara sin autorización explícita -- el DEMO_SEED se
  // detecta solo 1 vez (ronda 1), nunca 5.
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

test("categoria sin bucket de Industry real (hospitality): se ejecuta la query por honestidad de costo, y AHORA sí se persiste bajo el catch-all 'Uncategorized' (F32)", async () => {
  // F32 (auditoría arquitectónica, hallazgo real MIS-20260731-0002/0003,
  // decisión explícita del PO 2026-07-31): ANTES, cualquier candidato
  // sin crmIndustryBucket se rechazaba SIEMPRE al persistir ("Sin bucket
  // de Industry real aprobado"), sin importar cuán buena fuera su
  // evidencia real -- Company.industryId es NOT NULL, así que no había
  // dónde archivarlo. Se creó un catch-all real y permanente
  // ("Uncategorized", ver seed.ts) para exactamente este caso -- la
  // Industry es solo almacenamiento, la elegibilidad real ya la decidió
  // business-validation.ts (acá: "hotel" matchea la entrada real de
  // taxonomía "hospitality" -> EXACT, aceptado).
  const tenantId = await setupTenant("no-bucket");
  const hotelPlan = manufacturingPlan({
    searchQueries: [{ searchTerm: "hotel", crmIndustryBucket: null, taxonomyKey: "hospitality" }],
  });
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture({ name: "Grand Hotel Chicago" })]) });
  const report = await run(tenantId, hotelPlan, providers);

  assert.equal(report.companiesCreated, 1, "con el catch-all 'Uncategorized' ya sembrado, el candidato debe persistirse -- nunca más se pierde evidencia real solo por falta de bucket");
  assert.equal(report.queriesExecuted, 1);
  assert.equal(report.rejectedResults, 0);
  assert.equal(report.duplicatesWithinMission, 0);

  const created = await prisma.company.findFirst({ where: { tenantId, name: "Grand Hotel Chicago" }, include: { industry: true } });
  assert.ok(created);
  assert.equal(created!.industry.name, "Uncategorized", "se archiva bajo el catch-all -- la Industry es solo almacenamiento, nunca el criterio de elegibilidad");
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
      // F12.11: hallazgo real -- sin esto, el gate de apiKey caía en
      // env.PEOPLEDATALABS_API_KEY (ambiental). Con una key real
      // configurada localmente el test pasaba por accidente; sin ninguna
      // key configurada (CI real, o cualquier entorno sin ese proveedor
      // pago) devolvía emptyReport() antes de llegar siquiera al
      // contactProvider fake, y duplicatesSkipped daba 0 en vez de 1.
      // Mismo string que ya usa runWithHiring() más arriba en este archivo.
      peopleDataLabsApiKey: "fake-pdl-key-for-tests",
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

  // Regresión: hiringSignal, rolePlan y opportunityRecommendation deben
  // coexistir en discoveryMetadata -- un bug real encontrado durante
  // F7.10 hacía que cada escritura pisara la anterior (company nunca se
  // refrescaba entre updates), dejando solo la ÚLTIMA clave escrita.
  const company = await prisma.company.findUniqueOrThrow({ where: { id: report.createdCompanyIds[0]! } });
  const metadata = company.discoveryMetadata as { hiringSignal?: unknown; rolePlan?: unknown; opportunityRecommendation?: unknown } | null;
  assert.ok(metadata?.hiringSignal, "hiringSignal no debe perderse tras escrituras posteriores");
  assert.ok(metadata?.rolePlan, "rolePlan no debe perderse tras escrituras posteriores");
  assert.ok(metadata?.opportunityRecommendation, "opportunityRecommendation debe persistirse");
});

// ---------- F7.10: Opportunity Recommendation ----------

test("opportunity recommendation: corre siempre (no depende de un paso opcional del plan), nunca crea una Opportunity", async () => {
  const tenantId = await setupTenant("opportunity-recommendation-always");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const report = await runWithHiring(tenantId, manufacturingPlan({ steps: ["discover_companies"] }), providers, NO_OP_WEBSITE_INTELLIGENCE);

  const rec = report.companyValidations[0]!.opportunityRecommendation;
  assert.ok(rec);
  assert.equal(rec.requiresApproval, true);
  assert.ok(["CREATE_OPPORTUNITY", "INVESTIGATE_MORE", "ARCHIVE", "MANUAL_REVIEW"].includes(rec.recommendation));

  const opportunities = await prisma.opportunity.count({ where: { companyId: report.createdCompanyIds[0]! } });
  assert.equal(opportunities, 0);
});

test("opportunity recommendation: evidencia debil (sin email, sin señales) nunca recomienda CREATE_OPPORTUNITY", async () => {
  const tenantId = await setupTenant("opportunity-recommendation-weak");
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture({ name: "Weak Evidence Co" })]) });
  const report = await runWithHiring(tenantId, manufacturingPlan({ steps: ["discover_companies"] }), providers, NO_OP_WEBSITE_INTELLIGENCE);

  const rec = report.companyValidations[0]!.opportunityRecommendation;
  assert.notEqual(rec.recommendation, "CREATE_OPPORTUNITY");
  assert.ok(rec.risks.length > 0);
});

// ---------- F19 Fase 1: Company.tradeKey (capacidad de modelo, sin uso todavía) ----------

test("F19 Fase 1: candidato con evidencia real (EXACT) persiste tradeKey = taxonomyKey de la query", async () => {
  const tenantId = await setupTenant("tradekey-exact");
  // "Acme Manufacturing" (fixture default) matchea "manufacturing" por
  // nombre -> EXACT, mismo candidato que ya usa el resto de este archivo
  // como caso de evidencia fuerte.
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture()]) });
  const report = await run(tenantId, manufacturingPlan(), providers);

  assert.equal(report.companyValidations[0]!.businessConfidence, "EXACT");
  const company = await prisma.company.findUniqueOrThrow({ where: { id: report.createdCompanyIds[0]! } });
  assert.equal(company.tradeKey, "manufacturing");
});

test("F19 Fase 1: candidato sin evidencia (WEAK) persiste tradeKey = null -- nunca se etiqueta un trade sin evidencia real", async () => {
  const tenantId = await setupTenant("tradekey-weak");
  // "Weak Evidence Co" -- mismo fixture que ya usa este archivo (arriba)
  // para representar el caso "evidencia débil, sin señales" contra
  // manufacturing.
  const providers = fakeProviders({ searchGooglePlaces: async () => googleResult([candidateFixture({ name: "Weak Evidence Co" })]) });
  const report = await run(tenantId, manufacturingPlan(), providers);

  assert.equal(report.companyValidations[0]!.businessConfidence, "WEAK");
  const company = await prisma.company.findUniqueOrThrow({ where: { id: report.createdCompanyIds[0]! } });
  assert.equal(company.tradeKey, null);
  // F18: mismo candidato WEAK -- ambas dimensiones (comercial y trade)
  // deben coincidir en "sin evidencia todavía", nunca una sí y la otra no.
  assert.equal(company.commercialStatus, "DISCOVERY_CANDIDATE");
});

test("F19 Fase 1: una Company creada ANTES de este cambio (sin discovery) sigue con tradeKey = null, comportamiento intacto", async () => {
  const tenantId = await setupTenant("tradekey-preexisting");
  const industry = await prisma.industry.findFirstOrThrow({ where: { name: "Manufacturing" } });
  const manual = await prisma.company.create({
    data: { tenantId, name: "F19 Preexisting Co", industryId: industry.id, status: "PROSPECT" },
  });
  createdCompanyIds.push(manual.id);

  const fetched = await prisma.company.findUniqueOrThrow({ where: { id: manual.id } });
  assert.equal(fetched.tradeKey, null);
  assert.equal(fetched.commercialStatus, "COMMERCIAL_VALIDATED");
});
