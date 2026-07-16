// F6.3: motor de scoring determinista para el matching Job Order <->
// Worker — función PURA (no importa Prisma). Implementa literalmente la
// fórmula v1 aprobada (docs/F6_AUTONOMOUS_RECRUITING_AND_OPERATIONS_PLAN.md
// §7.2-§7.4): 5 filtros duros de elegibilidad, luego 7 factores
// ponderados que suman 100. Sin IA, sin llamadas externas, sin
// atributos protegidos (§7.5) — solo aritmética sobre datos ya
// cargados por el llamador.

import type { AvailabilityStatus, MatchAssessment, MatchEligibility, MatchFactors } from "@ai-staffing-os/shared";

// ---------- Pesos máximos (plan §7.4 — total 100) ----------
export const FACTOR_WEIGHTS = {
  requiredDocuments: 25,
  experience: 20,
  location: 15,
  payRate: 15,
  assignmentHistory: 15,
  languages: 5,
  dataRecency: 5,
} as const;

const KNOWN_WORKER_STATUSES = new Set(["AVAILABLE", "ASSIGNED", "ON_LEAVE", "TERMINATED"]);

export interface DocumentForScoring {
  documentTypeKey: string;
  status: string; // PENDING_REVIEW | VERIFIED | REJECTED | EXPIRED
}

export interface AssignmentHistoryForScoring {
  status: string; // Assignment.status real
  categoryId: string;
  companyId: string;
}

export interface JobOrderForScoring {
  categoryId: string;
  companyId: string;
  requirements: string[]; // keys de DocumentType
  payRate: number;
  location: { city?: string | null; state?: string | null } | null;
}

export interface WorkerScoringInput {
  workerId: string;
  candidateId: string;
  displayName: string;
  workerStatus: string;
  complianceStatus: string;
  defaultPayRate: number;
  candidateCategoryIds: string[];
  yearsExperience: number | null;
  city: string | null;
  state: string | null;
  languages: string[];
  candidateUpdatedAt: Date;
  documents: DocumentForScoring[];
  assignmentHistory: AssignmentHistoryForScoring[];
  availabilityStatus: AvailabilityStatus;
  jobOrder: JobOrderForScoring;
  now?: Date;
}

export interface WorkerScoreResult {
  eligibility: MatchEligibility;
  disqualifiers: string[];
  requiredDocumentsMissing: string[];
  deterministicScore: number;
  factors: MatchFactors;
  strengths: string[];
  gaps: string[];
  categoryAssessment: MatchAssessment;
  experienceAssessment: MatchAssessment;
  locationAssessment: MatchAssessment;
  payRateAssessment: MatchAssessment;
  complianceAssessment: MatchAssessment;
  availabilityAssessment: MatchAssessment;
}

function zeroFactor(key: keyof typeof FACTOR_WEIGHTS, label: string): MatchFactors[keyof MatchFactors] {
  return { key, label, maxWeight: FACTOR_WEIGHTS[key], score: 0, evidence: [] };
}

/**
 * Los 5 filtros duros de elegibilidad (plan §7.2) — se evalúan ANTES de
 * cualquier score. Un Worker con al menos un disqualifier nunca es
 * puntuado (ver scoreWorkerForJobOrder) ni puede ser ELIGIBLE, sin
 * importar qué diga cualquier ajuste posterior (LLM incluido).
 *
 * Corrección documentada respecto al pedido original: el filtro 5 se
 * implementa como "hay conflicto de fechas real" (availabilityStatus ===
 * "DATE_CONFLICT", calculado en F6.2), no restringido literalmente a
 * Worker.status==="ASSIGNED" — un Worker AVAILABLE con una Assignment
 * SCHEDULED/ACTIVE que se solapa por fechas también debe excluirse (ya
 * verificado y testeado en F6.2); restringirlo solo a ASSIGNED dejaría
 * pasar ese caso real, la interpretación más conservadora es la que se
 * implementa acá.
 */
export function computeDisqualifiers(input: WorkerScoringInput): string[] {
  const disqualifiers: string[] = [];

  if (input.workerStatus === "TERMINATED") disqualifiers.push("worker_terminated");
  if (input.workerStatus === "ON_LEAVE") disqualifiers.push("worker_on_leave");
  if (input.complianceStatus !== "COMPLIANT") disqualifiers.push("compliance_not_cleared");
  if (!input.candidateCategoryIds.includes(input.jobOrder.categoryId)) disqualifiers.push("category_mismatch");
  if (input.availabilityStatus === "DATE_CONFLICT") disqualifiers.push("date_overlap");
  if (!KNOWN_WORKER_STATUSES.has(input.workerStatus)) disqualifiers.push("unrecognized_worker_status");

  return disqualifiers;
}

