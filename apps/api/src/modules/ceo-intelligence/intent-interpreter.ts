import type { MissionRestrictions } from "@ai-staffing-os/agents";
import { DEFAULT_MISSION_RESTRICTIONS, mergeMissionRestrictions } from "@ai-staffing-os/agents";
import type { MissionObjective, MissionPlanStep, StructuredIntent } from "./contracts";
import { BUSINESS_TAXONOMY } from "./taxonomy";
import { detectCitiesAndStates } from "./geo";
import { containsWord, normalizeText } from "./text-normalize";

// F7.1: interprete de intencion -- 100% determinista, sin LLM, sin
// Prisma, sin fetch. Toda la clasificacion viene de BUSINESS_TAXONOMY
// (unica fuente de verdad, ver taxonomy.ts) -- este archivo nunca
// declara su propio vocabulario de sinonimos/industrias. La regla no
// negociable del PO ("no usar un termino de exclusion como searchTerm
// positivo") se cumple estructuralmente: el texto de las clausulas de
// exclusion se blanquea ANTES de correr cualquier matching positivo,
// nunca se confia en que las dos busquedas "no se pisen" por casualidad.
//
// "La IA podra ayudar a interpretar lenguaje natural unicamente cuando
// exista ambiguedad" (instruccion del PO): el punto de enganche para
// eso ya existe acá -- `confidence`/`ambiguities` -- pero F7.1 no llama
// a ningun LLM; un futuro asistente opcional solo podria proponer, y
// SIEMPRE tendria que volver a pasar por esta misma validacion basada en
// reglas antes de confiarse (mismo patron ya usado por
// mergeMissionRestrictions con missionRestrictions).

const EXCLUSION_CLAUSE_RE =
  /\b(?:exclu(?:ye|ir|yendo|sion(?:es)?)|except(?:ing)?|but exclude|no incluir)\b\s*:?\s*([^.;]+)/gi;
const SPLIT_LIST_RE = /\s*,\s*|\s+y\s+|\s+and\s+|\s+o\s+|\s+or\s+/i;

const KNOWN_PROVIDERS = ["Hunter", "Hunter.io", "People Data Labs", "PDL", "Google Places", "Website Intelligence"];

/** Extrae las clausulas de exclusion y devuelve (a) los terminos excluidos y (b) el texto con esas clausulas blanqueadas. */
function extractExclusions(rawInstruction: string): { exclusions: string[]; positiveText: string } {
  const exclusions = new Set<string>();
  let positiveText = rawInstruction;

  for (const match of rawInstruction.matchAll(EXCLUSION_CLAUSE_RE)) {
    const clause = match[1] ?? "";
    const terms = clause
      .split(SPLIT_LIST_RE)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    for (const term of terms) exclusions.add(term);

    const fullMatch = match[0];
    const start = match.index ?? 0;
    positiveText = positiveText.slice(0, start) + " ".repeat(fullMatch.length) + positiveText.slice(start + fullMatch.length);
  }

  return { exclusions: Array.from(exclusions), positiveText };
}

function detectObjectiveTargetCount(rawInstruction: string): number | null {
  const match = rawInstruction.match(/\b(\d{1,4})\b/);
  if (!match) return null;
  const value = Number(match[1]);
  return value > 0 && value <= 500 ? value : null;
}

function detectProvidersRequested(rawInstruction: string): string[] {
  const found = new Set<string>();
  for (const provider of KNOWN_PROVIDERS) {
    if (containsWord(normalizeText(rawInstruction), normalizeText(provider))) found.add(provider);
  }
  return Array.from(found);
}

function buildObjective(
  rawInstruction: string,
  companyTypes: string[],
  industries: string[],
  targetJobTitles: string[],
  decisionRoles: string[],
): MissionObjective {
  const targetCompanyCount = detectObjectiveTargetCount(rawInstruction);
  const hasCompanyContext = companyTypes.length > 0 || industries.length > 0;

  let type: MissionObjective["type"] = "find_companies";
  if (!hasCompanyContext && decisionRoles.length > 0) {
    type = "find_contacts";
  } else if (!hasCompanyContext && targetJobTitles.length > 0) {
    type = "find_hiring_signals";
  } else if (!hasCompanyContext && targetJobTitles.length === 0 && decisionRoles.length === 0) {
    type = "custom";
  }

  return { type, targetCompanyCount, rawText: rawInstruction };
}

function buildPlannedSteps(intent: {
  companyTypes: string[];
  industries: string[];
  targetJobTitles: string[];
  hiringSignals: string[];
  decisionRoles: string[];
}): MissionPlanStep[] {
  const steps: MissionPlanStep[] = [];
  const hasCompanyContext = intent.companyTypes.length > 0 || intent.industries.length > 0;

  if (hasCompanyContext) {
    steps.push("discover_companies", "validate_business_type");
  }
  if (hasCompanyContext && (intent.targetJobTitles.length > 0 || intent.hiringSignals.length > 0)) {
    steps.push("find_hiring_signals");
  }
  if (hasCompanyContext || intent.decisionRoles.length > 0) {
    steps.push("find_contacts", "find_organizational_emails", "verify_emails");
  } else if (intent.targetJobTitles.length > 0) {
    // "Busca empresas que contraten Machine Operators" -- sin tipo de
    // empresa/industria, no hay termino de busqueda para discover_companies,
    // pero la senal de vacante en si sigue siendo el objetivo declarado.
    steps.push("find_hiring_signals");
  }

  return Array.from(new Set(steps));
}

