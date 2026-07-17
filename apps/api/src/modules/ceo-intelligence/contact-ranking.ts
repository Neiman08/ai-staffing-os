/**
 * F7.8: Contact Verification and Ranking -- puro, determinista, sin
 * Prisma/fetch/LLM (mismo criterio que el resto de ceo-intelligence/).
 * Combina la evidencia YA disponible sobre un Contact recién descubierto
 * (F7.7) en un score 0-1 y un tier auditable -- nunca decide con un
 * modelo probabilístico ni un LLM, cada punto del score tiene una razón
 * literal en `reasons`.
 *
 * Factores pedidos por el PO, mapeados 1:1 a evidencia real disponible:
 * - company match: el Contact vino de una búsqueda YA escopeada a esa
 *   Company (F7.7) -- si por algún motivo la evidencia lo contradice,
 *   `companyMatch: false` fuerza REJECTED.
 * - domain match: `domainTrust` (email-trust.ts, F7.4/F7.7).
 * - role match: `roleMatch`/`rolePriority` (rolePlan de F7.6).
 * - authority: `authorityLevel`, derivado de ContactDecisionRole.
 * - mission relevance: prioridad del rol matcheado dentro del rolePlan.
 * - provider reliability: `providerStatus` (provider-health.ts).
 * - email verification: `emailVerificationStatus` (Contact, F4.7).
 * - recency: `discoveredAt`.
 * - evidence: `discoveryConfidenceScore` (F4.6, completitud de campos).
 */

export const CONTACT_RANKING_VERSION = 1;

export const contactRankingTierValues = ["HIGH_CONFIDENCE", "MEDIUM_CONFIDENCE", "LOW_CONFIDENCE", "REJECTED"] as const;
export type ContactRankingTier = (typeof contactRankingTierValues)[number];

export type ContactAuthorityLevel = "EXECUTIVE" | "MANAGER" | "SPECIALIST" | "UNKNOWN";

const EXECUTIVE_ROLES = new Set(["OWNER", "GENERAL_MANAGER", "DIRECTOR_OF_OPERATIONS"]);
const MANAGER_ROLES = new Set(["OPERATIONS_MANAGER", "PLANT_MANAGER", "WAREHOUSE_MANAGER", "PURCHASING_MANAGER", "PROJECT_MANAGER"]);
const SPECIALIST_ROLES = new Set(["HR", "RECRUITER", "TALENT_ACQUISITION"]);

/** Nunca inventa una categoría -- OTHER/null/desconocido siempre caen en UNKNOWN. */
export function classifyAuthorityLevel(decisionRole: string | null): ContactAuthorityLevel {
  if (!decisionRole) return "UNKNOWN";
  if (EXECUTIVE_ROLES.has(decisionRole)) return "EXECUTIVE";
  if (MANAGER_ROLES.has(decisionRole)) return "MANAGER";
  if (SPECIALIST_ROLES.has(decisionRole)) return "SPECIALIST";
  return "UNKNOWN";
}

export interface ContactRankingInput {
  companyMatch: boolean;
  domainTrust: "VERIFIED" | "RISKY" | "INVALID" | "UNKNOWN" | null;
  roleMatch: boolean;
  rolePriority: number | null;
  authorityLevel: ContactAuthorityLevel;
  emailVerificationStatus: "VERIFIED" | "RISKY" | "INVALID" | "NOT_VERIFIED" | "UNKNOWN";
  discoveryConfidenceScore: number;
  providerStatus: "AVAILABLE" | "CREDIT_EXHAUSTED" | "UNAUTHORIZED" | "UNAVAILABLE" | "NOT_CONFIGURED";
  discoveredAt: string | Date;
  now?: string | Date;
}

