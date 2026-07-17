/**
 * F8.6: Matching and Ranking (Candidate <-> JobOrder, etapa de
 * reclutamiento) -- puro, determinista, sin Prisma/fetch/LLM.
 *
 * Decisión de arquitectura (auditada antes de escribir código, ver
 * docs/F8_PLAN.md §12.1): NO se extiende/reescribe
 * `matching/scoring.ts` (F6.3). Ese motor puntúa `Worker` YA
 * contratados (`WorkerScoringInput` requiere `complianceStatus`,
 * `defaultPayRate`, `assignmentHistory`, disponibilidad por fechas de
 * Assignment -- ninguno de estos existe para un `Candidate` en etapa de
 * reclutamiento, que es justamente anterior a convertirse en `Worker`,
 * ver el mismo criterio ya documentado en `qualification-rules.ts`
 * F8.2). Fabricar valores falsos para esos campos solo para reusar la
 * función literal sería peor que un módulo paralelo: introduciría datos
 * inventados en un score que se presenta como real.
 *
 * En su lugar, este módulo REUTILIZA el patrón arquitectónico de F6.3
 * (constraints duros evaluados ANTES de puntuar, factores blandos
 * ponderados con evidencia, score determinista, empate resuelto sin
 * ambigüedad) y REUTILIZA DIRECTAMENTE -- nunca duplica -- la salida ya
 * calculada por F8.2 (`QualificationEvaluationResult`) y F8.5
 * (`PersistedQualificationStatus`) como los ÚNICOS insumos de "hard
 * constraints": este módulo nunca vuelve a evaluar categoría/documentos/
 * estado del candidato, solo consume lo que qualification-rules.ts y
 * qualification-status.ts ya decidieron.
 *
 * Regla no negociable (igual que F6.3): un candidato NOT_QUALIFIED
 * nunca puede aparecer en la lista de recomendados -- se excluye antes
 * de rankear, nunca se le asigna un `rank`.
 */

import type { QualificationEvaluationResult } from "./qualification-rules";
import type { PersistedQualificationStatus } from "./qualification-status";

export const CANDIDATE_MATCHING_VERSION = 1;

// ---------- Pesos máximos (suma 100, mismo criterio que F6.3 §7.4) ----------
export const MATCHING_FACTOR_WEIGHTS = {
  documentReadiness: 30,
  experience: 25,
  location: 20,
  languages: 15,
  dataRecency: 10,
} as const;

export type MatchConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface CandidateMatchFactor {
  key: keyof typeof MATCHING_FACTOR_WEIGHTS;
  label: string;
  maxWeight: number;
  score: number;
  evidence: string[];
}

export interface CandidateForMatching {
  candidateId: string;
  // Reutilizados TAL CUAL desde F8.2/F8.5 -- nunca re-derivados acá.
  qualification: QualificationEvaluationResult;
  qualificationStatus: PersistedQualificationStatus;
  yearsExperience: number | null;
  state: string | null;
  languages: string[];
  candidateUpdatedAt: string | Date;
}

export interface JobForMatching {
  jobOrderId: string;
  state: string | null;
  requiredDocumentCount: number;
}

export interface CandidateMatchResult {
  candidateId: string;
  qualificationStatus: PersistedQualificationStatus;
  // Regla no negociable: false únicamente cuando NOT_QUALIFIED.
  recommendable: boolean;
  needsReview: boolean;
  hardConstraints: string[];
  softPreferences: CandidateMatchFactor[];
  score: number;
  normalizedScore: number;
  rank: number | null;
  explanation: string;
  confidence: MatchConfidence;
  missingData: string[];
  risks: string[];
  evidence: string[];
  rulesVersion: number;
  calculatedAt: string;
}

export interface CandidateMatchingResult {
  jobOrderId: string;
  ranked: CandidateMatchResult[];
  excluded: CandidateMatchResult[];
  rulesVersion: number;
  calculatedAt: string;
}

const EXPERIENCE_CAP_YEARS = 10;
const RECENCY_FULL_SCORE_DAYS = 90;
const RECENCY_ZERO_DAYS = 365;

function scoreDocumentReadiness(candidate: CandidateForMatching, job: JobForMatching): CandidateMatchFactor {
  const key = "documentReadiness" as const;
  const maxWeight = MATCHING_FACTOR_WEIGHTS.documentReadiness;
  if (job.requiredDocumentCount === 0) {
    return { key, label: "Documentos requeridos", maxWeight, score: maxWeight, evidence: ["Este Job Order no requiere documentos específicos."] };
  }
  const notReady = candidate.qualification.missingDocuments.length + candidate.qualification.expiredDocuments.length;
  const ready = Math.max(0, job.requiredDocumentCount - notReady);
  const score = maxWeight * (ready / job.requiredDocumentCount);
  return {
    key,
    label: "Documentos requeridos",
    maxWeight,
    score,
    evidence: [`${ready}/${job.requiredDocumentCount} documentos requeridos verificados y vigentes.`],
  };
}