/**
 * Interpreta una instruccion de negocio en lenguaje natural y la
 * convierte en un StructuredIntent -- pura, determinista, sin efectos
 * secundarios. Nunca ejecuta ninguna busqueda/proveedor/escritura.
 */
export function interpretBusinessIntent(rawInstruction: string): StructuredIntent {
  const { exclusions, positiveText } = extractExclusions(rawInstruction);
  const normalizedPositive = normalizeText(positiveText);

  const matchedEntries = BUSINESS_TAXONOMY.filter((entry) =>
    entry.synonyms.some((syn) => containsWord(normalizedPositive, normalizeText(syn))),
  );
  const matchedTaxonomyKeys = matchedEntries.map((e) => e.key);

  const companyTypes = Array.from(new Set(matchedEntries.flatMap((e) => e.companyTypes)));
  const industries = Array.from(
    new Set(matchedEntries.map((e) => e.crmIndustryBucket).filter((b): b is string => b !== null)),
  );
  const businessActivities = Array.from(new Set(matchedEntries.map((e) => e.label)));
  const searchTerms = Array.from(new Set(matchedEntries.flatMap((e) => e.googleSearchPhrases)));

  // Titulos/roles literales -- se buscan en TODO el vocabulario de la
  // taxonomia (no solo el de las entradas ya matcheadas), porque una
  // instruccion puede pedir un rol sin nombrar ningun tipo de empresa
  // ("Encuentra HR Manager o Plant Manager", "Busca empresas que
  // contraten Machine Operators").
  const allJobTitles = Array.from(new Set(BUSINESS_TAXONOMY.flatMap((e) => e.jobTitles)));
  const allDecisionMakers = Array.from(new Set(BUSINESS_TAXONOMY.flatMap((e) => e.decisionMakers)));

  const literalJobTitles = allJobTitles.filter((title) => containsWord(normalizedPositive, normalizeText(title)));
  const literalDecisionRoles = allDecisionMakers.filter((role) => containsWord(normalizedPositive, normalizeText(role)));

  const targetJobTitles = Array.from(new Set(literalJobTitles));
  const hiringSignals = Array.from(new Set([...targetJobTitles, ...matchedEntries.flatMap((e) => e.jobTitles)]));
  const decisionRoles = Array.from(new Set([...literalDecisionRoles, ...matchedEntries.flatMap((e) => e.decisionMakers)]));

  const { cities: preferredCities, states } = detectCitiesAndStates(rawInstruction);
  const providersRequested = detectProvidersRequested(rawInstruction);
  const restrictions: MissionRestrictions = mergeMissionRestrictions(null, rawInstruction);
  const objective = buildObjective(rawInstruction, companyTypes, industries, targetJobTitles, decisionRoles);
  const plannedSteps = buildPlannedSteps({ companyTypes, industries, targetJobTitles, hiringSignals, decisionRoles });

  const ambiguities: string[] = [];
  const unsupportedCapabilities: string[] = [];

  if (companyTypes.length === 0 && targetJobTitles.length === 0 && decisionRoles.length === 0) {
    ambiguities.push(
      "No se pudo identificar ningún tipo de empresa, industria, ni rol/título en la instrucción — no matcheó ninguna entrada de la Business Taxonomy.",
    );
  }
  if (companyTypes.length > 0 && industries.length === 0) {
    ambiguities.push(
      "Los tipos de empresa detectados no tienen ninguna Industry real del CRM asociada (crmIndustryBucket=null) — quedarían archivados sin industria real hasta que el PO decida crear una (ver plan F7 §9.4). No es un error del intérprete, es un límite conocido del CRM actual.",
    );
  }
  if (objective.type === "find_contacts") {
    ambiguities.push(
      "No se especificó tipo de empresa ni industria — esta búsqueda de roles/contactos solo podría aplicarse sobre empresas ya existentes en el CRM, sin acotar por sector.",
    );
  }
  if (objective.type === "find_hiring_signals" && companyTypes.length === 0) {
    ambiguities.push(
      "No se especificó tipo de empresa ni industria — no hay término de búsqueda para descubrir empresas nuevas; la señal de vacante pedida solo podría verificarse sobre empresas ya existentes en el CRM.",
    );
  }

  let confidence = 1;
  if (companyTypes.length === 0 && targetJobTitles.length === 0 && decisionRoles.length === 0) confidence = 0.1;
  else if (companyTypes.length > 0 && industries.length === 0) confidence = Math.min(confidence, 0.7);
  if (objective.type === "find_contacts" || objective.type === "find_hiring_signals") confidence = Math.min(confidence, 0.6);

  return {
    schemaVersion: 1,
    rawInstruction,
    objective,
    companyTypes,
    industries,
    businessActivities,
    searchTerms,
    hiringSignals,
    decisionRoles,
    targetJobTitles,
    exclusions,
    preferredCities,
    states,
    providersRequested,
    restrictions: restrictions ?? DEFAULT_MISSION_RESTRICTIONS,
    plannedSteps,
    confidence,
    ambiguities,
    unsupportedCapabilities,
    matchedTaxonomyKeys,
  };
}
