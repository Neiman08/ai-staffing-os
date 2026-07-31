import type { MissionRestrictions } from "@ai-staffing-os/agents";
import { DEFAULT_MISSION_RESTRICTIONS, mergeMissionRestrictions } from "@ai-staffing-os/agents";
import type { MissionObjective, MissionPlanStep, StructuredIntent, BusinessTaxonomyEntry } from "./contracts";
import { BUSINESS_TAXONOMY } from "./taxonomy";
import { detectCitiesAndStates } from "./geo";
import { containsWord, normalizeText } from "./text-normalize";
import { detectCriticalInfrastructureClients } from "./critical-infrastructure-clients";
import { classifyNonIndustryTerm } from "./semantic-normalization";

// F32 (auditoría arquitectónica, hallazgo real MIS-20260731-0002/0003,
// 2026-07-31 -- ver docs de la investigación): "HVAC, refrigeración
// comercial y servicios mecánicos" no matcheaba NINGUNA entrada de
// BUSINESS_TAXONOMY -> matchedTaxonomyKeys=[] -> hasCompanyContext=false
// -> el objetivo caía a find_contacts y discover_companies desaparecía
// del plan por completo, pese a que la instrucción decía explícitamente
// "Busca hasta 20 empresas nuevas... dedicadas a HVAC...". El bug real
// no era "HVAC falta en la taxonomía" (agregarlo solo resolvería HVAC,
// nunca la clase general) -- era que el intérprete solo sabía tratar un
// término como "tipo de empresa real" si coincidía con un sinónimo ya
// cerrado. Este módulo ahora distingue explícitamente "el usuario pidió
// buscar empresas" (independiente de si la taxonomía reconoce el rubro)
// de "qué tan bien entendemos el rubro pedido" -- lo segundo nunca debe
// poder apagar lo primero.
// F32: acotado deliberadamente a "empresas/compañías/negocios/
// contratistas/fabricantes" (los sinónimos de "empresa" que ya usa el
// resto de este archivo, ver KNOWN_PROVIDERS más abajo para el
// significado NO relacionado de "proveedor" en este dominio -- Hunter/
// PDL/Google Places, nunca una empresa objetivo) -- "proveedores"/
// "vendors"/"suppliers" quedan afuera a propósito: son ambiguos fuera
// del dominio real de este producto (buscar empresas que necesiten
// staffing) y romperían el caso de ambigüedad genuina ya cubierto por
// intent-interpreter.test.ts ("Busca proveedores de software
// empresarial." debe seguir siendo ambiguo, nunca un falso positivo).
// F32 (bugfix de acentos): evaluado contra texto YA normalizado
// (normalizeText -- minúsculas, sin acentos/diéresis/eñe, ver el
// llamado más abajo), nunca contra el texto crudo -- "compañías" nunca
// matcheaba "compan[ií]as?" porque la "ñ" no es una "n" para un regex
// literal (hallazgo real: "Encuentra compañías de..." no disparaba el
// detector).
const FIND_COMPANIES_VERB_RE =
  /\b(?:busca|buscar|encuentra|encontrar|identifica|identificar|localiza|localizar)\b[^.;]{0,40}\b(?:empresas?|companias?|negocios?|contratistas?|fabricantes?)\b|\b(?:find|search\s+for|identify|locate)\b[^.;]{0,40}\b(?:companies|businesses|contractors|manufacturers)\b/i;

// F32: dispara la extracción de "tipos de empresa literales" -- términos
// que el usuario nombró explícitamente como el rubro/actividad buscada,
// sin importar si BUSINESS_TAXONOMY los reconoce. Vocabulario de
// disparadores cerrado (son conectores gramaticales, no industrias), el
// TEXTO capturado después del disparador es completamente abierto.
const COMPANY_TYPE_TRIGGER_RE =
  /\b(?:dedicad[oa]s?\s+a|empresas?\s+de|compa[nñ][ií]as?\s+de|negocios?\s+de|del\s+rubro\s+de|del\s+sector\s+de|companies?\s+(?:specializing\s+in|in\s+the\s+field\s+of|that\s+do|dedicated\s+to|of)|in\s+the\s+(?:field|sector|industry)\s+of)\b\s*:?\s*([^.;]+?)(?=\s+\b(?:que|that|which|quienes)\b|[.;]|$)/gi;

