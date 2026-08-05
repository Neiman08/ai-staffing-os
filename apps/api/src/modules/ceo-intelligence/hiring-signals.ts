import { normalizeText, containsWord } from "./text-normalize";

/**
 * F7.5: Hiring Signal Intelligence -- puro, determinista, sin Prisma/
 * fetch/LLM (mismo criterio que el resto de ceo-intelligence/). Nunca
 * crawlea nada por su cuenta -- recibe el texto YA bajado por Website
 * Intelligence (crawler.ts, F7.5 lo extendió aditivamente con
 * `pageTexts`, ver ese módulo) y solo evalúa evidencia textual real
 * contra target job titles / taxonomy job titles / frases genéricas de
 * contratación. Nunca scraping abusivo ni evasión de bloqueos -- si
 * Website Intelligence no pudo crawlear (sin website, bloqueado por
 * robots.txt, cancelado), el resultado es honestamente BLOCKED/UNKNOWN,
 * nunca se inventa una señal.
 */

export const HIRING_SIGNAL_VERSION = 1;

export const hiringStatusValues = [
  "CONFIRMED_HIRING",
  "LIKELY_HIRING",
  "POSSIBLE_HIRING",
  "NO_SIGNAL",
  "BLOCKED",
  "UNKNOWN",
] as const;
export type HiringStatus = (typeof hiringStatusValues)[number];

// Frases genéricas de contratación -- vocabulario cerrado, español +
// inglés, evidencia real de que un sitio anuncia que está contratando
// SIN necesitar coincidir con un título específico.
const GENERIC_HIRING_PHRASES = [
  "now hiring",
  "we're hiring",
  "we are hiring",
  "join our team",
  "apply now",
  "apply today",
  "open positions",
  "career opportunities",
  "now accepting applications",
  "immediate openings",
  "hiring now",
  "current openings",
  "job openings",
  "estamos contratando",
  "unete a nuestro equipo",
  "aplica ahora",
  "vacantes disponibles",
];

// F34 (auditoría arquitectónica transversal, hallazgo real: "Apex
// Landscaping Inc"/"A.M. Woodland Outdoor Design" recibieron
// hiringSignalLevel="possible" únicamente porque la palabra "Maintenance"
// aparecía en su sitio como SERVICIO QUE LA EMPRESA VENDE, no como
// vacante -- el matching anterior contaba cualquier mención de un
// targetJobTitle en CUALQUIER página como evidencia de contratación, sin
// distinguir "el sitio anuncia un puesto" de "el sitio describe un
// servicio que coincide de casualidad con el nombre de un puesto"
// (maintenance/cleaning/installation/repair/service son, a la vez,
// nombres de servicio Y de puesto). Fix estructural: un match de título
// solo cuenta como señal de contratación real si aparece en la página de
// careers, O si tiene contexto de intención laboral CERCANO en el mismo
// texto (ver HIRING_INTENT_CONTEXT_WORDS/hasNearbyHiringContext) --
// nunca por aparecer solo, sin importar cuán específico sea el título.
const HIRING_INTENT_CONTEXT_WORDS = [
  "hiring",
  "careers",
  "career",
  "join our team",
  "join the team",
  "apply",
  "application",
  "open position",
  "open positions",
  "now hiring",
  "job opening",
  "job openings",
  "position available",
  "positions available",
  "help wanted",
  "employment opportunity",
  "job posting",
  "job board",
  "vacancy",
  "vacancies",
  "we are looking for",
  "we're looking for",
  "join us",
  "full-time",
  "part-time",
  "shift",
  "salary",
  "benefits package",
  "contratando",
  "vacante",
  "vacantes",
  "empleo",
  "empleos",
  "trabaja con nosotros",
  "unete a nuestro equipo",
  "oportunidad laboral",
  "bolsa de trabajo",
  "postula",
  "postulate",
  "aplica",
  "reclutamiento",
];