export interface ContactRankingResult {
  score: number;
  tier: ContactRankingTier;
  reasons: string[];
  rankingVersion: number;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

export function rankContact(input: ContactRankingInput): ContactRankingResult {
  const reasons: string[] = [];

  // Señales críticas: cualquiera de estas fuerza REJECTED, sin importar
  // qué tan bien puntúen las demás -- un contacto que no matchea la
  // empresa, cuyo dominio de email es ajeno, o cuyo email se confirmó
  // inválido, nunca es "de baja confianza": es directamente descartable.
  if (!input.companyMatch) {
    reasons.push("La evidencia no confirma que el contacto pertenezca a esta empresa.");
    return { score: 0, tier: "REJECTED", reasons, rankingVersion: CONTACT_RANKING_VERSION };
  }
  if (input.domainTrust === "INVALID") {
    reasons.push("El dominio del email personal no corresponde al de la empresa (domain match inválido).");
    return { score: 0, tier: "REJECTED", reasons, rankingVersion: CONTACT_RANKING_VERSION };
  }
  if (input.emailVerificationStatus === "INVALID") {
    reasons.push("El email personal se verificó como inválido.");
    return { score: 0, tier: "REJECTED", reasons, rankingVersion: CONTACT_RANKING_VERSION };
  }

  let score = 0.2;
  reasons.push("Contacto real con nombre confirmado y empresa matcheada (base).");

  if (!input.roleMatch) {
    score -= 0.3;
    reasons.push("Sin coincidencia clara de rol planificado.");
  } else {
    score += 0.15;
    reasons.push("Rol matcheado contra el plan de roles de decisión (F7.6).");
    if (input.rolePriority === 1) {
      score += 0.1;
      reasons.push("Rol de máxima prioridad en el plan de la misión.");
    } else if (input.rolePriority === 2) {
      score += 0.05;
      reasons.push("Rol de alta prioridad en el plan de la misión.");
    }
  }

  if (input.domainTrust === "VERIFIED") {
    score += 0.25;
    reasons.push("Dominio del email personal verificado contra el sitio oficial de la empresa.");
  } else if (input.domainTrust === "RISKY") {
    score += 0.1;
    reasons.push("Dominio del email personal es de un proveedor gratuito/genérico (riesgo moderado).");
  }

  if (input.authorityLevel === "EXECUTIVE") {
    score += 0.15;
    reasons.push("Nivel de autoridad ejecutivo.");
  } else if (input.authorityLevel === "MANAGER") {
    score += 0.1;
    reasons.push("Nivel de autoridad gerencial.");
  } else if (input.authorityLevel === "SPECIALIST") {
    score += 0.08;
    reasons.push("Nivel de autoridad especializado (RRHH/reclutamiento).");
  }

  if (input.emailVerificationStatus === "VERIFIED") {
    score += 0.15;
    reasons.push("Email personal verificado por un proveedor real.");
  } else if (input.emailVerificationStatus === "RISKY") {
    score += 0.05;
    reasons.push("Email personal encontrado pero de verificación riesgosa.");
  }

  score += Math.max(0, Math.min(1, input.discoveryConfidenceScore)) * 0.15;
  reasons.push(`Evidencia de descubrimiento: confidence ${input.discoveryConfidenceScore.toFixed(2)}.`);

  if (input.providerStatus === "AVAILABLE") {
    score += 0.05;
    reasons.push("Proveedor de datos disponible y confiable al momento del descubrimiento.");
  }

  const now = input.now ? new Date(input.now) : new Date();
  const discoveredAt = new Date(input.discoveredAt);
  const ageDays = daysBetween(now, discoveredAt);
  if (ageDays <= 30) {
    score += 0.05;
    reasons.push("Descubierto en los últimos 30 días.");
  } else if (ageDays <= 90) {
    score += 0.02;
    reasons.push("Descubierto en los últimos 90 días.");
  } else {
    reasons.push("Descubierto hace más de 90 días -- la evidencia puede estar desactualizada.");
  }

  score = Math.max(0, Math.min(1, score));

  const tier: ContactRankingTier = score >= 0.75 ? "HIGH_CONFIDENCE" : score >= 0.5 ? "MEDIUM_CONFIDENCE" : "LOW_CONFIDENCE";

  return { score, tier, reasons, rankingVersion: CONTACT_RANKING_VERSION };
}