/**
 * F32: extrae candidatos a "tipo de empresa" que el usuario nombró
 * explícitamente pero que NINGUNA entrada de BUSINESS_TAXONOMY reconoce
 * todavía -- nunca se descartan en silencio (a diferencia del
 * comportamiento anterior). `modelProposedTerms` (opcional, ver
 * interpretBusinessIntent) tiene prioridad -- cuando existe un LLM
 * upstream (interpretDailyDirective/ceo-tools.impl.ts) que ya separó la
 * instrucción en frases de búsqueda listas para un proveedor (una por
 * cada rubro nombrado, ya traducidas a inglés cuando corresponde), se
 * usan esas -- la extracción determinista de acá es solo el respaldo
 * para cuando no hay ningún modelo upstream (tests directos, misiones
 * dinámicas sin CEO Tool, etc.), nunca reemplaza al modelo cuando este
 * sí aportó algo. Ambas fuentes pasan por el MISMO filtro: nunca un
 * rol/objeto/acción/capacidad conocida (classifyNonIndustryTerm), nunca
 * un término ya cubierto por un match real de taxonomía.
 */
function extractLiteralCompanyTypeTerms(
  positiveText: string,
  matchedEntries: BusinessTaxonomyEntry[],
  modelProposedTerms: string[],
): string[] {
  const candidates = new Set<string>();
  for (const term of modelProposedTerms) {
    const trimmed = term.trim();
    if (trimmed) candidates.add(trimmed);
  }
  for (const match of positiveText.matchAll(COMPANY_TYPE_TRIGGER_RE)) {
    const clause = match[1] ?? "";
    for (const term of clause.split(SPLIT_LIST_RE)) {
      const trimmed = term.trim();
      if (trimmed) candidates.add(trimmed);
    }
  }

  const normalizedMatchedSynonyms = matchedEntries.flatMap((entry) => entry.synonyms.map((syn) => normalizeText(syn)));

  return Array.from(candidates).filter((term) => {
    if (classifyNonIndustryTerm(term) !== null) return false;
    const normalizedTerm = normalizeText(term);
    const alreadyCoveredByTaxonomy = normalizedMatchedSynonyms.some(
      (syn) => containsWord(normalizedTerm, syn) || containsWord(syn, normalizedTerm),
    );
    return !alreadyCoveredByTaxonomy;
  });
}

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
  literalCompanyTypeTerms: string[],
  explicitFindCompaniesVerb: boolean,
): MissionObjective {
  const targetCompanyCount = detectObjectiveTargetCount(rawInstruction);
  const hasCompanyContext = companyTypes.length > 0 || industries.length > 0 || literalCompanyTypeTerms.length > 0;

  // F32: el caso real (MIS-20260731-0002: "Busca hasta 20 empresas...
  // dedicadas a HVAC...") ya queda resuelto arriba -- literalCompanyTypeTerms
  // hace hasCompanyContext=true sin depender de este detector de verbo.
  // explicitFindCompaniesVerb es una red de seguridad ADICIONAL, más
  // acotada a propósito: solo actúa quando NINGUNA otra señal real
  // (companyTypes/industries/literalCompanyTypeTerms/targetJobTitles/
  // decisionRoles) dio ninguna pista de qué buscar -- ahí "custom" (sin
  // ningún plan real) es peor que declarar find_companies honestamente.
  // Nunca debe pisar find_contacts/find_hiring_signals cuando SÍ hay una
  // señal real más específica (ej. "Busca empresas que contraten Machine
  // Operators" -- el verbo "busca...empresas" aparece, pero
  // targetJobTitles ya identificó una interpretación más precisa:
  // find_hiring_signals sobre el CRM existente, no un discovery nuevo
  // sin ningún criterio de industria).
  let type: MissionObjective["type"] = "find_companies";
  if (!hasCompanyContext && decisionRoles.length > 0) {
    type = "find_contacts";
  } else if (!hasCompanyContext && targetJobTitles.length > 0) {
    type = "find_hiring_signals";
  } else if (!hasCompanyContext && targetJobTitles.length === 0 && decisionRoles.length === 0) {
    type = explicitFindCompaniesVerb ? "find_companies" : "custom";
  }

  return { type, targetCompanyCount, rawText: rawInstruction };
}

