import type { MissionPlan, MissionPlanFallback, MissionPlanStep, StructuredIntent } from "./contracts";
import { getTaxonomyEntry } from "./taxonomy";

// F7.1: Mission Planner -- pura, determinista, sin Prisma/fetch/LLM.
// Construye el MissionPlan a partir de un StructuredIntent ya
// interpretado (intent-interpreter.ts) -- nunca vuelve a leer texto
// libre, nunca decide nada que el intent no haya declarado ya. Ningun
// paso de este plan se ejecuta en F7.1 (ver plan aprobado
// docs/F7_CEO_INTELLIGENCE_AND_AUTONOMOUS_CLIENT_ACQUISITION_PLAN.md
// §5.3/§5.4) -- es una declaracion de intencion, no una invocacion real.

// Mismos valores default que mission-orchestrator.ts (MAX_COMPANIES_PER_MISSION,
// DEFAULT_DAILY_MISSION_BUDGET_USD, DEFAULT_MISSION_TIMEOUT_MINUTES) --
// duplicados a propósito (esos son consts privadas, no exportadas, y
// este módulo no debe depender de mission-orchestrator.ts, que sí
// depende de Prisma). Reconciliar en una sola fuente compartida es
// trabajo de wiring (F7.5), no de F7.1.
const DEFAULT_MAX_COMPANIES = 50;
const DEFAULT_MAX_COST_USD = 3;
const DEFAULT_MAX_DURATION_MINUTES = 60;

const ALWAYS_REQUIRED_STEPS = new Set<MissionPlanStep>(["discover_companies"]);

/**
 * F14 (refinamiento de calidad, 2026-07-19): orden específico-primero,
 * genérico-al-final -- ANTES esto solo respetaba el orden de
 * `intent.matchedTaxonomyKeys` (a su vez, el orden de declaración en
 * BUSINESS_TAXONOMY), así que "construction" siempre corría antes que
 * "electrical" cuando ambos matcheaban la misma instrucción (electrical
 * está declarada después). Resultado real observado: una misión de
 * "contratistas eléctricos en Texas" devolvía constructoras generales,
 * porque la query genérica "construction company" agotaba el cupo de
 * resultados antes de llegar siquiera a "electrical contractor".
 *
 * `isGenericFallback` (taxonomy.ts) es la señal explícita: las entradas
 * NO genéricas (el trade/sector específico que el usuario realmente
 * pidió) se ordenan primero, preservando su orden relativo de matching;
 * las entradas genéricas (Construction/Manufacturing/Warehousing/
 * Distribution/Healthcare/Retail/Transportation como categoría paraguas)
 * quedan al final, como último recurso real -- nunca antes.
 */
function buildSearchQueries(intent: StructuredIntent) {
  const queries: MissionPlan["searchQueries"] = [];
  const matchedEntries = intent.matchedTaxonomyKeys.map((key) => getTaxonomyEntry(key)).filter((e) => e !== undefined);
  const specificFirst = [...matchedEntries].sort((a, b) => Number(a.isGenericFallback) - Number(b.isGenericFallback));
  for (const entry of specificFirst) {
    for (const phrase of entry.googleSearchPhrases) {
      queries.push({ searchTerm: phrase, crmIndustryBucket: entry.crmIndustryBucket, taxonomyKey: entry.key });
    }
  }
  return queries;
}

function buildFallbackStrategy(steps: MissionPlanStep[]): MissionPlanFallback[] {
  const fallback: MissionPlanFallback[] = [];
  if (steps.includes("discover_companies")) {
    fallback.push({
      provider: "Google Places",
      whenUnavailable: "Usar Overpass (OpenStreetMap) como respaldo gratuito — cobertura más limitada, sin costo.",
    });
  }
  if (steps.includes("find_contacts")) {
    fallback.push({
      provider: "People Data Labs",
      whenUnavailable: "Omitir la búsqueda de contactos nombrados; continuar solo con emails organizacionales.",
    });
  }
  if (steps.includes("find_organizational_emails") || steps.includes("verify_emails")) {
    fallback.push({
      provider: "Hunter.io",
      whenUnavailable: "Usar únicamente Website Intelligence (gratis, sin API key) para emails organizacionales, sin verificación de entregabilidad.",
    });
  }
  return fallback;
}

function buildRationale(intent: StructuredIntent, steps: MissionPlanStep[]): string {
  const parts: string[] = [];
  parts.push(
    intent.companyTypes.length > 0
      ? `Se buscarán empresas de tipo: ${intent.companyTypes.join(", ")}.`
      : "No se identificó ningún tipo de empresa concreto en la instrucción.",
  );
  if (intent.industries.length > 0) {
    parts.push(`Se archivarán bajo la(s) industria(s) real(es) del CRM: ${intent.industries.join(", ")}.`);
  } else if (intent.companyTypes.length > 0) {
    parts.push("Ninguna industria real del CRM aplica hoy — quedarán sin bucket de archivo hasta que se cree una.");
  }
  if (intent.exclusions.length > 0) parts.push(`Se excluirá explícitamente: ${intent.exclusions.join(", ")}.`);
  if (intent.preferredCities.length > 0) parts.push(`Ciudades priorizadas: ${intent.preferredCities.join(", ")}.`);
  if (intent.hiringSignals.length > 0) parts.push(`Señales de contratación a verificar: ${intent.hiringSignals.join(", ")}.`);
  if (intent.decisionRoles.length > 0) parts.push(`Roles de decisión a buscar: ${intent.decisionRoles.join(", ")}.`);
  parts.push(`Pasos planificados, en orden: ${steps.join(" → ") || "(ninguno)"}.`);
  if (!intent.restrictions.allowCampaignCreation) parts.push("No se creará ninguna Campaign.");
  if (!intent.restrictions.allowOpportunityCreation) parts.push("No se crearán Opportunities.");
  if (!intent.restrictions.allowOutreach) parts.push("No se planificará ningún outreach.");
  return parts.join(" ");
}

/**
 * Construye el Mission Plan completo a partir de un StructuredIntent ya
 * interpretado. Determinista: el mismo intent siempre produce el mismo
 * plan.
 */
export function buildMissionPlan(intent: StructuredIntent): MissionPlan {
  const steps = intent.plannedSteps;
  const requiredSteps = steps.filter((s) => ALWAYS_REQUIRED_STEPS.has(s));
  const optionalSteps = steps.filter((s) => !ALWAYS_REQUIRED_STEPS.has(s));

  return {
    schemaVersion: 1,
    objective: intent.objective,
    searchQueries: buildSearchQueries(intent),
    exclusions: intent.exclusions,
    cities: intent.preferredCities,
    states: intent.states,
    steps,
    requiredSteps,
    optionalSteps,
    stopConditions: {
      maxCompanies: intent.objective.targetCompanyCount ?? DEFAULT_MAX_COMPANIES,
      maxCostUsd: DEFAULT_MAX_COST_USD,
      maxDurationMinutes: DEFAULT_MAX_DURATION_MINUTES,
    },
    dedupStrategy: steps.includes("discover_companies")
      ? ["providerPlaceId", "canonicalDomain", "normalizedPhone", "normalizedNameCityState"]
      : [],
    fallbackStrategy: buildFallbackStrategy(steps),
    restrictions: intent.restrictions,
    rationale: buildRationale(intent, steps),
  };
}
