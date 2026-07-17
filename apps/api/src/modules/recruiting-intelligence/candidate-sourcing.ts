/**
 * F8.3: Candidate Sourcing -- puro, determinista, sin Prisma/fetch/LLM
 * (mismo criterio que el resto de `recruiting-intelligence/`). Fuente
 * ÚNICA y explícitamente permitida: candidatos YA existentes en el
 * tenant (nunca scraping externo, nunca un candidato inventado -- la
 * única excepción son fixtures de test inequívocos, ver
 * `candidate-sourcing.test.ts`). Este módulo solo ORDENA/FILTRA una
 * lista ya cargada por el llamador -- nunca decide crear, contactar, ni
 * cambiar el estado de ningún Candidate.
 */

export const CANDIDATE_SOURCING_VERSION = 1;

const INELIGIBLE_SOURCING_STATUSES = new Set(["REJECTED", "INACTIVE"]);

export interface SourcingCandidateInput {
  candidateId: string;
  status: string;
  categoryIds: string[];
  yearsExperience: number | null;
  state: string | null;
  createdAt: string | Date;
}

export interface SourcingJobRequirements {
  categoryId: string;
  state: string | null;
}

export interface SourcedCandidateResult {
  candidateId: string;
  relevanceScore: number;
  reasons: string[];
}

export interface CandidateSourcingInput {
  candidates: SourcingCandidateInput[];
  job: SourcingJobRequirements;
}

export interface CandidateSourcingResult {
  sourced: SourcedCandidateResult[];
  excluded: Array<{ candidateId: string; reason: string }>;
  sourcingVersion: number;
}

/**
 * Filtra y ordena candidatos YA existentes del tenant para un Job
 * Order. Nunca inventa un candidato ni trae uno de fuera del tenant --
 * el llamador ya restringió la consulta con `scopedDb`. Un candidato
 * sin la categoría exacta requerida queda excluido (razón explícita),
 * nunca se incluye "por si acaso".
 */
export function sourceCandidatesForJob(input: CandidateSourcingInput): CandidateSourcingResult {
  const sourced: SourcedCandidateResult[] = [];
  const excluded: Array<{ candidateId: string; reason: string }> = [];

  for (const candidate of input.candidates) {
    if (INELIGIBLE_SOURCING_STATUSES.has(candidate.status)) {
      excluded.push({ candidateId: candidate.candidateId, reason: `Estado "${candidate.status}" no elegible para sourcing.` });
      continue;
    }
    if (!candidate.categoryIds.includes(input.job.categoryId)) {
      excluded.push({ candidateId: candidate.candidateId, reason: "No está asociado a la categoría de puesto requerida." });
      continue;
    }

    let score = 0.5;
    const reasons: string[] = ["Categoría de puesto coincide."];

    const sameState = input.job.state !== null && candidate.state !== null && candidate.state === input.job.state;
    if (sameState) {
      score += 0.25;
      reasons.push(`Mismo estado que el Job Order (${candidate.state}).`);
    } else if (input.job.state !== null) {
      reasons.push("Estado distinto al del Job Order (sin penalización dura, solo menor prioridad).");
    }

    if (candidate.yearsExperience !== null) {
      score += Math.min(0.25, candidate.yearsExperience * 0.05);
      reasons.push(`${candidate.yearsExperience} años de experiencia declarados.`);
    }

    sourced.push({ candidateId: candidate.candidateId, relevanceScore: Math.min(1, score), reasons });
  }

  sourced.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return { sourced, excluded, sourcingVersion: CANDIDATE_SOURCING_VERSION };
}
