import type { BusinessTaxonomyEntry } from "./contracts";
import { getTaxonomyEntry } from "./taxonomy";
import { normalizeText, containsWord } from "./text-normalize";

/**
 * F7.4 Parte A: Business Validation -- pura, determinista, sin Prisma/
 * fetch/LLM (mismo criterio que el resto de ceo-intelligence/). Un solo
 * evaluador genérico que LEE de BUSINESS_TAXONOMY -- nunca un if por
 * categoría (regla explícita del PO: "no crear cientos de if dispersos,
 * las reglas deben salir de la taxonomía central"). Roofing/Electrical/
 * Data Centers/Landscaping/Healthcare/Restaurants usan exactamente el
 * mismo algoritmo que Hospitality/Manufacturing/Food Manufacturing/
 * Warehousing/Janitorial/Commercial Cleaning -- solo cambia qué entrada
 * de la taxonomía se lee.
 *
 * Mapeo de evidencia (cada entrada de BUSINESS_TAXONOMY ya trae el
 * vocabulario correcto para cada fuente):
 *   - nombre del candidato      <-> entry.companyTypes (frase completa,
 *     límite de palabra vía containsWord)
 *   - dominio del website       <-> entry.companyTypes, pero SOLO los
 *     ítems de una sola palabra (un dominio no tiene espacios, así que
 *     "distribution center" nunca puede aparecer literal en un hostname
 *     -- evitar falsos positivos de sustring sin límite de palabra real)
 *   - descripción pública       <-> entry.websitePhrases (el campo de la
 *     taxonomía pensado explícitamente para evidencia de contenido real
 *     de sitio, ver contracts.ts)
 *   - provider types            <-> entry.companyTypes
 *   - businessActivities        <-> entry.companyTypes (labels de la
 *     StructuredIntent, evidencia débil adicional, opcional)
 */

export const BUSINESS_VALIDATION_VERSION = 1;

export const businessValidationConfidenceLevels = [
  "EXACT",
  "STRONG",
  "APPROXIMATE",
  "WEAK",
  "REJECTED",
] as const;
export type BusinessValidationConfidenceLevel = (typeof businessValidationConfidenceLevels)[number];

// Puntaje numérico espejo de cada nivel -- solo para ordenar/mostrar en
// UI, la decisión real (accepted/confidence) siempre sale del nivel, no
// al revés.
const CONFIDENCE_SCORE_BY_LEVEL: Record<BusinessValidationConfidenceLevel, number> = {
  EXACT: 0.95,
  STRONG: 0.75,
  APPROXIMATE: 0.5,
  WEAK: 0.3,
  REJECTED: 0,
};

export interface BusinessValidationInput {
  candidateName: string | null;
  website: string | null;
  // Frase de búsqueda que encontró este candidato -- usada para detectar
  // el nivel APPROXIMATE (encontrado por una query dirigida de esta
  // misma taxonomía, sin ninguna corroboración independiente).
  searchTerm: string;
  taxonomyKey: string;
  city: string | null;
  state: string | null;
  missionExclusions: string[];
  // Los siguientes 3 campos suelen venir vacíos hoy -- ningún proveedor
  // real conectado en F7.3/F7.4 los popula todavía (ver limitaciones
  // documentadas). El validador los evalúa igual, honestamente, cuando
  // SÍ vienen presentes -- una fase futura que los conecte no requiere
  // tocar este archivo.
  providerTypes: string[];
  description: string | null;
  businessActivities: string[];
}

export interface BusinessValidationResult {
  accepted: boolean;
  confidence: BusinessValidationConfidenceLevel;
  confidenceScore: number;
  detectedBusinessType: string | null;
  detectedSector: string | null;
  matchedEvidence: string[];
  missingEvidence: string[];
  rejectionReasons: string[];
  warnings: string[];
  sourceSignals: string[];
  validationVersion: number;
}

