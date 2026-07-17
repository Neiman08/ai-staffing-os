/**
 * F7.10: Opportunity Recommendation -- puro, determinista, sin Prisma/
 * fetch/LLM (mismo criterio que el resto de ceo-intelligence/). Combina
 * TODA la evidencia ya reunida por F7.4-F7.8 para UNA Company de una
 * misión en una recomendación auditable -- nunca crea una Opportunity
 * automáticamente. `requiresApproval` es SIEMPRE `true`: el CEO (humano)
 * decide, esta función solo prepara la decisión con evidencia y riesgos
 * explícitos.
 */

export const OPPORTUNITY_RECOMMENDATION_VERSION = 1;

export const opportunityRecommendationActions = ["CREATE_OPPORTUNITY", "INVESTIGATE_MORE", "ARCHIVE", "MANUAL_REVIEW"] as const;
export type OpportunityRecommendationAction = (typeof opportunityRecommendationActions)[number];

export type BestContactRankingTier = "HIGH_CONFIDENCE" | "MEDIUM_CONFIDENCE" | "LOW_CONFIDENCE" | "REJECTED" | null;

export interface OpportunityRecommendationInput {
  businessConfidence: "EXACT" | "STRONG" | "APPROXIMATE" | "WEAK" | "REJECTED";
  missingEvidence: string[];
  hasValidEmail: boolean;
  hiringStatus: "CONFIRMED_HIRING" | "LIKELY_HIRING" | "POSSIBLE_HIRING" | "NO_SIGNAL" | "BLOCKED" | "UNKNOWN" | null;
  contactsFound: number;
  bestContactRankingTier: BestContactRankingTier;
  rolesWithoutContact: string[];
}

export interface OpportunityRecommendationResult {
  recommendation: OpportunityRecommendationAction;
  score: number;
  reasons: string[];
  risks: string[];
  missingEvidence: string[];
  nextBestAction: string;
  requiresApproval: true;
  recommendationVersion: number;
}

const HIRING_POSITIVE = new Set(["CONFIRMED_HIRING", "LIKELY_HIRING"]);

export function recommendOpportunityAction(input: OpportunityRecommendationInput): OpportunityRecommendationResult {
  const reasons: string[] = [];
  const risks: string[] = [];
  let score = 0;

  if (input.businessConfidence === "EXACT" || input.businessConfidence === "STRONG") {
    score += 0.3;
    reasons.push(`Validación de negocio ${input.businessConfidence.toLowerCase()}.`);
  } else if (input.businessConfidence === "APPROXIMATE") {
    score += 0.15;
    risks.push("La validación de negocio es solo aproximada.");
  } else {
    risks.push(`Validación de negocio débil o rechazada (${input.businessConfidence}).`);
  }

  if (input.hasValidEmail) {
    score += 0.15;
    reasons.push("Email organizacional válido encontrado.");
  } else {
    risks.push("Sin email organizacional válido.");
  }

  if (input.hiringStatus && HIRING_POSITIVE.has(input.hiringStatus)) {
    score += 0.25;
    reasons.push(`Señal de contratación: ${input.hiringStatus}.`);
  } else if (input.hiringStatus === "POSSIBLE_HIRING") {
    score += 0.1;
    reasons.push("Señal de contratación posible, no confirmada.");
  } else if (input.hiringStatus === "NO_SIGNAL" || input.hiringStatus === "UNKNOWN" || input.hiringStatus === "BLOCKED") {
    risks.push("Sin señal de contratación confirmada.");
  }

  if (input.contactsFound > 0 && (input.bestContactRankingTier === "HIGH_CONFIDENCE" || input.bestContactRankingTier === "MEDIUM_CONFIDENCE")) {
    score += 0.3;
    reasons.push(`Contacto de decisión real encontrado (${input.bestContactRankingTier}).`);
  } else if (input.contactsFound > 0 && input.bestContactRankingTier === "LOW_CONFIDENCE") {
    score += 0.1;
    risks.push("El contacto encontrado tiene baja confianza.");
  } else if (input.contactsFound > 0 && input.bestContactRankingTier === "REJECTED") {
    risks.push("El único contacto encontrado fue rechazado por el ranking (dominio/email inválido).");
  } else {
    risks.push("Ningún contacto de decisión identificado todavía.");
  }

  if (input.rolesWithoutContact.length > 0) {
    risks.push(`Roles planificados sin contacto: ${input.rolesWithoutContact.join(", ")}.`);
  }

  score = Math.max(0, Math.min(1, score));

  const missingEvidence = [...input.missingEvidence];
  if (!input.hasValidEmail) missingEvidence.push("email organizacional válido");
  if (input.contactsFound === 0) missingEvidence.push("contacto de decisión identificado");

  // Señales críticas: nunca recomendar crear/investigar sobre evidencia
  // básicamente rechazada.
  if (input.businessConfidence === "REJECTED" || input.businessConfidence === "WEAK") {
    return {
      recommendation: "ARCHIVE",
      score,
      reasons,
      risks,
      missingEvidence,
      nextBestAction: "Archivar -- la validación de negocio no alcanza el umbral mínimo para continuar.",
      requiresApproval: true,
      recommendationVersion: OPPORTUNITY_RECOMMENDATION_VERSION,
    };
  }

  let recommendation: OpportunityRecommendationAction;
  let nextBestAction: string;
  if (score >= 0.75) {
    recommendation = "CREATE_OPPORTUNITY";
    nextBestAction = "Evidencia fuerte y consistente -- el CEO puede aprobar la creación de una Opportunity.";
  } else if (score >= 0.45) {
    recommendation = "INVESTIGATE_MORE";
    nextBestAction = "Evidencia parcial -- completar la evidencia faltante antes de decidir.";
  } else if (risks.length >= reasons.length && risks.length > 0) {
    recommendation = "MANUAL_REVIEW";
    nextBestAction = "Señales mixtas o insuficientes -- requiere revisión manual antes de continuar.";
  } else {
    recommendation = "INVESTIGATE_MORE";
    nextBestAction = "Evidencia insuficiente todavía -- seguir investigando.";
  }

  return {
    recommendation,
    score,
    reasons,
    risks,
    missingEvidence,
    nextBestAction,
    requiresApproval: true,
    recommendationVersion: OPPORTUNITY_RECOMMENDATION_VERSION,
  };
}