// ---------- Factores individuales (cada uno puro, testeable aislado) ----------

export function scoreRequiredDocuments(input: WorkerScoringInput): { factor: MatchFactors["requiredDocuments"]; missing: string[] } {
  const required = input.jobOrder.requirements;
  if (required.length === 0) {
    return {
      factor: { key: "requiredDocuments", label: "Documentos requeridos", maxWeight: FACTOR_WEIGHTS.requiredDocuments, score: FACTOR_WEIGHTS.requiredDocuments, evidence: ["Este Job Order no requiere documentos específicos."] },
      missing: [],
    };
  }
  const verifiedKeys = new Set(input.documents.filter((d) => d.status === "VERIFIED").map((d) => d.documentTypeKey));
  const missing = required.filter((key) => !verifiedKeys.has(key));
  const present = required.length - missing.length;
  const score = FACTOR_WEIGHTS.requiredDocuments * (present / required.length);
  const evidence = [
    `${present}/${required.length} documentos requeridos verificados.`,
    ...(missing.length > 0 ? [`Faltantes o no verificados: ${missing.join(", ")}.`] : []),
  ];
  return {
    factor: { key: "requiredDocuments", label: "Documentos requeridos", maxWeight: FACTOR_WEIGHTS.requiredDocuments, score, evidence },
    missing,
  };
}

const EXPERIENCE_CAP_YEARS = 10;

export function scoreExperience(input: WorkerScoringInput): MatchFactors["experience"] {
  if (input.yearsExperience == null) {
    return {
      key: "experience",
      label: "Experiencia",
      maxWeight: FACTOR_WEIGHTS.experience,
      score: 0,
      evidence: ["Años de experiencia desconocidos — sin dato en el perfil del candidato."],
    };
  }
  const years = Math.max(0, input.yearsExperience);
  const score = FACTOR_WEIGHTS.experience * Math.min(1, years / EXPERIENCE_CAP_YEARS);
  return {
    key: "experience",
    label: "Experiencia",
    maxWeight: FACTOR_WEIGHTS.experience,
    score,
    evidence: [`${years} año(s) de experiencia (techo de ${EXPERIENCE_CAP_YEARS} años para el máximo puntaje).`],
  };
}

export function scoreLocation(input: WorkerScoringInput): MatchFactors["location"] {
  const jobCity = input.jobOrder.location?.city ?? null;
  const jobState = input.jobOrder.location?.state ?? null;
  if (!jobCity && !jobState) {
    return { key: "location", label: "Ubicación", maxWeight: FACTOR_WEIGHTS.location, score: 0, evidence: ["El Job Order no tiene ubicación registrada."] };
  }
  if (!input.city && !input.state) {
    return { key: "location", label: "Ubicación", maxWeight: FACTOR_WEIGHTS.location, score: 0, evidence: ["El candidato no tiene ciudad/estado registrados."] };
  }
  const sameCity = !!jobCity && !!input.city && jobCity.trim().toLowerCase() === input.city.trim().toLowerCase();
  const sameState = !!jobState && !!input.state && jobState.trim().toLowerCase() === input.state.trim().toLowerCase();
  if (sameCity) {
    return { key: "location", label: "Ubicación", maxWeight: FACTOR_WEIGHTS.location, score: 15, evidence: [`Misma ciudad (${input.city}).`] };
  }
  if (sameState) {
    return { key: "location", label: "Ubicación", maxWeight: FACTOR_WEIGHTS.location, score: 8, evidence: [`Mismo estado (${input.state}), ciudad distinta.`] };
  }
  return { key: "location", label: "Ubicación", maxWeight: FACTOR_WEIGHTS.location, score: 0, evidence: [`Estado distinto (candidato: ${input.state ?? "—"}, Job Order: ${jobState ?? "—"}).`] };
}

export function scorePayRate(input: WorkerScoringInput): MatchFactors["payRate"] {
  const jobPayRate = input.jobOrder.payRate;
  if (!(jobPayRate > 0)) {
    return { key: "payRate", label: "Tarifa de pago", maxWeight: FACTOR_WEIGHTS.payRate, score: 0, evidence: ["El Job Order no tiene payRate válido para comparar."] };
  }
  const diffRatio = Math.abs(input.defaultPayRate - jobPayRate) / jobPayRate;
  const alignment = Math.max(0, Math.min(1, 1 - diffRatio));
  const score = FACTOR_WEIGHTS.payRate * alignment;
  return {
    key: "payRate",
    label: "Tarifa de pago",
    maxWeight: FACTOR_WEIGHTS.payRate,
    score,
    evidence: [`Worker.defaultPayRate=${input.defaultPayRate} vs JobOrder.payRate=${jobPayRate} (diferencia relativa ${(diffRatio * 100).toFixed(1)}%).`],
  };
}

