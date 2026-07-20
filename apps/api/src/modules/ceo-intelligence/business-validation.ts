import type { BusinessTaxonomyEntry } from "./contracts";
import { getTaxonomyEntry } from "./taxonomy";
import { normalizeText, containsWord } from "./text-normalize";

/**
 * F16 (rediseño arquitectónico -- reemplaza F7.4 Parte A): Business
 * Validation -- pura, determinista, sin Prisma/fetch/LLM. Calcula
 * EXCLUSIVAMENTE la "Business Confidence": qué tan segura está la
 * plataforma de que esta empresa candidata pertenece de verdad al
 * trade/sector buscado. Un solo evaluador genérico que LEE de
 * BUSINESS_TAXONOMY -- nunca un if por categoría.
 *
 * Separación de responsabilidades (ver company-evidence.ts para el
 * contrato completo):
 *   - Discovery encuentra candidatos y junta evidencia (nombre, sitio,
 *     categorías reales del proveedor, descripción) -- nunca valida nada.
 *   - Este módulo SOLO LEE `CompanyEvidence` -- nunca conoce la query de
 *     búsqueda que encontró al candidato, ni ninguna estrategia de
 *     descubrimiento. Esa dependencia (búsqueda -> confianza de negocio)
 *     fue la causa raíz de una regresión real (F15->F16: candidatos
 *     encontrados por queries "client-augmented" como "QTS data center
 *     electrical contractor" nunca coincidían textualmente con ninguna
 *     entrada de taxonomía, así que TODA la misión caía a WEAK y
 *     conversion-policy.ts bloqueaba todo, pese a evidencia real de
 *     contacto). `BusinessValidationInput` NO TIENE (ni puede tener) un
 *     campo de texto de búsqueda -- ver el test de compilación en
 *     business-validation.test.ts que falla si alguien lo reintroduce.
 *   - Contact/Website Enrichment agrega más evidencia después (crawl del
 *     sitio, cascada de contactos) -- nunca vuelve a tocar este módulo
 *     directamente, solo enriquece `CompanyEvidence`.
 *   - Commercial Conversion (conversion-policy.ts) LEE el resultado de
 *     este módulo (`confidence`) junto con Hiring Confidence
 *     (hiring-confidence.ts) -- dos dimensiones independientes, nunca
 *     una sola clasificación mezclada.
 *
 * Diseño de scoring -- "max sobre señales independientes":
 *   Cada señal de evidencia (nombre, categorías reales del proveedor,
 *   dominio, descripción, actividades de negocio) mapea a un nivel de
 *   confianza fijo. El resultado final es el nivel MÁS ALTO alcanzado
 *   por cualquier señal presente -- nunca un promedio, nunca una resta.
 *   Esto garantiza monotonicidad por construcción: agregar evidencia
 *   nueva (ej. tras el crawl del sitio) solo puede sumar señales nuevas
 *   al conjunto evaluado, nunca remueve una señal ya presente, así que
 *   el nivel resultante nunca puede bajar (ver guardrail de
 *   monotonicidad en business-validation.test.ts).
 *
 *   - EXACT: el nombre del candidato coincide con el trade/sector, O el
 *     proveedor de discovery (Google Places `place.types`) ya categorizó
 *     a esta empresa como ese trade. Ambas son evidencia de primera mano
 *     sobre la identidad real del negocio -- Google categorizando a una
 *     empresa como "electrician" pesa exactamente igual que su propio
 *     nombre conteniendo "electric".
 *   - STRONG: el dominio del sitio o su descripción pública mencionan el
 *     trade/sector -- evidencia real, pero indirecta (contenido de
 *     sitio, no categorización de un tercero).
 *   - APPROXIMATE: solo las actividades de negocio declaradas en la
 *     StructuredIntent de la misión coinciden -- la señal más débil de
 *     las cuatro, porque no viene de la empresa candidata en sí, viene
 *     de lo que el usuario escribió al pedir la misión.
 *   - WEAK: ninguna señal de evidencia matcheó nada -- no hay evidencia
 *     positiva ni negativa.
 *   - REJECTED: evidencia negativa explícita (nombre excluido por la
 *     misión, o coincide con negativeKeywords de la taxonomía).
 */

export const BUSINESS_VALIDATION_VERSION = 2;

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
  taxonomyKey: string;
  city: string | null;
  state: string | null;
  missionExclusions: string[];
  // Categorías reales que el proveedor de discovery le asigna al
  // candidato -- Google Places `place.types` (ej. "electrician"). Puede
  // venir vacío cuando el proveedor no las expone (Overpass) -- el
  // validador nunca inventa una.
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
 * originó (`taxonomyKey`) -- determinista, la misma evidencia siempre
 * produce el mismo resultado, sin importar qué query de descubrimiento
 * (ni cuántas veces, ni con qué estrategia) haya encontrado al
 * candidato. Nunca decide sobre datos que no recibió: si
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
  // Google Places (y proveedores similares) devuelven categorías como
  // slugs con guion bajo (ej. "general_contractor", "hvac_contractor")
  // -- se normalizan a espacios antes de comparar contra las frases
  // humanas de la taxonomía ("general contractor"), sin lo cual nunca
  // matchearían pese a ser evidencia real y directa.
  const providerTypesText = input.providerTypes.map((t) => t.replace(/_/g, " ")).join(" ");
  const providerTypeMatches = matchPhrasesInText(providerTypesText, entry.companyTypes);
  const domainMatches = matchWordsInDomain(domain, singleWordItems(entry.companyTypes));
  const descriptionMatches = matchPhrasesInText(input.description, entry.websitePhrases);
  const businessActivityMatches = matchPhrasesInText(input.businessActivities.join(" "), entry.companyTypes);

  const matchedEvidence = [
    ...new Set([...nameMatches, ...providerTypeMatches, ...domainMatches, ...descriptionMatches, ...businessActivityMatches]),
  ];
  const sourceSignals: string[] = [];
  if (nameMatches.length > 0) sourceSignals.push("name");
  if (providerTypeMatches.length > 0) sourceSignals.push("providerTypes");
  if (domainMatches.length > 0) sourceSignals.push("website");
  if (descriptionMatches.length > 0) sourceSignals.push("description");
  if (businessActivityMatches.length > 0) sourceSignals.push("businessActivities");

  // "Max sobre señales independientes" -- ver comentario de diseño
  // arriba. Cada rama es un nivel fijo; el nivel final es el más alto
  // alcanzado por CUALQUIER señal presente, nunca una combinación que
  // pueda bajar al agregar más evidencia después.
  let confidence: BusinessValidationConfidenceLevel;
  if (nameMatches.length > 0 || providerTypeMatches.length > 0) {
    confidence = "EXACT";
  } else if (domainMatches.length > 0 || descriptionMatches.length > 0) {
    confidence = "STRONG";
  } else if (businessActivityMatches.length > 0) {
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
