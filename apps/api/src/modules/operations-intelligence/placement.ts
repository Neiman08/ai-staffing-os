/**
 * F9.4: Placement -- puro, determinista, sin Prisma/fetch/LLM.
 * `Placement` es la transición APROBADA entre reclutamiento y
 * operaciones -- un registro por par (candidateId, jobOrderId), nunca
 * se crea sin una `PlacementReadiness` YA evaluada (F8.10, consumida
 * como señal, nunca recalculada). Nunca se activa automáticamente:
 * `ACTIVE` es siempre una transición manual explícita, nunca el estado
 * de creación.
 */

export const PLACEMENT_VERSION = 1;

export type PlacementStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "READY_FOR_ONBOARDING"
  | "ACTIVE"
  | "COMPLETED"
  | "CANCELLED";

/**
 * Grafo de transiciones -- `CANCELLED` siempre puede reabrirse a
 * `DRAFT` (nunca un rechazo permanente); `COMPLETED` es terminal.
 * `PENDING_APPROVAL` puede retroceder a `DRAFT` (retirar la solicitud
 * de aprobación sin cancelar el placement completo).
 */
export const PLACEMENT_TRANSITIONS: Record<PlacementStatus, PlacementStatus[]> = {
  DRAFT: ["PENDING_APPROVAL", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "DRAFT", "CANCELLED"],
  APPROVED: ["READY_FOR_ONBOARDING", "CANCELLED"],
  READY_FOR_ONBOARDING: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: ["DRAFT"],
};

export function isValidPlacementTransition(from: PlacementStatus, to: PlacementStatus): boolean {
  if (from === to) return true;
  return PLACEMENT_TRANSITIONS[from].includes(to);
}

export type PlacementReadinessStatusLike = "NOT_READY" | "NEEDS_REVIEW" | "CONDITIONALLY_READY" | "READY_FOR_APPROVAL";

export interface PlacementTransitionCheckInput {
  targetStatus: PlacementStatus;
  payRate: number | null;
  billRate: number | null;
  placementReadinessStatus: PlacementReadinessStatusLike;
}

export interface PlacementTransitionCheckResult {
  blockers: string[];
  warnings: string[];
  /** `false` si hay al menos un blocker -- la transición debe rechazarse. */
  allowed: boolean;
}

/**
 * Valida las reglas de negocio de UNA transición ANTES de aplicarla
 * (además del grafo de estados, que valida la forma, no el contenido).
 * Nunca infiere payRate/billRate -- si faltan y el destino no es
 * DRAFT/CANCELLED, es un blocker duro. Nunca permite avanzar a un
 * estado operativo (`APPROVED`/`READY_FOR_ONBOARDING`/`ACTIVE`) si
 * `PlacementReadiness` indica `NOT_READY`.
 */
export function checkPlacementTransition(input: PlacementTransitionCheckInput): PlacementTransitionCheckResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const isAdvancingPastDraft = input.targetStatus !== "DRAFT" && input.targetStatus !== "CANCELLED";
  if (isAdvancingPastDraft && (input.payRate === null || input.billRate === null)) {
    blockers.push("payRate and billRate must both be explicitly set before advancing past DRAFT -- compensation is never inferred silently.");
  }

  const operationalTargets: PlacementStatus[] = ["APPROVED", "READY_FOR_ONBOARDING", "ACTIVE"];
  if (operationalTargets.includes(input.targetStatus)) {
    if (input.placementReadinessStatus === "NOT_READY") {
      blockers.push("Placement Readiness indicates NOT_READY -- cannot advance to an operational status.");
    } else if (input.placementReadinessStatus !== "READY_FOR_APPROVAL") {
      warnings.push(`Placement Readiness is ${input.placementReadinessStatus}, not READY_FOR_APPROVAL yet.`);
    }
  }

  return { blockers, warnings, allowed: blockers.length === 0 };
}
