/**
 * F8.2: Job Requirements and Qualification Rules -- puro, determinista,
 * sin Prisma/fetch/LLM (mismo criterio que `ceo-intelligence/` y
 * `matching/scoring.ts`, F6.3). Evalúa si un Candidate (etapa de
 * reclutamiento, ANTES de convertirse en Worker) cumple los requisitos
 * de un Job Order -- distinto y anterior al motor de matching de F6
 * (`matching/scoring.ts`), que opera sobre Worker ya activos. Ningún
 * atributo protegido (raza, género, edad, religión, nacionalidad,
 * discapacidad, embarazo, salud, etnia, fecha de nacimiento, estado
 * migratorio) participa -- ninguno de estos campos existe siquiera en
 * `QualificationCandidateInput`, ver `qualification-rules.test.ts` para
 * la prueba explícita de fairness (mismo criterio que
 * `matching/scoring.test.ts`).
 *
 * Esta fase entrega SOLO la evaluación de reglas (disqualifiers duros +
 * gaps blandos + razones auditables) -- la persistencia del estado de
 * 4 valores (QUALIFIED/POSSIBLY_QUALIFIED/NEEDS_REVIEW/NOT_QUALIFIED)
 * es F8.5, deliberadamente NO implementada acá para no mezclar fases.
 */

export const QUALIFICATION_RULES_VERSION = 1;

// Estados de un Candidate que nunca pueden calificar para NINGÚN Job
// Order -- terminal por diseño del CRM (ver Candidates.tsx: REJECTED y
// INACTIVE ya colapsan withdrawn/archived).
const INELIGIBLE_CANDIDATE_STATUSES = new Set(["REJECTED", "INACTIVE"]);

export interface QualificationDocument {
  documentTypeKey: string;
  status: "PENDING_REVIEW" | "VERIFIED" | "REJECTED" | "EXPIRED";
  expirationDate: string | Date | null;
}

export interface QualificationCandidateInput {
  candidateId: string;
  status: string; // CandidateStatus real
  categoryIds: string[]; // JobCategory.id reales del candidato
  yearsExperience: number | null;
  languages: string[];
  documents: QualificationDocument[];
}

export interface QualificationJobRequirements {
  categoryId: string;
  requiredDocumentTypeKeys: string[]; // JobOrder.requirements
  minYearsExperience: number | null;
  requiredLanguages: string[];
}

export interface QualificationEvaluationInput {
  candidate: QualificationCandidateInput;
  job: QualificationJobRequirements;
  now?: string | Date;
}

export interface QualificationEvaluationResult {
  hardDisqualifiers: string[];
  missingDocuments: string[];
  expiredDocuments: string[];
  experienceGap: boolean;
  languageGaps: string[];
  strengths: string[];
  reasons: string[];
  rulesVersion: number;
}

function isDocumentCurrentlyValid(doc: QualificationDocument, now: Date): boolean {
  if (doc.status !== "VERIFIED") return false;
  if (!doc.expirationDate) return true;
  return new Date(doc.expirationDate).getTime() > now.getTime();
}

/**
 * Evalúa las reglas de calificación de UN Candidate contra los
 * requisitos de UN Job Order. Nunca decide "contratar"/"colocar" --
 * solo reporta hechos verificables (documentos reales, categorías
 * reales, experiencia/idiomas declarados) con sus razones.
 */
export function evaluateCandidateQualification(input: QualificationEvaluationInput): QualificationEvaluationResult {
  const { candidate, job } = input;
  const now = input.now ? new Date(input.now) : new Date();

  const hardDisqualifiers: string[] = [];
  const reasons: string[] = [];
  const strengths: string[] = [];

  if (INELIGIBLE_CANDIDATE_STATUSES.has(candidate.status)) {
    hardDisqualifiers.push("candidate_status_ineligible");
    reasons.push(`El candidato tiene estado "${candidate.status}", no elegible para calificar.`);
  }

  if (!candidate.categoryIds.includes(job.categoryId)) {
    hardDisqualifiers.push("category_mismatch");
    reasons.push("El candidato no está asociado a la categoría de puesto requerida.");
  } else {
    strengths.push("Categoría de puesto coincide.");
  }

  const missingDocuments: string[] = [];
  const expiredDocuments: string[] = [];
  for (const requiredKey of job.requiredDocumentTypeKeys) {
    const matching = candidate.documents.filter((d) => d.documentTypeKey === requiredKey);
    const hasValid = matching.some((d) => isDocumentCurrentlyValid(d, now));
    if (hasValid) continue;

    const hasExpiredOnly = matching.some((d) => d.status === "VERIFIED" && d.expirationDate && new Date(d.expirationDate).getTime() <= now.getTime());
    if (hasExpiredOnly) {
      expiredDocuments.push(requiredKey);
      hardDisqualifiers.push(`document_expired:${requiredKey}`);
      reasons.push(`El documento requerido "${requiredKey}" está vencido.`);
    } else {
      missingDocuments.push(requiredKey);
      hardDisqualifiers.push(`missing_required_document:${requiredKey}`);
      reasons.push(`Falta el documento requerido "${requiredKey}" (no encontrado o no verificado).`);
    }
  }
  if (job.requiredDocumentTypeKeys.length > 0 && missingDocuments.length === 0 && expiredDocuments.length === 0) {
    strengths.push("Todos los documentos requeridos están presentes y vigentes.");
  }

  let experienceGap = false;
  if (job.minYearsExperience !== null) {
    if (candidate.yearsExperience === null || candidate.yearsExperience < job.minYearsExperience) {
      experienceGap = true;
      reasons.push(`Requiere ${job.minYearsExperience}+ años de experiencia; el candidato tiene ${candidate.yearsExperience ?? "experiencia no declarada"}.`);
    } else {
      strengths.push("Cumple la experiencia mínima requerida.");
    }
  }

  const languageGaps = job.requiredLanguages.filter((lang) => !candidate.languages.includes(lang));
  if (job.requiredLanguages.length > 0) {
    if (languageGaps.length > 0) reasons.push(`Faltan idiomas requeridos: ${languageGaps.join(", ")}.`);
    else strengths.push("Cumple todos los idiomas requeridos.");
  }

  if (reasons.length === 0) reasons.push("El candidato cumple todos los requisitos verificables del Job Order.");

  return {
    hardDisqualifiers,
    missingDocuments,
    expiredDocuments,
    experienceGap,
    languageGaps,
    strengths,
    reasons,
    rulesVersion: QUALIFICATION_RULES_VERSION,
  };
}
