/**
 * F8.5: Estados de calificación con razones auditables -- puro,
 * determinista, sin Prisma/fetch/LLM. Deriva el estado persistido de 4
 * valores (QUALIFIED/POSSIBLY_QUALIFIED/NEEDS_REVIEW/NOT_QUALIFIED) a
 * partir del `QualificationEvaluationResult` que ya produce F8.2
 * (`qualification-rules.ts`), SIN modificar ese módulo (ya cerrado) --
 * usa únicamente los campos que ya expone.
 *
 * Regla de derivación (documentada para auditoría, no solo el código):
 * - NOT_QUALIFIED: hay al menos un disqualifier "duro" no recuperable
 *   por el candidato en el corto plazo (estado inelegible, categoría no
 *   coincide, o un documento requerido está VENCIDO).
 * - NEEDS_REVIEW: el ÚNICO tipo de disqualifier presente es
 *   "missing_required_document" (documento faltante/no verificado) --
 *   a diferencia de un documento vencido, este caso es recuperable con
 *   una acción humana (subir/verificar el documento), así que amerita
 *   revisión en vez de un rechazo definitivo.
 * - POSSIBLY_QUALIFIED: no hay disqualifiers duros, pero sí gaps
 *   blandos (experiencia y/o idiomas) que no bloquean pero sí importan.
 * - QUALIFIED: no hay disqualifiers duros ni gaps blandos.
 */

import type { QualificationEvaluationResult } from "./qualification-rules";

export const QUALIFICATION_STATUS_VERSION = 1;

export type PersistedQualificationStatus = "QUALIFIED" | "POSSIBLY_QUALIFIED" | "NEEDS_REVIEW" | "NOT_QUALIFIED";

export interface QualificationStatusDerivation {
  status: PersistedQualificationStatus;
  reasons: string[];
  hardDisqualifiers: string[];
  rulesVersion: number;
}

const NOT_QUALIFIED_PREFIXES = ["candidate_status_ineligible", "category_mismatch", "document_expired:"];

function isNotQualifiedDisqualifier(code: string): boolean {
  return NOT_QUALIFIED_PREFIXES.some((prefix) => code === prefix || code.startsWith(prefix));
}

export function deriveQualificationStatus(result: QualificationEvaluationResult): QualificationStatusDerivation {
  const hasNotQualifiedDisqualifier = result.hardDisqualifiers.some(isNotQualifiedDisqualifier);
  const hasOnlyMissingDocumentDisqualifiers =
    result.hardDisqualifiers.length > 0 && !hasNotQualifiedDisqualifier;
  const hasSoftGaps = result.experienceGap || result.languageGaps.length > 0;

  let status: PersistedQualificationStatus;
  if (hasNotQualifiedDisqualifier) {
    status = "NOT_QUALIFIED";
  } else if (hasOnlyMissingDocumentDisqualifiers) {
    status = "NEEDS_REVIEW";
  } else if (hasSoftGaps) {
    status = "POSSIBLY_QUALIFIED";
  } else {
    status = "QUALIFIED";
  }

  return {
    status,
    reasons: result.reasons,
    hardDisqualifiers: result.hardDisqualifiers,
    rulesVersion: result.rulesVersion,
  };
}
