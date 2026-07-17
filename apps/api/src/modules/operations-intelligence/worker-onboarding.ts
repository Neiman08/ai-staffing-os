/**
 * F9.1: Worker Onboarding -- puro, determinista, sin Prisma/fetch/LLM.
 * Lifecycle explícito del proceso de onboarding de un Candidate hacia
 * convertirse en Worker operativo para un Job Order específico --
 * distinto de `Worker.status` (disponibilidad operativa AVAILABLE/
 * ASSIGNED/ON_LEAVE/TERMINATED, F5.2) y de `Worker.complianceStatus`
 * (COMPLIANT/PENDING/BLOCKED, F5.5), que son dimensiones ortogonales
 * consumidas acá como señales, nunca reescritas.
 *
 * Reutiliza DIRECTAMENTE `PlacementReadiness.readinessStatus` (F8.10)
 * como señal de entrada -- nunca la recalcula. `INVITED` es un estado
 * interno/preview: nunca implica que se envió una invitación real
 * (no hay integración de email/SMS en este proyecto). Alcanzar `ACTIVE`
 * nunca crea ni activa un `Worker` -- eso sigue siendo responsabilidad
 * exclusiva del flujo ya existente `convertCandidateToWorker` (F5.2);
 * este módulo solo permite la transición a `ACTIVE` cuando un Worker ya
 * existe (creado por ese flujo separado, aprobado, no duplicado acá).
 */

export const WORKER_ONBOARDING_VERSION = 1;

export type OnboardingStatus =
  | "INVITED"
  | "IN_PROGRESS"
  | "DOCUMENTS_PENDING"
  | "COMPLIANCE_REVIEW"
  | "READY"
  | "ACTIVE"
  | "BLOCKED"
  | "OFFBOARDED";

/**
 * Grafo de transiciones -- mismo criterio que `SHORTLIST_REVIEW_TRANSITIONS`
 * (F8.7): `BLOCKED` siempre puede reabrirse a `IN_PROGRESS` (no es un
 * rechazo permanente), `OFFBOARDED` es terminal (una desvinculación real
 * no se "reabre" con este mismo registro -- si el candidato vuelve, se
 * inicia un onboarding nuevo para otro Job Order o el mismo).
 */
export const WORKER_ONBOARDING_TRANSITIONS: Record<OnboardingStatus, OnboardingStatus[]> = {
  INVITED: ["IN_PROGRESS", "BLOCKED", "OFFBOARDED"],
  IN_PROGRESS: ["DOCUMENTS_PENDING", "BLOCKED", "OFFBOARDED"],
  DOCUMENTS_PENDING: ["COMPLIANCE_REVIEW", "IN_PROGRESS", "BLOCKED", "OFFBOARDED"],
  COMPLIANCE_REVIEW: ["READY", "DOCUMENTS_PENDING", "BLOCKED", "OFFBOARDED"],
  READY: ["ACTIVE", "BLOCKED", "OFFBOARDED"],
  ACTIVE: ["BLOCKED", "OFFBOARDED"],
  BLOCKED: ["IN_PROGRESS", "OFFBOARDED"],
  OFFBOARDED: [],
};

export function isValidOnboardingTransition(from: OnboardingStatus, to: OnboardingStatus): boolean {
  if (from === to) return true;
  return WORKER_ONBOARDING_TRANSITIONS[from].includes(to);
}

/** Progreso fijo por etapa (0-100) -- determinista, documentado, no una heurística oculta. Se refinará con checklist real en F9.2 sin romper este contrato. */
const STAGE_PROGRESS: Record<OnboardingStatus, number> = {
  INVITED: 10,
  IN_PROGRESS: 30,
  DOCUMENTS_PENDING: 50,
  COMPLIANCE_REVIEW: 75,
  READY: 90,
  ACTIVE: 100,
  BLOCKED: 0,
  OFFBOARDED: 0,
};

export type PlacementReadinessStatusLike = "NOT_READY" | "NEEDS_REVIEW" | "CONDITIONALLY_READY" | "READY_FOR_APPROVAL";

export interface OnboardingProgressInput {
  status: OnboardingStatus;
  placementReadinessStatus: PlacementReadinessStatusLike;
  hasExistingWorker: boolean;
  workerComplianceStatus: "COMPLIANT" | "PENDING" | "BLOCKED" | null;
}

export interface OnboardingProgressResult {
  progress: number;
  blockers: string[];
  warnings: string[];
  nextBestAction: string;
  requiresApproval: true;
  rulesVersion: number;
}

/**
 * Evalúa el progreso, blockers, warnings y próxima acción SUGERIDA --
 * nunca cambia `status` (eso es una transición manual explícita, ver
 * `isValidOnboardingTransition`). `requiresApproval` es SIEMPRE `true`:
 * este módulo nunca autoriza avanzar a `ACTIVE` por sí mismo.
 */
export function evaluateOnboardingProgress(input: OnboardingProgressInput): OnboardingProgressResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (input.placementReadinessStatus === "NOT_READY") {
    blockers.push("Placement Readiness indica NOT_READY para este candidato y Job Order.");
  } else if (input.placementReadinessStatus === "NEEDS_REVIEW") {
    warnings.push("Placement Readiness indica NEEDS_REVIEW -- revisar antes de avanzar a COMPLIANCE_REVIEW.");
  }

  if (input.workerComplianceStatus === "BLOCKED") {
    blockers.push("El Worker asociado tiene complianceStatus BLOCKED.");
  } else if (input.workerComplianceStatus === "PENDING") {
    warnings.push("El Worker asociado tiene complianceStatus PENDING.");
  }

  if (input.status === "READY" && !input.hasExistingWorker) {
    blockers.push("No existe un Worker todavía -- debe convertirse el Candidate a Worker antes de activar.");
  }

  const nextBestAction = computeNextBestAction(input, blockers);

  return {
    progress: STAGE_PROGRESS[input.status],
    blockers,
    warnings,
    nextBestAction,
    requiresApproval: true,
    rulesVersion: WORKER_ONBOARDING_VERSION,
  };
}

function computeNextBestAction(input: OnboardingProgressInput, blockers: string[]): string {
  if (input.placementReadinessStatus === "NOT_READY") {
    return "Resolver los blockers de Placement Readiness antes de continuar el onboarding.";
  }
  if (input.status === "INVITED") {
    return "Confirmar recepción (preview interno) y avanzar a IN_PROGRESS.";
  }
  if (input.status === "IN_PROGRESS") {
    return "Recopilar documentos requeridos (avanzar a DOCUMENTS_PENDING).";
  }
  if (input.status === "DOCUMENTS_PENDING") {
    return "Verificar los documentos enviados (avanzar a COMPLIANCE_REVIEW).";
  }
  if (input.status === "COMPLIANCE_REVIEW") {
    return "Completar la revisión de compliance (avanzar a READY).";
  }
  if (input.status === "READY" && !input.hasExistingWorker) {
    return "Convertir al Candidate en Worker (flujo existente) antes de activar.";
  }
  if (input.status === "READY") {
    return "Activar el onboarding (avanzar a ACTIVE) -- requiere aprobación humana explícita.";
  }
  if (input.status === "ACTIVE") {
    return blockers.length > 0 ? "Resolver los blockers de compliance del Worker activo." : "Onboarding activo -- sin acción pendiente.";
  }
  if (input.status === "BLOCKED") {
    return "Resolver el motivo del bloqueo y reabrir a IN_PROGRESS, o desvincular (OFFBOARDED).";
  }
  return "Sin acción pendiente -- onboarding finalizado (OFFBOARDED).";
}
