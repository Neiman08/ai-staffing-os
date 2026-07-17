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
  };
}

/**
 * Evalúa evidencia de contratación real para una Company ya crawleada.
 * Determinista: mismo input siempre produce el mismo resultado.
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
  const evidence: string[] = [];
  const sourceUrls = new Set<string>();
  let genericPhraseMatched = false;

  for (const page of input.pageTexts) {
    const normalizedText = normalizeText(page.text);

    for (const title of candidateTitles) {
      if (containsWord(normalizedText, normalizeText(title))) {
        targetTitlesMatched.add(title);
        evidence.push(`"${title}" mencionado en ${page.url}`);
        sourceUrls.add(page.url);
      }
    }

    for (const phrase of GENERIC_HIRING_PHRASES) {
      if (containsWord(normalizedText, normalizeText(phrase))) {
        genericPhraseMatched = true;
        evidence.push(`Frase de contratación "${phrase}" encontrada en ${page.url}`);
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
  };
}