export function scoreAssignmentHistory(input: WorkerScoringInput): MatchFactors["assignmentHistory"] {
  const relevant = input.assignmentHistory.filter(
    (a) => a.status === "COMPLETED" && (a.categoryId === input.jobOrder.categoryId || a.companyId === input.jobOrder.companyId),
  );
  if (relevant.length === 0) {
    return { key: "assignmentHistory", label: "Historial de Assignments", maxWeight: FACTOR_WEIGHTS.assignmentHistory, score: 0, evidence: ["Sin Assignments COMPLETED previas en esta categoría o empresa."] };
  }
  return {
    key: "assignmentHistory",
    label: "Historial de Assignments",
    maxWeight: FACTOR_WEIGHTS.assignmentHistory,
    score: FACTOR_WEIGHTS.assignmentHistory,
    evidence: [`${relevant.length} Assignment(s) COMPLETED previa(s) en la misma categoría o empresa.`],
  };
}

export function scoreLanguages(input: WorkerScoringInput): MatchFactors["languages"] {
  const isMultilingual = input.languages.length > 1;
  return {
    key: "languages",
    label: "Idiomas",
    maxWeight: FACTOR_WEIGHTS.languages,
    score: isMultilingual ? FACTOR_WEIGHTS.languages : 0,
    evidence: isMultilingual
      ? [`Multilingüe (${input.languages.join(", ")}) — señal genérica, el Job Order no declara un idioma requerido.`]
      : ["Monolingüe o sin idiomas registrados."],
  };
}

// F6.3: "más antiguo = escala decreciente a 0" (plan §7.4) — se elige
// explícitamente 365 días como el punto donde llega a 0 (el plan no fija
// un corte exacto); documentado acá como la interpretación conservadora
// elegida, no inventada sin criterio: perfiles con más de un año sin
// tocarse dejan de aportar señal de higiene de datos.
const RECENCY_FULL_SCORE_DAYS = 90;
const RECENCY_ZERO_DAYS = 365;

export function scoreDataRecency(input: WorkerScoringInput): MatchFactors["dataRecency"] {
  const now = input.now ?? new Date();
  const daysSinceUpdate = (now.getTime() - input.candidateUpdatedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate <= RECENCY_FULL_SCORE_DAYS) {
    return { key: "dataRecency", label: "Recencia de datos", maxWeight: FACTOR_WEIGHTS.dataRecency, score: FACTOR_WEIGHTS.dataRecency, evidence: [`Perfil actualizado hace ${Math.round(daysSinceUpdate)} día(s).`] };
  }
  if (daysSinceUpdate >= RECENCY_ZERO_DAYS) {
    return { key: "dataRecency", label: "Recencia de datos", maxWeight: FACTOR_WEIGHTS.dataRecency, score: 0, evidence: [`Perfil sin actualizar hace ${Math.round(daysSinceUpdate)} día(s).`] };
  }
  const decayRatio = 1 - (daysSinceUpdate - RECENCY_FULL_SCORE_DAYS) / (RECENCY_ZERO_DAYS - RECENCY_FULL_SCORE_DAYS);
  return {
    key: "dataRecency",
    label: "Recencia de datos",
    maxWeight: FACTOR_WEIGHTS.dataRecency,
    score: FACTOR_WEIGHTS.dataRecency * decayRatio,
    evidence: [`Perfil actualizado hace ${Math.round(daysSinceUpdate)} día(s) — escala decreciente entre ${RECENCY_FULL_SCORE_DAYS} y ${RECENCY_ZERO_DAYS} días.`],
  };
}

function assessmentFor(label: string, detail?: string): MatchAssessment {
  return detail ? { label, detail } : { label };
}

/**
 * Punto de entrada principal — determinista, sin IA. Aplica los 5
 * filtros duros primero; si alguno dispara, el Worker queda INELIGIBLE
 * con deterministicScore=0 y los 7 factores en 0 (nunca se puntúa
 * parcialmente a alguien ya excluido — evita que la UI muestre "score
 * alto" para alguien descalificado). Si pasa los 5 filtros, calcula los
 * 7 factores y los suma.
 */
