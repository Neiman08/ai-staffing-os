/**
 * F8.7: Candidate Shortlist -- puro, determinista, sin Prisma/fetch/LLM.
 * Construye la lista revisable de candidatos para un Job Order a partir
 * del ranking YA calculado por F8.6 (`candidate-matching.ts`) -- nunca
 * vuelve a calificar/puntuar, solo REUTILIZA esa salida. Una shortlist
 * nunca contacta a nadie, nunca rechaza definitivamente (`REMOVED` es
 * reversible, ver `SHORTLIST_REVIEW_TRANSITIONS`), y nunca toca
 * `Candidate.status`.
 */

import type { PersistedQualificationStatus } from "./qualification-status";
import type { MatchConfidence } from "./candidate-matching";

export const SHORTLIST_VERSION = 1;

export type ShortlistReviewStatus = "DRAFT" | "READY_FOR_REVIEW" | "APPROVED" | "HOLD" | "REMOVED";

/**
 * Grafo de transiciones válidas -- mismo criterio que
 * `CANDIDATE_STATUS_TRANSITIONS` (packages/shared, F5.2): explícito,
 * nunca implícito. `REMOVED` SIEMPRE puede reabrirse a `DRAFT` -- no es
 * un rechazo permanente, cumple la restricción explícita de esta
 * subfase ("no rechazar candidatos definitivamente").
 */
export const SHORTLIST_REVIEW_TRANSITIONS: Record<ShortlistReviewStatus, ShortlistReviewStatus[]> = {
  DRAFT: ["READY_FOR_REVIEW", "REMOVED"],
  READY_FOR_REVIEW: ["DRAFT", "APPROVED", "HOLD", "REMOVED"],
  APPROVED: ["HOLD", "REMOVED"],
  HOLD: ["READY_FOR_REVIEW", "APPROVED", "REMOVED"],
  REMOVED: ["DRAFT"],
};

/** Idempotente: pedir el mismo estado actual siempre es válido (mismo criterio que Candidate.status, F5.2). */
export function isValidShortlistTransition(from: ShortlistReviewStatus, to: ShortlistReviewStatus): boolean {
  if (from === to) return true;
  return SHORTLIST_REVIEW_TRANSITIONS[from].includes(to);
}

const SHORTLIST_REVIEW_STATUSES = new Set<string>(Object.keys(SHORTLIST_REVIEW_TRANSITIONS));

/** Type guard de runtime para validar un valor externo (body de un request) antes de confiar en él. */
export function isShortlistReviewStatus(value: unknown): value is ShortlistReviewStatus {
  return typeof value === "string" && SHORTLIST_REVIEW_STATUSES.has(value);
}

export interface ShortlistSourceMatch {
  candidateId: string;
  rank: number;
  score: number;
  normalizedScore: number;
  qualificationStatus: PersistedQualificationStatus;
  confidence: MatchConfidence;
  explanation: string;
  risks: string[];
  missingData: string[];
}

export interface ShortlistEntryDraft {
  candidateId: string;
  rank: number;
  score: number;
  normalizedScore: number;
  qualificationStatus: PersistedQualificationStatus;
  confidence: MatchConfidence;
  reasons: string[];
  gaps: string[];
  risks: string[];
  reviewStatus: "DRAFT";
  shortlistVersion: number;
}

/**
 * Construye los drafts de la shortlist a partir del ranking de F8.6 --
 * SOLO candidatos ya `ranked` (recommendable !== false, ya filtrado por
 * F8.6). Nunca incluye `excluded`/NOT_QUALIFIED -- una shortlist nunca
 * puede contener a alguien no recomendable. Orden preservado tal cual
 * viene del ranking (ya determinista en origen).
 */
export function buildShortlistEntries(ranked: ShortlistSourceMatch[]): ShortlistEntryDraft[] {
  return ranked.map((m) => ({
    candidateId: m.candidateId,
    rank: m.rank,
    score: m.score,
    normalizedScore: m.normalizedScore,
    qualificationStatus: m.qualificationStatus,
    confidence: m.confidence,
    reasons: [m.explanation],
    gaps: m.missingData,
    risks: m.risks,
    reviewStatus: "DRAFT",
    shortlistVersion: SHORTLIST_VERSION,
  }));
}
