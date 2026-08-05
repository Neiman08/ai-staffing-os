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

export const BUSINESS_VALIDATION_VERSION = 3;

export const businessValidationConfidenceLevels = [
  "EXACT",
  "STRONG",
  "APPROXIMATE",
  "WEAK",
  "REJECTED",
] as const;
export type BusinessValidationConfidenceLevel = (typeof businessValidationConfidenceLevels)[number];

// F34 (auditoría arquitectónica transversal, 2026-08-05): `accepted:
// boolean` históricamente era SIEMPRE `true` salvo en los pocos caminos
// que ya devolvían buildEmptyResult -- un candidato WEAK (confianza
// mínima, `matchedEvidence` puede venir vacío) igual salía
// `accepted:true`, un nombre que sugiere "identidad validada" cuando en
// realidad solo significa "no fue rechazado por una señal estructural
// negativa". `status` es la fuente de verdad explícita y honesta que
// reemplaza esa ambigüedad -- `accepted` se mantiene (comportamiento SIN
// CAMBIOS: mission-executor.ts sigue leyéndolo para decidir si crea la
// Company) pero ahora se DERIVA de `status`, nunca al revés.
//   - VALIDATED: evidencia real y directa de identidad (EXACT/STRONG) --
//     candidato para Company.commercialStatus=COMMERCIAL_VALIDATED.
//   - PROBABLE: solo coincide con las actividades de negocio declaradas
//     en la instrucción (APPROXIMATE) -- igual COMMERCIAL_VALIDATED
//     (evidencia real, aunque indirecta), ver deriveCommercialStatus.
//   - INSUFFICIENT_EVIDENCE: ninguna señal positiva coincidió (WEAK) --
//     se sigue persistiendo como Company (decisión de producto explícita:
//     visible para investigación humana), pero SIEMPRE
//     commercialStatus=DISCOVERY_CANDIDATE, nunca Lead/Opportunity/Draft
//     (ver conversion-policy.ts deriveCommercialStatus/evaluateBusinessIdentityGate).
//   - MISMATCH: hay evidencia de que el candidato es un tipo de negocio
//     DISTINTO al pedido (negativeKeywords, o bucket genérico sin
//     evidencia del trade específico pedido) -- nunca se persiste como
//     Company.
//   - REJECTED: fallo estructural (sin nombre, taxonomyKey desconocida,
//     fuera de la geografía pedida, o coincide con una exclusión
//     explícita de la misión) -- nunca se persiste como Company.
export const businessValidationStatuses = ["VALIDATED", "PROBABLE", "INSUFFICIENT_EVIDENCE", "MISMATCH", "REJECTED"] as const;
export type BusinessValidationStatus = (typeof businessValidationStatuses)[number];

function statusForConfidence(confidence: BusinessValidationConfidenceLevel): Extract<BusinessValidationStatus, "VALIDATED" | "PROBABLE" | "INSUFFICIENT_EVIDENCE"> {
  if (confidence === "EXACT" || confidence === "STRONG") return "VALIDATED";
  if (confidence === "APPROXIMATE") return "PROBABLE";
  return "INSUFFICIENT_EVIDENCE";
}

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
  // F28 (hallazgo real, misiones roofing/landscaping 2026-07-27): el
  // estado REAL detectado del candidato (Google Places address_components,
  // ver google-places.ts) -- antes este campo recibía el estado de la
  // QUERY (lo que se buscó), nunca el del negocio encontrado, así que
  // ninguna empresa fuera del estado pedido podía rechazarse nunca por
  // esto (el campo existía pero jamás se leía acá).
  state: string | null;
  // F28: estados a los que la misión restringió la búsqueda ("en
  // Illinois" -> ["IL"]) -- vacío cuando la instrucción no mencionó
  // ningún estado (sin restricción real que aplicar). Población real:
  // MissionPlan.states (mission-planner.ts, geo.ts) -- nunca inventado
  // acá.
  allowedStates: string[];
  // F28 (validación de industria para roofing, hallazgo real
  // 2026-07-27): keys NO genéricas (isGenericFallback=false) que la
  // misión también matcheó, además de `taxonomyKey` -- ej. una misión
  // de "roofing" que además matcheó "construction" (isGenericFallback)
  // por la palabra "contratistas". Cuando el candidato fue encontrado
  // vía una entrada GENÉRICA, exige evidencia real de al menos uno de
  // estos trades específicos -- nunca alcanza con pertenecer al mismo
  // bucket amplio (Construction). Vacío = la misión no pidió ningún
  // trade específico además del genérico, nada que exigir.
  missionSpecificTaxonomyKeys: string[];
  // F32 (hallazgo real, MIS-20260731-0002/0003, 2026-07-31): mismo
  // criterio que missionSpecificTaxonomyKeys de arriba, pero para
  // términos de tipo de empresa que la misión pidió explícitamente y que
  // NINGUNA entrada de BUSINESS_TAXONOMY reconoce (StructuredIntent.
  // literalCompanyTypeTerms) -- un candidato encontrado vía una entrada
  // GENÉRICA (ej. "construction") cuando la misión también pidió un
  // término literal (ej. "low voltage contractor", sin entrada propia en
  // la taxonomía) tampoco debe aceptarse solo por el bucket amplio.
  missionLiteralTerms: string[];
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
  status: BusinessValidationStatus;
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