export function scoreWorkerForJobOrder(input: WorkerScoringInput): WorkerScoreResult {
  const disqualifiers = computeDisqualifiers(input);

  if (disqualifiers.length > 0) {
    const factors: MatchFactors = {
      requiredDocuments: zeroFactor("requiredDocuments", "Documentos requeridos") as MatchFactors["requiredDocuments"],
      experience: zeroFactor("experience", "Experiencia") as MatchFactors["experience"],
      location: zeroFactor("location", "Ubicación") as MatchFactors["location"],
      payRate: zeroFactor("payRate", "Tarifa de pago") as MatchFactors["payRate"],
      assignmentHistory: zeroFactor("assignmentHistory", "Historial de Assignments") as MatchFactors["assignmentHistory"],
      languages: zeroFactor("languages", "Idiomas") as MatchFactors["languages"],
      dataRecency: zeroFactor("dataRecency", "Recencia de datos") as MatchFactors["dataRecency"],
    };

    const disqualifierLabels: Record<string, string> = {
      worker_terminated: "El worker está TERMINATED.",
      worker_on_leave: "El worker está ON_LEAVE.",
      compliance_not_cleared: `Compliance no está COMPLIANT (actual: ${input.complianceStatus}).`,
      category_mismatch: "Ninguna categoría del candidato coincide con la del Job Order.",
      date_overlap: "Conflicto de fechas con una Assignment SCHEDULED/ACTIVE existente.",
      unrecognized_worker_status: `Worker.status no reconocido: "${input.workerStatus}".`,
    };

    return {
      eligibility: "INELIGIBLE",
      disqualifiers,
      requiredDocumentsMissing: [],
      deterministicScore: 0,
      factors,
      strengths: [],
      gaps: disqualifiers.map((d) => disqualifierLabels[d] ?? d),
      categoryAssessment: assessmentFor(input.candidateCategoryIds.includes(input.jobOrder.categoryId) ? "Compatible" : "Incompatible"),
      experienceAssessment: assessmentFor("No evaluado — worker descalificado antes del scoring"),
      locationAssessment: assessmentFor("No evaluado — worker descalificado antes del scoring"),
      payRateAssessment: assessmentFor("No evaluado — worker descalificado antes del scoring"),
      complianceAssessment: assessmentFor(input.complianceStatus === "COMPLIANT" ? "Compliant" : "No compliant", input.complianceStatus),
      availabilityAssessment: assessmentFor(input.availabilityStatus === "DATE_CONFLICT" ? "Conflicto de fechas" : input.availabilityStatus),
    };
  }

  const { factor: requiredDocumentsFactor, missing: requiredDocumentsMissing } = scoreRequiredDocuments(input);
  const experienceFactor = scoreExperience(input);
  const locationFactor = scoreLocation(input);
  const payRateFactor = scorePayRate(input);
  const assignmentHistoryFactor = scoreAssignmentHistory(input);
  const languagesFactor = scoreLanguages(input);
  const dataRecencyFactor = scoreDataRecency(input);

  const factors: MatchFactors = {
    requiredDocuments: requiredDocumentsFactor,
    experience: experienceFactor,
    location: locationFactor,
    payRate: payRateFactor,
    assignmentHistory: assignmentHistoryFactor,
    languages: languagesFactor,
    dataRecency: dataRecencyFactor,
  };

  const deterministicScore = Object.values(factors).reduce((sum, f) => sum + f.score, 0);

  const strengths: string[] = [];
  const gaps: string[] = [];
  for (const factor of Object.values(factors)) {
    const ratio = factor.score / factor.maxWeight;
    if (ratio >= 0.8) strengths.push(`${factor.label}: ${factor.evidence[0] ?? "fuerte"}`);
    else if (ratio <= 0.3) gaps.push(`${factor.label}: ${factor.evidence[0] ?? "débil"}`);
  }
  if (requiredDocumentsMissing.length > 0) gaps.push(`Documentos faltantes: ${requiredDocumentsMissing.join(", ")}.`);

  return {
    eligibility: "ELIGIBLE",
    disqualifiers: [],
    requiredDocumentsMissing,
    deterministicScore,
    factors,
    strengths,
    gaps,
    categoryAssessment: assessmentFor("Compatible"),
    experienceAssessment: assessmentFor(
      input.yearsExperience == null ? "Desconocida" : input.yearsExperience >= EXPERIENCE_CAP_YEARS ? "Amplia" : "Parcial",
      experienceFactor.evidence[0],
    ),
    locationAssessment: assessmentFor(locationFactor.score >= 15 ? "Misma ciudad" : locationFactor.score >= 8 ? "Mismo estado" : "Distinta", locationFactor.evidence[0]),
    payRateAssessment: assessmentFor(payRateFactor.score >= FACTOR_WEIGHTS.payRate * 0.8 ? "Compatible" : "Divergente", payRateFactor.evidence[0]),
    complianceAssessment: assessmentFor("Compliant"),
    availabilityAssessment: assessmentFor(input.availabilityStatus === "AVAILABLE" ? "Disponible" : input.availabilityStatus),
  };
}
