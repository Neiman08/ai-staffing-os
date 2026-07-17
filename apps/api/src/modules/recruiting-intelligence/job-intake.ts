import { detectCitiesAndStates } from "../ceo-intelligence/geo";
import { normalizeText, containsWord } from "../ceo-intelligence/text-normalize";

/**
 * F8.1: Job Intake Intelligence -- puro, determinista, sin Prisma/
 * fetch/LLM (mismo criterio que ceo-intelligence/). Convierte una
 * instrucción de intake en lenguaje natural (ej. "Necesito 5 Forklift
 * Operators en Chicago, turno de noche, $19-22/hr, empiezan el lunes,
 * requieren certificación de forklift") en campos estructurados --
 * nunca inventa un valor: todo lo que no matchea contra datos reales
 * (JobCategory/DocumentType ya existentes en el tenant, pasados como
 * input) o un patrón textual explícito queda `null`/vacío y se reporta
 * en `ambiguities`, nunca se adivina.
 */

export const JOB_INTAKE_VERSION = 1;

export const jobIntakeShifts = ["DAY", "NIGHT", "WEEKEND", "ROTATING"] as const;
export type JobIntakeShift = (typeof jobIntakeShifts)[number];

export const jobIntakeUrgencies = ["LOW", "MEDIUM", "HIGH"] as const;
export type JobIntakeUrgency = (typeof jobIntakeUrgencies)[number];

export interface KnownJobCategory {
  id: string;
  name: string;
  industryName: string | null;
}

export interface KnownDocumentType {
  key: string;
  name: string;
  category: string; // "identity" | "tax" | "safety" | "certification" | "screening"
}

export interface JobIntakeInput {
  rawInstruction: string;
  knownJobCategories: KnownJobCategory[];
  knownDocumentTypes: KnownDocumentType[];
}

export interface JobIntakePayRate {
  min: number | null;
  max: number | null;
}

export interface JobIntakeResult {
  jobTitle: string | null;
  normalizedTitle: string | null;
  matchedCategoryId: string | null;
  industry: string | null;
  city: string | null;
  state: string | null;
  headcount: number | null;
  shift: JobIntakeShift | null;
  payRate: JobIntakePayRate | null;
  schedule: string | null;
  experienceRequired: string | null;
  certifications: string[];
  complianceRequirements: string[];
  skills: string[];
  languages: string[];
  startDate: string | null;
  urgency: JobIntakeUrgency | null;
  exclusions: string[];
  ambiguities: string[];
  confidence: number;
  intakeVersion: number;
}

const EXCLUSION_CLAUSE_RE = /\b(?:exclu(?:ye|ir|yendo|sion(?:es)?)|except(?:ing)?|but exclude|no incluir)\b\s*:?\s*([^.;]+)/gi;
const SPLIT_LIST_RE = /\s*,\s*|\s+y\s+|\s+and\s+|\s+o\s+|\s+or\s+/i;

function extractExclusions(rawInstruction: string): { exclusions: string[]; positiveText: string } {
  const exclusions = new Set<string>();
  let positiveText = rawInstruction;
  for (const match of rawInstruction.matchAll(EXCLUSION_CLAUSE_RE)) {
    const clause = match[1] ?? "";
    for (const term of clause.split(SPLIT_LIST_RE).map((t) => t.trim()).filter(Boolean)) exclusions.add(term);
    const start = match.index ?? 0;
    positiveText = positiveText.slice(0, start) + " ".repeat(match[0].length) + positiveText.slice(start + match[0].length);
  }
  return { exclusions: Array.from(exclusions), positiveText };
}

function detectHeadcount(text: string): number | null {
  const match = text.match(/\b(\d{1,3})\s*(?:workers?|empleados|trabajadores|personas|people|candidates?|candidatos?|operators?|operadores?)\b/i);
  if (match) return Number(match[1]);
  // "Necesito 5 Forklift Operators" -- número seguido de un título, sin
  // palabra explícita de cantidad entre medio.
  const bare = text.match(/\b(\d{1,3})\b/);
  return bare ? Number(bare[1]) : null;
}

const SHIFT_PATTERNS: Array<{ shift: JobIntakeShift; keywords: string[] }> = [
  { shift: "NIGHT", keywords: ["night shift", "night", "turno de noche", "turno nocturno", "noche"] },
  { shift: "WEEKEND", keywords: ["weekend", "fin de semana", "fines de semana"] },
  { shift: "ROTATING", keywords: ["rotating", "rotativo", "turnos rotativos"] },
  { shift: "DAY", keywords: ["day shift", "turno de dia", "turno diurno", "dia"] },
];

function detectShift(normalized: string): JobIntakeShift | null {
  for (const { shift, keywords } of SHIFT_PATTERNS) {
    if (keywords.some((k) => containsWord(normalized, normalizeText(k)))) return shift;
  }
  return null;
}

function detectPayRate(text: string): JobIntakePayRate | null {
  // Rango: "$18-22/hr", "$18 - $22 por hora", "entre $18 y $22 la hora".
  const range = text.match(/\$?\s*(\d{1,3}(?:\.\d{1,2})?)\s*(?:-|a|to|y)\s*\$?\s*(\d{1,3}(?:\.\d{1,2})?)\s*(?:\/\s*(?:hr|hour|h)|por hora|la hora|\/hora)?/i);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  // Valor único: "$19/hr", "$19 por hora".
  const single = text.match(/\$\s*(\d{1,3}(?:\.\d{1,2})?)\s*(?:\/\s*(?:hr|hour|h)|por hora|la hora|\/hora)?/i);
  if (single) return { min: Number(single[1]), max: Number(single[1]) };
  return null;
}

