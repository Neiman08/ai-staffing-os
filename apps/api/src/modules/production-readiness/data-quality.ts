/**
 * F4.7.5 §6: Data Quality Score — determinista, nunca decidido por un
 * LLM. Pesos fijos que suman 1.0 por entidad, documentados acá mismo
 * para que cualquiera pueda auditar por qué un registro puntuó como
 * puntuó. Se calcula al leer (no se persiste una columna nueva) —
 * volumen de datos chico, recalcular es barato y evita que el score
 * quede desactualizado silenciosamente.
 */
export interface QualityFactor {
  factor: string;
  weight: number;
  earned: number; // 0..weight
}

export interface QualityScoreResult {
  score: number; // 0..1
  factors: QualityFactor[];
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function recencyEarned(date: Date | null, weight: number): number {
  if (!date) return 0;
  const ageMs = Date.now() - date.getTime();
  return ageMs <= NINETY_DAYS_MS ? weight : 0;
}

export interface CompanyQualityInput {
  website: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  email: string | null;
  origin: string;
  updatedAt: Date;
  confidenceScore: number | null;
}

/** Company: website 0.15, teléfono 0.15, dirección 0.15, email 0.10, fuente conocida 0.15, actualizado <90d 0.10, confidence 0.20. */
export function computeCompanyQualityScore(c: CompanyQualityInput): QualityScoreResult {
  const factors: QualityFactor[] = [
    { factor: "website", weight: 0.15, earned: c.website ? 0.15 : 0 },
    { factor: "teléfono", weight: 0.15, earned: c.phone ? 0.15 : 0 },
    { factor: "dirección (ciudad+estado)", weight: 0.15, earned: c.city && c.state ? 0.15 : 0 },
    { factor: "email", weight: 0.1, earned: c.email ? 0.1 : 0 },
    { factor: "fuente real conocida", weight: 0.15, earned: c.origin !== "MANUAL" ? 0.15 : 0 },
    { factor: "actualizado en los últimos 90 días", weight: 0.1, earned: recencyEarned(c.updatedAt, 0.1) },
    { factor: "confidence score", weight: 0.2, earned: (c.confidenceScore ?? 0) * 0.2 },
  ];
  return { score: factors.reduce((sum, f) => sum + f.earned, 0), factors };
}

export interface ContactQualityInput {
  email: string | null;
  emailVerificationStatus: string;
  phone: string | null;
  linkedinUrl: string | null;
  source: string | null;
  discoveredAt: Date | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  confidenceScore: number | null;
}

/** Contact: email 0.15, email verificado 0.20, teléfono 0.10, LinkedIn 0.15, fuente 0.10, actualizado <90d 0.10, confidence 0.20. */
export function computeContactQualityScore(c: ContactQualityInput): QualityScoreResult {
  const mostRecentUpdate = [c.emailVerifiedAt, c.discoveredAt, c.createdAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0]!;
  const factors: QualityFactor[] = [
    { factor: "email", weight: 0.15, earned: c.email ? 0.15 : 0 },
    { factor: "email verificado", weight: 0.2, earned: c.emailVerificationStatus === "VERIFIED" ? 0.2 : 0 },
    { factor: "teléfono", weight: 0.1, earned: c.phone ? 0.1 : 0 },
    { factor: "LinkedIn", weight: 0.15, earned: c.linkedinUrl ? 0.15 : 0 },
    { factor: "fuente real conocida", weight: 0.1, earned: c.source ? 0.1 : 0 },
    { factor: "actualizado en los últimos 90 días", weight: 0.1, earned: recencyEarned(mostRecentUpdate, 0.1) },
    { factor: "confidence score", weight: 0.2, earned: (c.confidenceScore ?? 0) * 0.2 },
  ];
  return { score: factors.reduce((sum, f) => sum + f.earned, 0), factors };
}