function domainOf(website: string | null): string | null {
  if (!website) return null;
  try {
    const url = new URL(website.startsWith("http") ? website : `https://${website}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Ítems de una sola palabra de una lista de frases -- lo único seguro de buscar como substring literal dentro de un hostname sin espacios. */
function singleWordItems(items: string[]): string[] {
  return items.filter((item) => !item.trim().includes(" "));
}

function matchPhrasesInText(text: string | null, phrases: string[]): string[] {
  if (!text) return [];
  const normalized = normalizeText(text);
  return phrases.filter((phrase) => containsWord(normalized, normalizeText(phrase)));
}

function matchWordsInDomain(domain: string | null, words: string[]): string[] {
  if (!domain) return [];
  const normalizedDomain = normalizeText(domain);
  return words.filter((word) => normalizedDomain.includes(normalizeText(word)));
}

function buildEmptyResult(
  confidence: BusinessValidationConfidenceLevel,
  rejectionReasons: string[],
  warnings: string[] = [],
): BusinessValidationResult {
  return {
    accepted: false,
    confidence,
    confidenceScore: CONFIDENCE_SCORE_BY_LEVEL[confidence],
    detectedBusinessType: null,
    detectedSector: null,
    matchedEvidence: [],
    missingEvidence: [],
    rejectionReasons,
    warnings,
    sourceSignals: [],
    validationVersion: BUSINESS_VALIDATION_VERSION,
  };
}

/**
 * Evalúa un candidato descubierto contra la entrada de taxonomía que lo
 * originó (`taxonomyKey`) -- determinista, misma entrada siempre produce
 * el mismo resultado. Nunca decide sobre datos que no recibió: si
 * `providerTypes`/`description` vienen vacíos, simplemente no aportan
 * evidencia (nunca se inventa una).
 */
export function validateBusinessCandidate(input: BusinessValidationInput): BusinessValidationResult {
  if (!input.candidateName || !input.candidateName.trim()) {
    return buildEmptyResult("REJECTED", ["Sin nombre utilizable para validar."]);
  }

  const entry = getTaxonomyEntry(input.taxonomyKey);
  if (!entry) {
    return buildEmptyResult("REJECTED", [`Taxonomy key desconocida: "${input.taxonomyKey}".`]);
  }

  const normalizedName = normalizeText(input.candidateName);
  const domain = domainOf(input.website);

  for (const exclusion of input.missionExclusions) {
    if (exclusion.trim() && containsWord(normalizedName, normalizeText(exclusion))) {
      return buildEmptyResult("REJECTED", [
        `El nombre coincide con un término excluido explícitamente por la misión: "${exclusion}".`,
      ]);
    }
  }

  const negativeNameMatches = matchPhrasesInText(input.candidateName, entry.negativeKeywords);
  const negativeDomainMatches = matchWordsInDomain(domain, singleWordItems(entry.negativeKeywords));
  const negativeDescriptionMatches = matchPhrasesInText(input.description, entry.negativeKeywords);
  const allNegativeMatches = [...new Set([...negativeNameMatches, ...negativeDomainMatches, ...negativeDescriptionMatches])];
  if (allNegativeMatches.length > 0) {
    return buildEmptyResult("REJECTED", [
      `Evidencia negativa para "${entry.label}": coincide con ${allNegativeMatches.map((m) => `"${m}"`).join(", ")}.`,
    ]);
  }

  const nameMatches = matchPhrasesInText(input.candidateName, entry.companyTypes);
  const domainMatches = matchWordsInDomain(domain, singleWordItems(entry.companyTypes));
  const descriptionMatches = matchPhrasesInText(input.description, entry.websitePhrases);
  const providerTypeMatches = matchPhrasesInText(input.providerTypes.join(" "), entry.companyTypes);
  const businessActivityMatches = matchPhrasesInText(input.businessActivities.join(" "), entry.companyTypes);

  const matchedEvidence = [
    ...new Set([...nameMatches, ...domainMatches, ...descriptionMatches, ...providerTypeMatches, ...businessActivityMatches]),
  ];
  const sourceSignals: string[] = [];
  if (nameMatches.length > 0) sourceSignals.push("name");
  if (domainMatches.length > 0) sourceSignals.push("website");
  if (descriptionMatches.length > 0) sourceSignals.push("description");
  if (providerTypeMatches.length > 0) sourceSignals.push("providerTypes");
  if (businessActivityMatches.length > 0) sourceSignals.push("businessActivities");

  const searchTermMatchesTaxonomyQuery = entry.googleSearchPhrases.some(
    (phrase) => normalizeText(phrase) === normalizeText(input.searchTerm),
  );

  let confidence: BusinessValidationConfidenceLevel;
  if (nameMatches.length > 0) {
    confidence = "EXACT";
  } else if (domainMatches.length > 0 || descriptionMatches.length > 0 || providerTypeMatches.length > 0) {
    confidence = "STRONG";
  } else if (searchTermMatchesTaxonomyQuery) {
    confidence = "APPROXIMATE";
  } else {
    confidence = "WEAK";
  }

  const warnings: string[] = [];
  if (!input.description) warnings.push("Sin descripción pública disponible para esta fuente — evidencia limitada a nombre/dominio.");
  if (input.providerTypes.length === 0) warnings.push("Sin provider types disponibles para esta fuente — evidencia limitada a nombre/dominio.");

  const missingEvidence = confidence === "EXACT" ? [] : entry.validations;

  return {
    accepted: true,
    confidence,
    confidenceScore: CONFIDENCE_SCORE_BY_LEVEL[confidence],
    detectedBusinessType: entry.companyTypes[0] ?? null,
    detectedSector: entry.crmIndustryBucket,
    matchedEvidence,
    missingEvidence,
    rejectionReasons: [],
    warnings,
    sourceSignals,
    validationVersion: BUSINESS_VALIDATION_VERSION,
  };
}

// Reexport de tipo -- consumido por mission-executor.ts sin tener que
// importar contracts.ts directamente para esto.
export type { BusinessTaxonomyEntry };