const URGENCY_PATTERNS: Array<{ urgency: JobIntakeUrgency; keywords: string[] }> = [
  { urgency: "HIGH", keywords: ["urgent", "urgente", "asap", "inmediato", "immediately", "cuanto antes"] },
  { urgency: "MEDIUM", keywords: ["soon", "pronto", "en los proximos dias", "próximamente"] },
];

function detectUrgency(normalized: string): JobIntakeUrgency | null {
  for (const { urgency, keywords } of URGENCY_PATTERNS) {
    if (keywords.some((k) => containsWord(normalized, normalizeText(k)))) return urgency;
  }
  return null;
}

const KNOWN_LANGUAGES = ["English", "Spanish", "Ingles", "Espanol", "Português", "Portugues"];

function detectLanguages(normalized: string): string[] {
  const found = new Set<string>();
  for (const lang of KNOWN_LANGUAGES) {
    if (containsWord(normalized, normalizeText(lang))) {
      // Normaliza variantes sin acento al nombre canónico en inglés.
      if (lang.startsWith("Ingl") || lang === "English") found.add("English");
      else if (lang.startsWith("Espa") || lang === "Spanish") found.add("Spanish");
      else found.add("Portuguese");
    }
  }
  return Array.from(found);
}

function detectExperience(text: string): string | null {
  const match = text.match(/\b(\d{1,2})\+?\s*(?:years?|años|anos)\s*(?:of|de)?\s*(?:experience|experiencia)\b/i);
  return match ? `${match[1]}+ años de experiencia` : null;
}

function detectStartDate(text: string): string | null {
  // Fecha explícita ISO o dd/mm/yyyy -- nunca se interpreta "next
  // Monday"/"el lunes" como fecha real (eso requeriría saber "hoy", que
  // esta función no recibe -- mantenerla pura y determinista).
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso?.[1]) return iso[1];
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash?.[1] && slash[2] && slash[3]) return `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  return null;
}

export function interpretJobIntake(input: JobIntakeInput): JobIntakeResult {
  const { exclusions, positiveText } = extractExclusions(input.rawInstruction);
  const normalized = normalizeText(positiveText);

  // Título/categoría: matchea SOLO contra JobCategory reales del tenant
  // (nunca inventa un título ni una categoría nueva) -- el más largo que
  // matchea gana, para preferir "Journeyman Electrician" sobre
  // "Electrician" si ambos están en el catálogo y ambos matchean.
  const matchedCategories = input.knownJobCategories
    .filter((c) => containsWord(normalized, normalizeText(c.name)))
    .sort((a, b) => b.name.length - a.name.length);
  const matchedCategory = matchedCategories[0] ?? null;

  const matchedDocumentTypes = input.knownDocumentTypes.filter((d) => containsWord(normalized, normalizeText(d.name)));
  const certifications = matchedDocumentTypes.filter((d) => d.category === "certification").map((d) => d.name);
  const complianceRequirements = matchedDocumentTypes.map((d) => d.key);

  const { cities, states } = detectCitiesAndStates(positiveText);
  const headcount = detectHeadcount(positiveText);
  const shift = detectShift(normalized);
  const payRate = detectPayRate(positiveText);
  const urgency = detectUrgency(normalized);
  const languages = detectLanguages(normalized);
  const experienceRequired = detectExperience(positiveText);
  const startDate = detectStartDate(positiveText);

  const ambiguities: string[] = [];
  if (!matchedCategory) {
    ambiguities.push("No se pudo identificar ningún título/categoría de puesto real del catálogo (JobCategory) en la instrucción.");
  }
  if (cities.length === 0 && states.length === 0) {
    ambiguities.push("No se detectó ubicación (ciudad/estado) en la instrucción.");
  }
  if (headcount === null) {
    ambiguities.push("No se detectó cantidad de trabajadores requeridos.");
  }
  if (!shift) {
    ambiguities.push("No se especificó turno (día/noche/fin de semana/rotativo).");
  }
  if (!payRate) {
    ambiguities.push("No se detectó tarifa de pago.");
  }
  if (!startDate) {
    ambiguities.push("No se detectó una fecha de inicio explícita (solo se reconocen fechas literales, nunca expresiones relativas como 'el lunes').");
  }

  let confidence = 1;
  if (!matchedCategory) confidence = 0.2;
  else {
    const gaps = [cities.length === 0 && states.length === 0, headcount === null, !shift, !payRate].filter(Boolean).length;
    confidence = Math.max(0.3, 1 - gaps * 0.15);
  }

  return {
    jobTitle: matchedCategory?.name ?? null,
    normalizedTitle: matchedCategory?.name ?? null,
    matchedCategoryId: matchedCategory?.id ?? null,
    industry: matchedCategory?.industryName ?? null,
    city: cities[0] ?? null,
    state: states[0] ?? null,
    headcount,
    shift,
    payRate,
    schedule: null,
    experienceRequired,
    certifications,
    complianceRequirements,
    skills: [],
    languages,
    startDate,
    urgency,
    exclusions,
    ambiguities,
    confidence,
    intakeVersion: JOB_INTAKE_VERSION,
  };
}