/**
 * F28 (hallazgo real, misión de Hospitality, 2026-07-29): devuelve el
 * término de exclusión de la misión que matchea `candidateName`, o null
 * si ninguno matchea -- mismo límite de palabra que el resto de este
 * módulo (nunca substring crudo: "inn" no debe matchear "Winning
 * Solutions"). Extraída como función pura reutilizable porque esta
 * exclusión debe aplicarse en DOS momentos distintos, no solo al
 * descubrir candidatos nuevos (este módulo): también al seleccionar
 * empresas YA existentes en el CRM (select_target_companies y su
 * fallback por tradeKey, ver campaign-tools.impl.ts/mission-orchestrator.ts)
 * -- bug real encontrado en producción: "Cornerstone Inn" (CRM desde una
 * misión anterior sin esta exclusión) fue seleccionada por el fallback
 * de tradeKey y llegó a generar Lead+Opportunity pese a que la misión
 * excluía explícitamente "inn". La restricción de la misión debe
 * prevalecer sobre el historial del CRM, sin importar de dónde salga la
 * Company.
 */
export function matchesMissionExclusion(candidateName: string, missionExclusions: string[]): string | null {
  const normalizedName = normalizeText(candidateName);
  for (const exclusion of missionExclusions) {
    if (exclusion.trim() && containsWord(normalizedName, normalizeText(exclusion))) {
      return exclusion;
    }
  }
  return null;
}

