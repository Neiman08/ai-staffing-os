/**
 * F8.10: Placement Readiness -- puro, determinista, sin Prisma/fetch/
 * LLM. Agrega el estado YA calculado por F8.5 (qualification), F8.7
 * (shortlist), F8.8 (screening) y F8.9 (interview preview) -- nunca
 * vuelve a evaluar ninguno de ellos, solo los combina. Nunca crea un
 * Placement, nunca crea un Assignment, nunca activa un Worker, nunca
 * cambia `Candidate.status` de forma irreversible -- esta función solo
 * REPORTA, la decisión y cualquier acción siguen siendo 100% humanas.
 */

import type { QualificationEvaluationResult } from "./qualification-rules";
import type { PersistedQualificationStatus } from "./qualification-status";
import type { ShortlistReviewStatus } from "./candidate-shortlist";
import type { InterviewPreviewStatus } from "./interview-preview";

export const PLACEMENT_READINESS_VERSION = 1;

export type PlacementReadinessStatus = "NOT_READY" | "NEEDS_REVIEW" | "CONDITIONALLY_READY" | "READY_FOR_APPROVAL";

export interface PlacementReadinessInput {
  candidateId: string;
  jobOrderId: string;
  qualificationStatus: PersistedQualificationStatus;
  qualification: QualificationEvaluationResult;
  /** `null` = el candidato nunca se agregó a una shortlist para este Job Order. */
  shortlistReviewStatus: ShortlistReviewStatus | null;
  screeningPlanExists: boolean;
  screeningManualReviewFlags: string[];
  /** `null` = nunca se generó un preview de entrevista para este Job Order. */
  interviewPreviewStatus: InterviewPreviewStatus | null;
  candidateState: string | null;
  jobOrderState: string | null;
  jobOrderStartDate: string | Date;
}

export interface PlacementReadinessResult {
  candidateId: string;
  jobOrderId: string;
  readinessStatus: PlacementReadinessStatus;
  score: number;
  blockers: string[];
  warnings: string[];
  completedChecks: string[];
  pendingChecks: string[];
  missingInformation: string[];
  nextBestAction: string;
  /** SIEMPRE `true` -- esta función nunca autoriza una acción automática; un humano debe aprobar el siguiente paso sin importar el readinessStatus. */
  requiresApproval: true;
  evaluatedAt: string;
  rulesVersion: number;
}

const START_DATE_SOON_THRESHOLD_DAYS = 2;