// Marcadores de que la mención está en un job posting real (no solo
// "contexto de contratación" ambiguo) -- ATS/job board conocidos, o
// estructura típica de posting (fecha + ubicación + "apply").
const JOB_POSTING_MARKERS = [
  "indeed.com",
  "linkedin.com/jobs",
  "ziprecruiter",
  "greenhouse.io",
  "lever.co",
  "workday",
  "icims",
  "applytojob",
  "job id",
  "req id",
  "requisition",
  "apply by",
  "posted on",
  "date posted",
];

const CONTEXT_WINDOW_CHARS = 200;

/** Todas las posiciones (índice, largo) donde `needle` aparece en `haystack` con límite de palabra real -- mismo criterio que containsWord, pero devuelve dónde, no solo si. */
function findWordOccurrences(haystack: string, needle: string): Array<{ index: number; length: number }> {
  const trimmed = needle.trim();
  if (!trimmed) return [];
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^a-z0-9])(${escaped}s?)(?:$|[^a-z0-9])`, "gi");
  const occurrences: Array<{ index: number; length: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(haystack)) !== null) {
    const word = match[1];
    if (!word) continue;
    const start = match.index + match[0].indexOf(word);
    occurrences.push({ index: start, length: word.length });
    re.lastIndex = start + word.length;
  }
  return occurrences;
}

function windowAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTEXT_WINDOW_CHARS);
  const end = Math.min(text.length, index + length + CONTEXT_WINDOW_CHARS);
  return text.slice(start, end);
}

function hasNearbyHiringContext(text: string, index: number, length: number): boolean {
  const window = windowAround(text, index, length);
  return HIRING_INTENT_CONTEXT_WORDS.some((word) => containsWord(window, normalizeText(word)));
}

function hasNearbyJobPostingMarker(text: string, index: number, length: number): boolean {
  const window = windowAround(text, index, length);
  return JOB_POSTING_MARKERS.some((marker) => containsWord(window, normalizeText(marker)));
}

// F34: clasificación de evidencia pedida explícitamente por la auditoría
// -- reemplaza el matching binario "¿el título aparece en el texto?" por
// una jerarquía honesta de qué tan fuerte es la evidencia de que
// REALMENTE hay una vacante, no solo una coincidencia de palabra.
export const hiringEvidenceClassifications = [
  "CONFIRMED_JOB_POSTING",
  "CAREERS_PAGE_WITH_OPEN_ROLES",
  "RECURRING_HIRING_EVIDENCE",
  "POSSIBLE_HIRING_CONTEXT",
  "SERVICE_MENTION_ONLY",
] as const;
export type HiringEvidenceClassification = (typeof hiringEvidenceClassifications)[number];

export interface ClassifiedHiringEvidence {
  title: string;
  url: string;
  classification: HiringEvidenceClassification;
  snippet: string;
}

export interface HiringSignalPageText {
  url: string;
  text: string;
}

export interface HiringSignalInput {
  companyId: string;
  // false = Company nunca tuvo website conocido -- ni siquiera se intentó crawlear.
  hasWebsite: boolean;
  // true = Website Intelligence corrió pero robots.txt bloqueó todo, o se canceló a mitad de camino.
  crawlBlocked: boolean;
  hasCareersPage: boolean;
  careersPageUrl: string | null;
  pageTexts: HiringSignalPageText[];
  // StructuredIntent.targetJobTitles (F7.1) -- los puestos que la misión pidió encontrar.
  targetJobTitles: string[];
  // BusinessTaxonomyEntry.jobTitles de la taxonomyKey que originó esta Company.
  taxonomyJobTitles: string[];
}

export interface HiringSignalResult {
  companyId: string;
  hiringStatus: HiringStatus;
  confidence: number;
  targetTitlesMatched: string[];
  // Aproximación honesta: cantidad de títulos DISTINTOS (target o de
  // taxonomía) con evidencia textual real -- nunca un conteo real de
  // vacantes de un ATS (F7.5 no integra ningún ATS todavía).
  openingsFound: number;
  evidence: string[];
  sourceUrls: string[];
  providersUsed: string[];
  checkedAt: string;
  warnings: string[];
  limitations: string[];
  signalVersion: number;
  // F34: evidencia clasificada por fuerza real -- incluye TAMBIÉN los
  // matches descartados (SERVICE_MENTION_ONLY) para que quede visible
  // por qué NO cuentan como señal (auditable, nunca oculto). Nunca
  // reemplaza a `evidence`/`hiringStatus` (compatibilidad hacia atrás
  // para los 14 consumidores existentes) -- es información adicional.
  classifiedEvidence: ClassifiedHiringEvidence[];
  // Títulos que SOLO aparecieron como mención de servicio (sin contexto
  // de intención laboral cercano, sin estar en la página de careers) --
  // nunca cuentan hacia targetTitlesMatched/hiringStatus, pero quedan
  // visibles acá para que un humano pueda revisar la evidencia cruda.
  serviceMentionsExcluded: string[];
}

const CONFIDENCE_BY_STATUS: Record<HiringStatus, number> = {
  CONFIRMED_HIRING: 0.9,
  LIKELY_HIRING: 0.7,
  POSSIBLE_HIRING: 0.4,
  NO_SIGNAL: 0.1,
  BLOCKED: 0,
  UNKNOWN: 0,
};

const STANDARD_LIMITATIONS = [
  "No integra ningún ATS (Applicant Tracking System) real -- openingsFound es una aproximación de títulos con evidencia textual, no un conteo real de vacantes.",
  "Nunca crawlea por su cuenta -- reutiliza exclusivamente el texto ya bajado por Website Intelligence para esta Company (mismo crawl usado para Email Trust, nunca un segundo request al mismo sitio).",
];

function buildEmptyResult(companyId: string, status: HiringStatus, warnings: string[]): HiringSignalResult {
  return {
    companyId,
    hiringStatus: status,
    confidence: CONFIDENCE_BY_STATUS[status],
    targetTitlesMatched: [],
    openingsFound: 0,
    evidence: [],
    sourceUrls: [],
    providersUsed: [],
    checkedAt: new Date().toISOString(),
    warnings,
    limitations: STANDARD_LIMITATIONS,
    signalVersion: HIRING_SIGNAL_VERSION,
    classifiedEvidence: [],
    serviceMentionsExcluded: [],
  };
}

/**
 * Evalúa evidencia de contratación real para una Company ya crawleada.
 * Determinista: mismo input siempre produce el mismo resultado.
 *
 * F34: un match de título ya NO cuenta automáticamente como señal --
 * debe estar en la página de careers, O tener contexto de intención
 * laboral cercano en el mismo texto (ver hasNearbyHiringContext). Un
 * match sin ninguno de los dos se clasifica SERVICE_MENTION_ONLY y NUNCA
 * cuenta hacia targetTitlesMatched/hiringStatus -- el bug real que esto
 * corrige: "Maintenance" mencionado en la página de servicios de una
 * empresa de landscaping (el servicio que VENDE, no una vacante) inflaba
 * hiringStatus a POSSIBLE_HIRING sin evidencia real de contratación.
 */
export function evaluateHiringSignals(input: HiringSignalInput): HiringSignalResult {
  if (!input.hasWebsite) {
    return buildEmptyResult(input.companyId, "BLOCKED", ["Company sin website conocido -- no se pudo verificar ninguna señal de contratación."]);
  }
  if (input.crawlBlocked) {
    return buildEmptyResult(input.companyId, "BLOCKED", ["El crawl de Website Intelligence fue bloqueado (robots.txt) o cancelado -- ninguna señal verificable."]);
  }
  if (input.pageTexts.length === 0) {
    return buildEmptyResult(input.companyId, "UNKNOWN", ["Website Intelligence no devolvió texto de ninguna página -- no se pudo evaluar evidencia."]);
  }

  const candidateTitles = Array.from(new Set([...input.targetJobTitles, ...input.taxonomyJobTitles].filter((t) => t.trim())));
  const targetTitlesMatched = new Set<string>();
  const serviceMentionsExcluded = new Set<string>();
  const evidence: string[] = [];
  const classifiedEvidence: ClassifiedHiringEvidence[] = [];
  const sourceUrls = new Set<string>();
  let genericPhraseMatched = false;

  for (const page of input.pageTexts) {
    // F34: normalizeText no preserva el largo del texto original 1:1 en
    // todos los casos (NFD + strip de diacríticos puede acortar), así
    // que las posiciones de match se calculan sobre el texto YA
    // normalizado, y la ventana de contexto también se toma del mismo
    // texto normalizado -- nunca se mezclan índices de dos strings
    // distintos.
    const normalizedText = normalizeText(page.text);
    const isCareersPage = input.hasCareersPage && input.careersPageUrl !== null && page.url === input.careersPageUrl;

    for (const title of candidateTitles) {
      const occurrences = findWordOccurrences(normalizedText, normalizeText(title));
      for (const occ of occurrences) {
        const hasContext = isCareersPage || hasNearbyHiringContext(normalizedText, occ.index, occ.length);
        const hasPostingMarker = hasNearbyJobPostingMarker(normalizedText, occ.index, occ.length);
        const snippet = windowAround(page.text, occ.index, occ.length).trim();

        let classification: HiringEvidenceClassification;
        if (!hasContext) {
          classification = "SERVICE_MENTION_ONLY";
          serviceMentionsExcluded.add(title);
        } else if (hasPostingMarker) {
          classification = "CONFIRMED_JOB_POSTING";
          targetTitlesMatched.add(title);
        } else if (isCareersPage) {
          classification = "CAREERS_PAGE_WITH_OPEN_ROLES";
          targetTitlesMatched.add(title);
        } else {
          classification = "POSSIBLE_HIRING_CONTEXT";
          targetTitlesMatched.add(title);
        }

        classifiedEvidence.push({ title, url: page.url, classification, snippet });
        if (classification !== "SERVICE_MENTION_ONLY") {
          evidence.push(`"${title}" mencionado en ${page.url} con contexto de intención laboral (${classification})`);
          sourceUrls.add(page.url);
        }
      }
    }

    for (const phrase of GENERIC_HIRING_PHRASES) {
      if (containsWord(normalizedText, normalizeText(phrase))) {
        genericPhraseMatched = true;
        evidence.push(`Frase de contratación "${phrase}" encontrada en ${page.url}`);
        classifiedEvidence.push({
          title: phrase,
          url: page.url,
          classification: "RECURRING_HIRING_EVIDENCE",
          snippet: phrase,
        });
        sourceUrls.add(page.url);
      }
    }
  }

  if (input.hasCareersPage && input.careersPageUrl) sourceUrls.add(input.careersPageUrl);

  let hiringStatus: HiringStatus;
  if (input.hasCareersPage && targetTitlesMatched.size > 0) {
    hiringStatus = "CONFIRMED_HIRING";
  } else if (input.hasCareersPage && genericPhraseMatched) {
    hiringStatus = "LIKELY_HIRING";
  } else if (targetTitlesMatched.size > 0 || genericPhraseMatched) {
    hiringStatus = "POSSIBLE_HIRING";
  } else {
    hiringStatus = "NO_SIGNAL";
  }

  const warnings: string[] = [];
  if (!input.hasCareersPage) warnings.push("No se detectó una página de careers/jobs dedicada -- evidencia limitada al texto general del sitio.");
  if (serviceMentionsExcluded.size > 0) {
    warnings.push(
      `${serviceMentionsExcluded.size} término(s) mencionados sin contexto de intención laboral cercano (probable servicio ofrecido, no vacante) -- excluidos de la señal de contratación: ${Array.from(serviceMentionsExcluded).join(", ")}.`,
    );
  }

  return {
    companyId: input.companyId,
    hiringStatus,
    confidence: CONFIDENCE_BY_STATUS[hiringStatus],
    targetTitlesMatched: Array.from(targetTitlesMatched),
    openingsFound: targetTitlesMatched.size,
    evidence,
    sourceUrls: Array.from(sourceUrls),
    providersUsed: ["Website Intelligence"],
    checkedAt: new Date().toISOString(),
    warnings,
    limitations: STANDARD_LIMITATIONS,
    signalVersion: HIRING_SIGNAL_VERSION,
    classifiedEvidence,
    serviceMentionsExcluded: Array.from(serviceMentionsExcluded),
  };
}