function scoreExperience(candidate: CandidateForMatching): CandidateMatchFactor {
  const key = "experience" as const;
  const maxWeight = MATCHING_FACTOR_WEIGHTS.experience;
  if (candidate.yearsExperience == null) {
    return { key, label: "Experiencia", maxWeight, score: 0, evidence: ["Años de experiencia desconocidos — sin dato en el perfil del candidato."] };
  }
  const years = Math.max(0, candidate.yearsExperience);
  const score = maxWeight * Math.min(1, years / EXPERIENCE_CAP_YEARS);
  return { key, label: "Experiencia", maxWeight, score, evidence: [`${years} año(s) de experiencia (techo de ${EXPERIENCE_CAP_YEARS} años para el máximo puntaje).`] };
}

function scoreLocation(candidate: CandidateForMatching, job: JobForMatching): CandidateMatchFactor {
  const key = "location" as const;
  const maxWeight = MATCHING_FACTOR_WEIGHTS.location;
  if (!job.state) {
    return { key, label: "Ubicación", maxWeight, score: 0, evidence: ["El Job Order no tiene estado registrado."] };
  }
  if (!candidate.state) {
    return { key, label: "Ubicación", maxWeight, score: 0, evidence: ["El candidato no tiene estado registrado."] };
  }
  const sameState = candidate.state.trim().toLowerCase() === job.state.trim().toLowerCase();
  if (sameState) {
    return { key, label: "Ubicación", maxWeight, score: maxWeight, evidence: [`Mismo estado que el Job Order (${candidate.state}).`] };
  }
  return { key, label: "Ubicación", maxWeight, score: 0, evidence: [`Estado distinto (candidato: ${candidate.state}, Job Order: ${job.state}).`] };
}

function scoreLanguages(candidate: CandidateForMatching): CandidateMatchFactor {
  const key = "languages" as const;
  const maxWeight = MATCHING_FACTOR_WEIGHTS.languages;
  const isMultilingual = candidate.languages.length > 1;
  return {
    key,
    label: "Idiomas",
    maxWeight,
    score: isMultilingual ? maxWeight : 0,
    evidence: isMultilingual
      ? [`Multilingüe (${candidate.languages.join(", ")}) — señal genérica, el Job Order no declara un idioma requerido.`]
      : ["Monolingüe o sin idiomas registrados."],
  };
}

function scoreDataRecency(candidate: CandidateForMatching, now: Date): CandidateMatchFactor {
  const key = "dataRecency" as const;
  const maxWeight = MATCHING_FACTOR_WEIGHTS.dataRecency;
  const updatedAt = new Date(candidate.candidateUpdatedAt);
  const daysSinceUpdate = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate <= RECENCY_FULL_SCORE_DAYS) {
    return { key, label: "Recencia de datos", maxWeight, score: maxWeight, evidence: [`Perfil actualizado hace ${Math.round(daysSinceUpdate)} día(s).`] };
  }
  if (daysSinceUpdate >= RECENCY_ZERO_DAYS) {
    return { key, label: "Recencia de datos", maxWeight, score: 0, evidence: [`Perfil sin actualizar hace ${Math.round(daysSinceUpdate)} día(s).`] };
  }
  const decayRatio = 1 - (daysSinceUpdate - RECENCY_FULL_SCORE_DAYS) / (RECENCY_ZERO_DAYS - RECENCY_FULL_SCORE_DAYS);
  return {
    key,
    label: "Recencia de datos",
    maxWeight,
    score: maxWeight * decayRatio,
    evidence: [`Perfil actualizado hace ${Math.round(daysSinceUpdate)} día(s) — escala decreciente entre ${RECENCY_FULL_SCORE_DAYS} y ${RECENCY_ZERO_DAYS} días.`],
  };
}

function computeMissingData(candidate: CandidateForMatching): string[] {
  const missing: string[] = [];
  if (candidate.yearsExperience == null) missing.push("yearsExperience");
  if (!candidate.state) missing.push("state");
  if (candidate.languages.length === 0) missing.push("languages");
  return missing;
}