function buildEmptyResult(
  status: Extract<BusinessValidationStatus, "REJECTED" | "MISMATCH">,
  rejectionReasons: string[],
  warnings: string[] = [],
): BusinessValidationResult {
  return {
    accepted: false,
    status,
    confidence: "REJECTED",
    confidenceScore: CONFIDENCE_SCORE_BY_LEVEL.REJECTED,
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
// F32 (hallazgo real, MIS-20260731-0002/0003, 2026-07-31): prefijo
// compartido con mission-planner.ts (buildSearchQueries) -- una query
// generada a partir de StructuredIntent.literalCompanyTypeTerms (un tipo
// de empresa que la misión pidió explícitamente pero que
// BUSINESS_TAXONOMY no reconoce) usa este prefijo como taxonomyKey, para
// que este módulo sepa validar por evidencia directa del término mismo
// en vez de intentar (y fallar) una búsqueda en getTaxonomyEntry.
const LITERAL_TAXONOMY_KEY_PREFIX = "literal:";

/**
 * F32: valida un candidato encontrado vía un término literal (sin
 * entrada curada en BUSINESS_TAXONOMY) -- mismo diseño "max sobre
 * señales independientes" que el resto de este módulo, pero las
 * "frases" a buscar son el término mismo (nunca una lista curada de
 * companyTypes/websitePhrases/negativeKeywords, que no existe para un
 * término desconocido). Limitación real y honesta: sin negativeKeywords
 * propias, este camino nunca puede RECHAZAR por evidencia negativa de
 * industria (sí sigue rechazando por exclusión explícita de la misión y
 * por estado, ver validateBusinessCandidate) -- exactamente lo que pide
 * el diseño general: "si la confianza es baja, conservar el término
 * como criterio de búsqueda y validación", nunca inventar una lista de
 * rechazo que no existe.
 */
function validateLiteralCompanyType(input: BusinessValidationInput, domain: string | null): BusinessValidationResult {
  const literalTerm = input.taxonomyKey.slice(LITERAL_TAXONOMY_KEY_PREFIX.length);
  const phrases = [literalTerm];
  const providerTypesText = input.providerTypes.map((t) => t.replace(/_/g, " ")).join(" ");

  const nameMatches = matchPhrasesInText(input.candidateName, phrases);
  const providerTypeMatches = matchPhrasesInText(providerTypesText, phrases);
  const domainMatches = matchWordsInDomain(domain, singleWordItems(phrases));
  const descriptionMatches = matchPhrasesInText(input.description, phrases);
  const businessActivityMatches = matchPhrasesInText(input.businessActivities.join(" "), phrases);

  const matchedEvidence = [
    ...new Set([...nameMatches, ...providerTypeMatches, ...domainMatches, ...descriptionMatches, ...businessActivityMatches]),
  ];
  const sourceSignals: string[] = [];
  if (nameMatches.length > 0) sourceSignals.push("name");
  if (providerTypeMatches.length > 0) sourceSignals.push("providerTypes");
  if (domainMatches.length > 0) sourceSignals.push("website");
  if (descriptionMatches.length > 0) sourceSignals.push("description");
  if (businessActivityMatches.length > 0) sourceSignals.push("businessActivities");

  let confidence: BusinessValidationConfidenceLevel;
  if (nameMatches.length > 0 || providerTypeMatches.length > 0) confidence = "EXACT";
  else if (domainMatches.length > 0 || descriptionMatches.length > 0) confidence = "STRONG";
  else if (businessActivityMatches.length > 0) confidence = "APPROXIMATE";
  else confidence = "WEAK";

  const warnings: string[] = [
    `Sin entrada de Business Taxonomy curada para "${literalTerm}" — validado únicamente por evidencia directa del término (nombre/dominio/descripción/categorías del proveedor), sin lista de negativeKeywords propia.`,
  ];
  if (!input.description) warnings.push("Sin descripción pública disponible para esta fuente — evidencia limitada a nombre/dominio.");
  if (input.providerTypes.length === 0) warnings.push("Sin provider types disponibles para esta fuente — evidencia limitada a nombre/dominio.");

  return {
    accepted: true,
    status: statusForConfidence(confidence),
    confidence,
    confidenceScore: CONFIDENCE_SCORE_BY_LEVEL[confidence],
    detectedBusinessType: literalTerm,
    detectedSector: null,
    matchedEvidence,
    missingEvidence:
      confidence === "EXACT" ? [] : [`Evidencia pública real de "${literalTerm}" (nombre, sitio, categoría del proveedor, o descripción).`],
    rejectionReasons: [],
    warnings,
    sourceSignals,
    validationVersion: BUSINESS_VALIDATION_VERSION,
  };
}

export function validateBusinessCandidate(input: BusinessValidationInput): BusinessValidationResult {
  if (!input.candidateName || !input.candidateName.trim()) {
    return buildEmptyResult("REJECTED", ["Sin nombre utilizable para validar."]);
  }

  const isLiteralTerm = input.taxonomyKey.startsWith(LITERAL_TAXONOMY_KEY_PREFIX);
  const entry = isLiteralTerm ? undefined : getTaxonomyEntry(input.taxonomyKey);
  if (!isLiteralTerm && !entry) {
    return buildEmptyResult("REJECTED", [`Taxonomy key desconocida: "${input.taxonomyKey}".`]);
  }

  const domain = domainOf(input.website);

  // F28 (restricción geográfica estricta, hallazgo real 2026-07-27):
  // cuando la misión restringió explícitamente a uno o más estados
  // ("en Illinois" -> allowedStates=["IL"]), un candidato con estado
  // real detectado FUERA de esa lista se rechaza sin importar cuán
  // buena sea el resto de su evidencia -- coincidir con la industria
  // nunca alcanza si está en el estado equivocado. allowedStates vacío
  // (la instrucción no restringió ningún estado) nunca rechaza por
  // esto -- no hay nada real que aplicar.
  if (input.allowedStates.length > 0 && input.state && !input.allowedStates.includes(input.state)) {
    return buildEmptyResult("REJECTED", [
      `La empresa está en "${input.state}", fuera de los estados a los que la misión restringió la búsqueda (${input.allowedStates.join(", ")}).`,
    ]);
  }

  const matchedExclusion = matchesMissionExclusion(input.candidateName, input.missionExclusions);
  if (matchedExclusion) {
    return buildEmptyResult("REJECTED", [
      `El nombre coincide con un término excluido explícitamente por la misión: "${matchedExclusion}".`,
    ]);
  }

  if (isLiteralTerm) {
    return validateLiteralCompanyType(input, domain);
  }
  // A partir de acá `entry` está garantizado (isLiteralTerm=false y ya
  // se rechazó arriba si getTaxonomyEntry no lo encontró).
  const nonNullEntry = entry!;

  const negativeNameMatches = matchPhrasesInText(input.candidateName, nonNullEntry.negativeKeywords);
  const negativeDomainMatches = matchWordsInDomain(domain, singleWordItems(nonNullEntry.negativeKeywords));
  const negativeDescriptionMatches = matchPhrasesInText(input.description, nonNullEntry.negativeKeywords);
  const allNegativeMatches = [...new Set([...negativeNameMatches, ...negativeDomainMatches, ...negativeDescriptionMatches])];
  if (allNegativeMatches.length > 0) {
    // MISMATCH, no REJECTED estructural -- hay evidencia POSITIVA de que
    // el candidato es un tipo de negocio distinto al pedido (ver F34,
    // BusinessValidationStatus arriba), no un fallo de forma.
    return buildEmptyResult("MISMATCH", [
      `Evidencia negativa para "${nonNullEntry.label}": coincide con ${allNegativeMatches.map((m) => `"${m}"`).join(", ")}.`,
    ]);
  }

  // Google Places (y proveedores similares) devuelven categorías como
  // slugs con guion bajo (ej. "general_contractor", "hvac_contractor")
  // -- se normalizan a espacios antes de comparar contra las frases
  // humanas de la taxonomía ("general contractor"), sin lo cual nunca
  // matchearían pese a ser evidencia real y directa.
  const providerTypesText = input.providerTypes.map((t) => t.replace(/_/g, " ")).join(" ");

  // F28 (validación de industria para roofing, hallazgo real
  // 2026-07-27): un candidato encontrado vía una entrada GENÉRICA
  // (isGenericFallback=true, ej. "construction") cuando la misión
  // TAMBIÉN pidió un trade específico (ej. "roofing") nunca se acepta
  // solo por matchear el bucket amplio -- exige evidencia real de al
  // menos uno de esos trades específicos (nombre/categoría de Google
  // Places/descripción), la misma señal que ya usa el resto de esta
  // función, aplicada contra las entradas específicas en vez de la
  // genérica que encontró al candidato.
  //
  // F32: mismo criterio ahora también para missionLiteralTerms -- un
  // término de tipo de empresa sin entrada curada en la taxonomía
  // (ej. "low voltage contractor") es una petición igual de específica
  // que un tradeKey real, y debe defender igual contra contaminación de
  // un bucket amplio.
  if (nonNullEntry.isGenericFallback && (input.missionSpecificTaxonomyKeys.length > 0 || input.missionLiteralTerms.length > 0)) {
    const specificEntries = input.missionSpecificTaxonomyKeys.map((key) => getTaxonomyEntry(key)).filter((e): e is BusinessTaxonomyEntry => e !== undefined);
    const hasSpecificTradeEvidence = specificEntries.some(
      (specificEntry) =>
        matchPhrasesInText(input.candidateName, specificEntry.companyTypes).length > 0 ||
        matchPhrasesInText(providerTypesText, specificEntry.companyTypes).length > 0 ||
        matchPhrasesInText(input.description, specificEntry.websitePhrases).length > 0,
    );
    const hasLiteralTermEvidence = input.missionLiteralTerms.some(
      (term) =>
        matchPhrasesInText(input.candidateName, [term]).length > 0 ||
        matchPhrasesInText(providerTypesText, [term]).length > 0 ||
        matchPhrasesInText(input.description, [term]).length > 0,
    );
    if (!hasSpecificTradeEvidence && !hasLiteralTermEvidence) {
      const requestedLabels = [...specificEntries.map((e) => e.label), ...input.missionLiteralTerms];
      // MISMATCH -- el candidato pertenece al bucket amplio (evidencia
      // real de ESO), pero no al trade específico pedido (ver F34).
      return buildEmptyResult("MISMATCH", [
        `Encontrada vía una query genérica ("${nonNullEntry.label}"), pero la misión pidió específicamente: ${requestedLabels.join(", ")} -- sin ninguna evidencia real de esos trades (nombre, categoría de Google Places, o descripción del sitio).`,
      ]);
    }
  }

  const nameMatches = matchPhrasesInText(input.candidateName, nonNullEntry.companyTypes);
  const providerTypeMatches = matchPhrasesInText(providerTypesText, nonNullEntry.companyTypes);
  const domainMatches = matchWordsInDomain(domain, singleWordItems(nonNullEntry.companyTypes));
  const descriptionMatches = matchPhrasesInText(input.description, nonNullEntry.websitePhrases);
  const businessActivityMatches = matchPhrasesInText(input.businessActivities.join(" "), nonNullEntry.companyTypes);

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

  const missingEvidence = confidence === "EXACT" ? [] : nonNullEntry.validations;

  return {
    accepted: true,
    status: statusForConfidence(confidence),
    confidence,
    confidenceScore: CONFIDENCE_SCORE_BY_LEVEL[confidence],
    detectedBusinessType: nonNullEntry.companyTypes[0] ?? null,
    detectedSector: nonNullEntry.crmIndustryBucket,
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