export function computePlacementReadiness(input: PlacementReadinessInput, now: Date = new Date()): PlacementReadinessResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const completedChecks: string[] = [];
  const pendingChecks: string[] = [];
  const missingInformation: string[] = [];

  // ---- 1. Qualification (F8.5, reutilizado tal cual) ----
  if (input.qualificationStatus === "NOT_QUALIFIED") {
    blockers.push("El candidato no está calificado (NOT_QUALIFIED) para este Job Order.");
  } else if (input.qualificationStatus === "NEEDS_REVIEW") {
    blockers.push("La calificación requiere revisión manual de documentos (NEEDS_REVIEW).");
  } else if (input.qualificationStatus === "POSSIBLY_QUALIFIED") {
    warnings.push("El candidato es POSSIBLY_QUALIFIED -- hay gaps blandos (experiencia/idiomas) sin resolver.");
    completedChecks.push("qualification");
  } else {
    completedChecks.push("qualification");
  }

  // ---- 2. Documentos (F8.2, reutilizado tal cual -- nunca re-evaluado) ----
  if (input.qualification.expiredDocuments.length > 0) {
    blockers.push(`Documentos requeridos vencidos: ${input.qualification.expiredDocuments.join(", ")}.`);
  } else if (input.qualification.missingDocuments.length > 0) {
    blockers.push(`Documentos requeridos faltantes o no verificados: ${input.qualification.missingDocuments.join(", ")}.`);
  } else {
    completedChecks.push("documents");
  }

  // ---- 3. Shortlist (F8.7) ----
  if (input.shortlistReviewStatus === null) {
    pendingChecks.push("shortlist");
  } else if (input.shortlistReviewStatus === "APPROVED") {
    completedChecks.push("shortlist");
  } else if (input.shortlistReviewStatus === "REMOVED") {
    blockers.push("El candidato fue removido de la shortlist para este Job Order (REMOVED).");
  } else {
    warnings.push(`La shortlist aún no está APPROVED (estado actual: ${input.shortlistReviewStatus}).`);
  }

  // ---- 4. Screening (F8.8) ----
  if (!input.screeningPlanExists) {
    pendingChecks.push("screening");
  } else if (input.screeningManualReviewFlags.length > 0) {
    warnings.push("El plan de screening tiene banderas de revisión manual pendientes.");
  } else {
    completedChecks.push("screening");
  }

  // ---- 5. Interview preview (F8.9) ----
  if (input.interviewPreviewStatus === null) {
    pendingChecks.push("interview");
  } else if (input.interviewPreviewStatus === "CANCELLED") {
    blockers.push("El preview de entrevista fue CANCELLED.");
  } else if (input.interviewPreviewStatus === "APPROVED_FOR_SEND") {
    completedChecks.push("interview");
  } else {
    warnings.push(`El preview de entrevista aún no está APPROVED_FOR_SEND (estado actual: ${input.interviewPreviewStatus}).`);
  }

  // ---- 6. Ubicación ----
  if (input.candidateState && input.jobOrderState) {
    if (input.candidateState.trim().toLowerCase() === input.jobOrderState.trim().toLowerCase()) {
      completedChecks.push("location");
    } else {
      warnings.push(`El estado del candidato (${input.candidateState}) difiere del estado del Job Order (${input.jobOrderState}).`);
    }
  } else {
    missingInformation.push("No hay estado registrado del candidato o del Job Order para comparar ubicación.");
  }

  // ---- 7. Fecha de inicio ----
  const startDate = new Date(input.jobOrderStartDate);
  const daysUntilStart = (startDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (daysUntilStart < 0) {
    warnings.push("La fecha de inicio del Job Order ya pasó.");
  } else if (daysUntilStart <= START_DATE_SOON_THRESHOLD_DAYS && input.interviewPreviewStatus !== "APPROVED_FOR_SEND") {
    warnings.push(`La fecha de inicio es en ${Math.max(0, Math.round(daysUntilStart))} día(s) y la entrevista aún no está aprobada.`);
  } else {
    completedChecks.push("startDate");
  }

  // ---- 8. Compensación -- sin dato de expectativa salarial del candidato en el schema; se documenta como falta de información, nunca se inventa. ----
  missingInformation.push("No hay dato de compensación esperada del candidato para comparar contra JobOrder.payRate.");

  // ---- Derivación del estado final ----
  let readinessStatus: PlacementReadinessStatus;
  const hasHardBlocker =
    input.qualificationStatus === "NOT_QUALIFIED" ||
    input.interviewPreviewStatus === "CANCELLED" ||
    input.qualification.expiredDocuments.length > 0;

  if (hasHardBlocker) {
    readinessStatus = "NOT_READY";
  } else if (blockers.length > 0) {
    readinessStatus = "NEEDS_REVIEW";
  } else if (warnings.length > 0 || pendingChecks.length > 0) {
    readinessStatus = "CONDITIONALLY_READY";
  } else {
    readinessStatus = "READY_FOR_APPROVAL";
  }

  const applicableChecks = completedChecks.length + pendingChecks.length + blockers.length;
  const score = applicableChecks > 0 ? Math.round((completedChecks.length / applicableChecks) * 100) : 0;

  const nextBestAction = computeNextBestAction(input, blockers, pendingChecks);

  return {
    candidateId: input.candidateId,
    jobOrderId: input.jobOrderId,
    readinessStatus,
    score,
    blockers,
    warnings,
    completedChecks,
    pendingChecks,
    missingInformation,
    nextBestAction,
    requiresApproval: true,
    evaluatedAt: now.toISOString(),
    rulesVersion: PLACEMENT_READINESS_VERSION,
  };
}

/**
 * Prioridad fija y determinista -- la primera condición que aplica
 * decide, nunca se combinan/pesan entre sí (mismo criterio que
 * `deduplicateDiscoveryCandidates`, F7.3).
 */
function computeNextBestAction(input: PlacementReadinessInput, blockers: string[], pendingChecks: string[]): string {
  if (input.qualificationStatus === "NOT_QUALIFIED") {
    return "Revisar por qué el candidato es NOT_QUALIFIED antes de continuar -- no avanzar.";
  }
  if (input.qualification.expiredDocuments.length > 0) {
    return "Renovar los documentos vencidos antes de continuar.";
  }
  if (input.qualification.missingDocuments.length > 0) {
    return "Obtener y verificar los documentos requeridos faltantes.";
  }
  if (input.qualificationStatus === "NEEDS_REVIEW") {
    return "Completar la revisión manual de calificación pendiente.";
  }
  if (pendingChecks.includes("shortlist")) {
    return "Agregar al candidato a la shortlist del Job Order.";
  }
  if (blockers.some((b) => b.includes("REMOVED"))) {
    return "El candidato fue removido de la shortlist -- reabrir a DRAFT si se desea reconsiderar.";
  }
  if (pendingChecks.includes("screening")) {
    return "Generar el plan de screening para este candidato.";
  }
  if (pendingChecks.includes("interview")) {
    return "Generar un preview de programación de entrevista.";
  }
  if (input.interviewPreviewStatus === "CANCELLED") {
    return "El preview de entrevista fue cancelado -- generar uno nuevo si se desea continuar.";
  }
  if (input.interviewPreviewStatus !== "APPROVED_FOR_SEND") {
    return "Aprobar el preview de entrevista (APPROVED_FOR_SEND).";
  }
  if (input.shortlistReviewStatus !== "APPROVED") {
    return "Aprobar la entrada de shortlist del candidato.";
  }
  return "Todos los checks aplicables están completos -- listo para revisión humana final antes de cualquier placement.";
}