function computeConfidence(missingData: string[]): MatchConfidence {
  if (missingData.length === 0) return "HIGH";
  if (missingData.length <= 2) return "MEDIUM";
  return "LOW";
}

function computeRisks(candidate: CandidateForMatching): string[] {
  const risks: string[] = [];
  if (candidate.qualificationStatus === "NEEDS_REVIEW") {
    risks.push("Requiere revisión manual: al menos un documento requerido está faltante o no verificado.");
  }
  if (candidate.qualification.experienceGap) {
    risks.push("Gap de experiencia respecto al mínimo requerido por el Job Order.");
  }
  if (candidate.qualification.languageGaps.length > 0) {
    risks.push(`Faltan idiomas requeridos: ${candidate.qualification.languageGaps.join(", ")}.`);
  }
  return risks;
}

/**
 * Calcula el match de UN candidato contra UN Job Order. `recommendable`
 * es `false` únicamente cuando `qualificationStatus === "NOT_QUALIFIED"`
 * -- nunca se puntúa a un candidato NOT_QUALIFIED (mismo criterio que
 * F6.3: un descalificado nunca recibe un score parcial que pueda
 * confundirse con elegibilidad real).
 */
export function computeCandidateMatch(candidate: CandidateForMatching, job: JobForMatching, now: Date = new Date()): CandidateMatchResult {
  const calculatedAt = now.toISOString();
  const recommendable = candidate.qualificationStatus !== "NOT_QUALIFIED";
  const missingData = computeMissingData(candidate);
  const risks = computeRisks(candidate);
  const confidence = computeConfidence(missingData);

  if (!recommendable) {
    return {
      candidateId: candidate.candidateId,
      qualificationStatus: candidate.qualificationStatus,
      recommendable: false,
      needsReview: false,
      hardConstraints: candidate.qualification.hardDisqualifiers,
      softPreferences: [],
      score: 0,
      normalizedScore: 0,
      rank: null,
      explanation: `NOT_QUALIFIED: ${candidate.qualification.reasons.join(" ")}`,
      confidence,
      missingData,
      risks,
      evidence: candidate.qualification.reasons,
      rulesVersion: CANDIDATE_MATCHING_VERSION,
      calculatedAt,
    };
  }

  const softPreferences: CandidateMatchFactor[] = [
    scoreDocumentReadiness(candidate, job),
    scoreExperience(candidate),
    scoreLocation(candidate, job),
    scoreLanguages(candidate),
    scoreDataRecency(candidate, now),
  ];
  const score = softPreferences.reduce((sum, f) => sum + f.score, 0);
  const normalizedScore = score / 100;
  const evidence = [...candidate.qualification.reasons, ...softPreferences.flatMap((f) => f.evidence)];

  return {
    candidateId: candidate.candidateId,
    qualificationStatus: candidate.qualificationStatus,
    recommendable: true,
    needsReview: candidate.qualificationStatus === "NEEDS_REVIEW",
    hardConstraints: candidate.qualification.hardDisqualifiers,
    softPreferences,
    score,
    normalizedScore,
    rank: null, // se asigna en computeCandidateMatching(), tras ordenar
    explanation: `${candidate.qualificationStatus}: score ${score.toFixed(1)}/100. ${candidate.qualification.reasons[0] ?? ""}`.trim(),
    confidence,
    missingData,
    risks,
    evidence,
    rulesVersion: CANDIDATE_MATCHING_VERSION,
    calculatedAt,
  };
}

/**
 * Rankea una lista de candidatos para UN Job Order. Empate resuelto de
 * forma determinista: normalizedScore desc, luego candidateId asc (el
 * mismo input siempre produce el mismo orden, nunca depende del orden de
 * iteración de la DB — mismo criterio que F6.4). Los NOT_QUALIFIED van a
 * `excluded`, nunca a `ranked` — nunca reciben un `rank`.
 */
export function computeCandidateMatching(candidates: CandidateForMatching[], job: JobForMatching, now: Date = new Date()): CandidateMatchingResult {
  const calculatedAt = now.toISOString();
  const results = candidates.map((c) => computeCandidateMatch(c, job, now));

  const ranked = results.filter((r) => r.recommendable);
  const excluded = results.filter((r) => !r.recommendable);

  ranked.sort((a, b) => b.normalizedScore - a.normalizedScore || a.candidateId.localeCompare(b.candidateId));
  excluded.sort((a, b) => a.candidateId.localeCompare(b.candidateId));

  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });

  return { jobOrderId: job.jobOrderId, ranked, excluded, rulesVersion: CANDIDATE_MATCHING_VERSION, calculatedAt };
}
