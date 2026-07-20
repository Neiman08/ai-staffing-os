import type { HiringStatus } from "./hiring-signals";
import type { BestContactRankingTier } from "./opportunity-recommendation";

/**
 * F16: Hiring Confidence -- segunda dimensión, INDEPENDIENTE de Business
 * Confidence (business-validation.ts). Business Confidence responde
 * "¿esta empresa es de verdad del trade/sector que buscamos?". Hiring
 * Confidence responde una pregunta distinta: "¿qué tan probable es que
 * valga la pena contactarla ahora?" -- combinando señal de contratación
 * (hiring-signals.ts), página de carreras, emails organizacionales
 * verificados y contactos reales ya encontrados (contact-enrichment.ts).
 *
 * Puro, determinista, sin Prisma/fetch/LLM -- igual que
 * business-validation.ts. Commercial Conversion (conversion-policy.ts)
 * decide usando AMBAS dimensiones, nunca una sola clasificación mezclada
 * (ver mission-executor.ts, que calcula las dos por separado y las pasa
 * juntas a `decideCompanyConversion`).
 */

export const HIRING_CONFIDENCE_VERSION = 1;

export const hiringConfidenceTiers = ["HIGH", "MEDIUM", "LOW", "NONE"] as const;
export type HiringConfidenceTier = (typeof hiringConfidenceTiers)[number];

export interface HiringConfidenceInput {
  hiringSignalStatus: HiringStatus | null;
  hiringSignalTitlesMatched: string[];
  hasCareersPage: boolean;
  organizationalEmailsVerified: number;
  organizationalEmailsRisky: number;
  namedContactsFound: number;
  bestContactRankingTier: BestContactRankingTier;
}

export interface HiringConfidenceResult {
  tier: HiringConfidenceTier;
  // true = existe evidencia CONCRETA (no solo un status categórico) de
  // que vale la pena contactar -- puestos reales detectados, un contacto
  // real ya encontrado, o un email organizacional ya verificado. Sustituye
  // al chequeo anterior (solo `targetTitlesMatched.length > 0`) por uno
  // que también reconoce evidencia de contact enrichment.
  concreteEvidence: boolean;
  matchedSignals: string[];
  confidenceVersion: number;
}

const HIGH_HIRING_STATUS = new Set<HiringStatus | null>(["CONFIRMED_HIRING", "LIKELY_HIRING"]);

export function computeHiringConfidence(input: HiringConfidenceInput): HiringConfidenceResult {
  const matchedSignals: string[] = [];

  if (HIGH_HIRING_STATUS.has(input.hiringSignalStatus)) matchedSignals.push(`hiringStatus:${input.hiringSignalStatus}`);
  if (input.bestContactRankingTier === "HIGH_CONFIDENCE") matchedSignals.push("contact:HIGH_CONFIDENCE");

  const highTierReached = matchedSignals.length > 0;

  const mediumSignals: string[] = [];
  if (input.hiringSignalStatus === "POSSIBLE_HIRING") mediumSignals.push("hiringStatus:POSSIBLE_HIRING");
  if (input.hiringSignalTitlesMatched.length > 0) mediumSignals.push("hiringTitlesMatched");
  if (input.organizationalEmailsVerified > 0) mediumSignals.push("verifiedOrgEmail");
  if (input.namedContactsFound > 0) mediumSignals.push("namedContactFound");
  if (input.bestContactRankingTier === "MEDIUM_CONFIDENCE") mediumSignals.push("contact:MEDIUM_CONFIDENCE");

  const lowSignals: string[] = [];
  if (input.hasCareersPage) lowSignals.push("hasCareersPage");
  if (input.organizationalEmailsRisky > 0) lowSignals.push("riskyOrgEmail");
  if (input.bestContactRankingTier === "LOW_CONFIDENCE") lowSignals.push("contact:LOW_CONFIDENCE");

  let tier: HiringConfidenceTier;
  if (highTierReached) {
    tier = "HIGH";
  } else if (mediumSignals.length > 0) {
    tier = "MEDIUM";
    matchedSignals.push(...mediumSignals);
  } else if (lowSignals.length > 0) {
    tier = "LOW";
    matchedSignals.push(...lowSignals);
  } else {
    tier = "NONE";
  }

  const concreteEvidence =
    input.hiringSignalTitlesMatched.length > 0 || input.namedContactsFound > 0 || input.organizationalEmailsVerified > 0;

  return {
    tier,
    concreteEvidence,
    matchedSignals,
    confidenceVersion: HIRING_CONFIDENCE_VERSION,
  };
}