function buildPlannedSteps(intent: {
  companyTypes: string[];
  industries: string[];
  targetJobTitles: string[];
  hiringSignals: string[];
  decisionRoles: string[];
  literalCompanyTypeTerms: string[];
}): MissionPlanStep[] {
  const steps: MissionPlanStep[] = [];
  const hasCompanyContext = intent.companyTypes.length > 0 || intent.industries.length > 0 || intent.literalCompanyTypeTerms.length > 0;

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
 *
 * F32: `modelProposedTerms` es opcional y aditivo -- cuando un llamador
 * ya corrió un paso de interpretación asistida por modelo (ej.
 * interpretDailyDirective/ceo-tools.impl.ts, externalSearchTerms) y
 * quiere que esos términos también cuenten como "tipo de empresa
 * pedido", los pasa acá. La función SIGUE siendo 100% determinista y
 * pura para el mismo input -- el modelo solo puede PROPONER candidatos,
 * nunca decide nada por sí mismo: cada candidato pasa por el mismo
 * filtro (classifyNonIndustryTerm, cobertura de taxonomía ya matcheada)
 * que la extracción determinista de respaldo (ver
 * extractLiteralCompanyTypeTerms). Omitir el parámetro (default [])
 * preserva el comportamiento 100% determinista para callers que no
 * tienen ningún modelo upstream (tests, misiones dinámicas directas).
 */
export function interpretBusinessIntent(rawInstruction: string, modelProposedTerms: string[] = []): StructuredIntent {
  const { exclusions: explicitExclusions, positiveText } = extractExclusions(rawInstruction);
  const normalizedPositive = normalizeText(positiveText);

  const matchedEntries = BUSINESS_TAXONOMY.filter((entry) =>
    entry.synonyms.some((syn) => containsWord(normalizedPositive, normalizeText(syn))),
  );
  const matchedTaxonomyKeys = matchedEntries.map((e) => e.key);

  // F29 (hallazgo real, MIS-20260729-0009, 2026-07-29): "Manufactura",
  // "Warehouses", "Centros de distribución"/"Logística" y "Healthcare no
  // clínico" aparecían como su PROPIO ítem explícito en la instrucción
  // (misma viñeta que "Food processing"/"Packaging"), pero
  // matchedTaxonomyKeys por sí solo no alcanza para saber si un match
  // fue deliberado o incidental -- "construction" también matchea
  // siempre que aparezca la palabra "contractor" (F28, misión real de
  // roofing: "roofing contractor" matcheaba TANTO "roofing" [específico]
  // como "construction" [genérico, vía la palabra suelta "contractor"],
  // sin que el usuario haya pedido construcción general en absoluto).
  //
  // La distinción real: un match de una entrada GENÉRICA
  // (isGenericFallback=true) cuenta como "específicamente pedido" SOLO
  // si al menos uno de sus propios sinónimos matcheados NO es un
  // substring del sinónimo matcheado de NINGUNA OTRA entrada -- ej.
  // "warehouse" (sinónimo propio de warehousing) no es substring de
  // ningún otro match real de esta misión, así que cuenta; "contractor"
  // (sinónimo propio de construction) SÍ es substring del match de
  // roofing ("roofing contractor"), así que no cuenta -- es evidencia
  // subsumida por el trade específico, no un pedido independiente.
  const matchedSynonymsByKey = new Map(
    matchedEntries.map((entry) => [
      entry.key,
      entry.synonyms.filter((syn) => containsWord(normalizedPositive, normalizeText(syn))),
    ]),
  );
  const specificMatchedTaxonomyKeys = matchedEntries
    .filter((entry) => {
      if (!entry.isGenericFallback) return true;
      const ownSynonyms = matchedSynonymsByKey.get(entry.key) ?? [];
      const otherSynonyms = matchedEntries
        .filter((other) => other.key !== entry.key)
        .flatMap((other) => matchedSynonymsByKey.get(other.key) ?? []);
      return ownSynonyms.some((syn) => !otherSynonyms.some((otherSyn) => otherSyn !== syn && otherSyn.includes(syn)));
    })
    .map((e) => e.key);

  // F28 (misión real de Hospitality, 2026-07-28, pedido explícito del
  // PO): "hoteles comerciales" debe EXCLUIR motel/inn/bed and breakfast/
  // guest house de las queries por completo -- no solo despriorizarlos
  // (taxonomy.ts ya los deja al final del orden). Caso especial,
  // deliberadamente acotado a hospitality -- NUNCA una regla genérica de
  // "comercial" para otros trades, ni una exclusión permanente de la
  // taxonomía (una misión sin esta frase sigue buscando motel/inn/B&B
  // normalmente).
  const COMMERCIAL_HOTELS_ONLY_RE = /\bhoteles?\s+comerciales?\b|\bcommercial\s+hotels?\b/i;
  const exclusions =
    matchedTaxonomyKeys.includes("hospitality") && COMMERCIAL_HOTELS_ONLY_RE.test(rawInstruction)
      ? Array.from(new Set([...explicitExclusions, "motel", "inn", "bed and breakfast", "bed & breakfast", "guest house", "guesthouse"]))
      : explicitExclusions;

  const companyTypes = Array.from(new Set(matchedEntries.flatMap((e) => e.companyTypes)));
  const industries = Array.from(
    new Set(matchedEntries.map((e) => e.crmIndustryBucket).filter((b): b is string => b !== null)),
  );
  const businessActivities = Array.from(new Set(matchedEntries.map((e) => e.label)));

  // F32 (hallazgo real, MIS-20260731-0002/0003, 2026-07-31): "tipos de
  // empresa" que el usuario nombró explícitamente pero que
  // BUSINESS_TAXONOMY no reconoce todavía -- nunca se pierden. Ver
  // extractLiteralCompanyTypeTerms para el algoritmo completo (prioriza
  // modelProposedTerms, respaldo determinista vía COMPANY_TYPE_TRIGGER_RE).
  const literalCompanyTypeTerms = extractLiteralCompanyTypeTerms(positiveText, matchedEntries, modelProposedTerms);
  const explicitFindCompaniesVerb = FIND_COMPANIES_VERB_RE.test(normalizedPositive);

  const searchTerms = Array.from(
    new Set([...matchedEntries.flatMap((e) => e.googleSearchPhrases), ...literalCompanyTypeTerms]),
  );

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
  // F15: clientes de infraestructura crítica mencionados literalmente
  // (ej. "QTS", "Meta", "Google") -- nunca un tipo de empresa, se usan
  // en mission-planner.ts para ampliar las search queries hacia
  // "contratistas que trabajan en proyectos de <cliente>".
  const criticalInfrastructureClients = detectCriticalInfrastructureClients(rawInstruction);
  const restrictions: MissionRestrictions = mergeMissionRestrictions(null, rawInstruction);
  const objective = buildObjective(
    rawInstruction,
    companyTypes,
    industries,
    targetJobTitles,
    decisionRoles,
    literalCompanyTypeTerms,
    explicitFindCompaniesVerb,
  );
  const plannedSteps = buildPlannedSteps({
    companyTypes,
    industries,
    targetJobTitles,
    hiringSignals,
    decisionRoles,
    literalCompanyTypeTerms,
  });

  const ambiguities: string[] = [];
  const unsupportedCapabilities: string[] = [];

  if (companyTypes.length === 0 && targetJobTitles.length === 0 && decisionRoles.length === 0 && literalCompanyTypeTerms.length === 0) {
    ambiguities.push(
      "No se pudo identificar ningún tipo de empresa, industria, ni rol/título en la instrucción — no matcheó ninguna entrada de la Business Taxonomy ni se detectó ningún término literal de tipo de empresa.",
    );
  }
  if (companyTypes.length > 0 && industries.length === 0) {
    ambiguities.push(
      "Los tipos de empresa detectados no tienen ninguna Industry real del CRM asociada (crmIndustryBucket=null) — quedarían archivados sin industria real hasta que el PO decida crear una (ver plan F7 §9.4). No es un error del intérprete, es un límite conocido del CRM actual.",
    );
  }
  if (literalCompanyTypeTerms.length > 0) {
    ambiguities.push(
      `Los siguientes términos de tipo de empresa no coinciden con ninguna entrada de la Business Taxonomy — se usarán TAL CUAL como criterio de búsqueda y validación (nunca se descartan, nunca degradan el objetivo): ${literalCompanyTypeTerms.join(", ")}.`,
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
  if (companyTypes.length === 0 && targetJobTitles.length === 0 && decisionRoles.length === 0 && literalCompanyTypeTerms.length === 0) {
    confidence = 0.1;
  } else if (companyTypes.length > 0 && industries.length === 0) {
    confidence = Math.min(confidence, 0.7);
  } else if (literalCompanyTypeTerms.length > 0 && companyTypes.length === 0) {
    // F32: tipo de empresa real pedido, pero sin ningún respaldo de
    // taxonomía (sin companyTypes/websitePhrases/negativeKeywords
    // curados) -- confianza moderada, nunca 0 (el objetivo/plan siguen
    // siendo correctos, la incertidumbre real está en la validación de
    // candidatos, no en la interpretación del pedido).
    confidence = Math.min(confidence, 0.6);
  }
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
    specificMatchedTaxonomyKeys,
    criticalInfrastructureClients,
    literalCompanyTypeTerms,
  };
}
