// F6.2: evaluación de disponibilidad real de un Worker para un Job
// Order concreto — función PURA (no importa Prisma, ver
// availability-loader.ts para el adapter que sí lo hace). Determinista,
// sin IA, sin llamadas externas, sin escritura. Ver
// docs/F6_AUTONOMOUS_RECRUITING_AND_OPERATIONS_PLAN.md §32 para las
// reglas aprobadas y su justificación.

import type { AvailabilityStatus, MatchEligibility, WorkerAvailabilityResult } from "@ai-staffing-os/shared";
import { doDateRangesOverlap } from "./date-overlap";

// Solo los 4 valores reales de AssignmentStatus/WorkerStatus (schema.prisma)
// — como strings, no el enum de Prisma, mismo criterio ya usado en los
// contratos de F6.1 (packages/shared no depende del cliente generado).
const BLOCKING_ASSIGNMENT_STATUSES = new Set(["SCHEDULED", "ACTIVE"]);
const KNOWN_WORKER_STATUSES = new Set(["AVAILABLE", "ASSIGNED", "ON_LEAVE", "TERMINATED"]);

export interface AssignmentForAvailability {
  id: string;
  status: string;
  startDate: Date;
  endDate: Date | null;
}

export interface WorkerAvailabilityInput {
  workerId: string;
  workerStatus: string;
  // Todas las Assignments reales del Worker (cualquier status) — la
  // función filtra internamente cuáles bloquean; el llamador no debe
  // pre-filtrar para que el resultado sea auditable end-to-end.
  assignments: AssignmentForAvailability[];
  jobOrderStartDate: Date;
  jobOrderEndDate: Date | null;
}

function buildResult(
  input: WorkerAvailabilityInput,
  fields: {
    availabilityStatus: AvailabilityStatus;
    eligibility: MatchEligibility;
    hasDateConflict: boolean;
    conflictingAssignmentIds: string[];
    reason: string;
    warnings: string[];
  },
): WorkerAvailabilityResult {
  return {
    workerId: input.workerId,
    availabilityStatus: fields.availabilityStatus,
    eligibility: fields.eligibility,
    hasDateConflict: fields.hasDateConflict,
    conflictingAssignmentIds: fields.conflictingAssignmentIds,
    evaluatedJobOrderStart: input.jobOrderStartDate.toISOString(),
    evaluatedJobOrderEnd: input.jobOrderEndDate?.toISOString() ?? null,
    reason: fields.reason,
    warnings: fields.warnings,
  };
}

/**
 * Determinista, sin IA. Reglas aprobadas (F6.2):
 * - TERMINATED / ON_LEAVE → WORKER_UNAVAILABLE / INELIGIBLE de inmediato,
 *   nunca se calculan solapamientos (ON_LEAVE explícitamente lo pide así).
 * - AVAILABLE / ASSIGNED → se evalúan por fechas: cualquier Assignment
 *   SCHEDULED/ACTIVE que solape con el Job Order bloquea: DATE_CONFLICT /
 *   INELIGIBLE. Sin conflicto → AVAILABLE / ELIGIBLE (elegible en cuanto
 *   a disponibilidad — no implica elegibilidad final, ver F6.3).
 * - Assignment COMPLETED/TERMINATED nunca bloquea, sin importar fechas.
 * - Un WorkerStatus no reconocido (defensivo, no debería ocurrir con el
 *   enum real) → UNKNOWN / REVIEW_REQUIRED, nunca se asume disponible.
 */
export function evaluateWorkerAvailability(input: WorkerAvailabilityInput): WorkerAvailabilityResult {
  if (!KNOWN_WORKER_STATUSES.has(input.workerStatus)) {
    return buildResult(input, {
      availabilityStatus: "UNKNOWN",
      eligibility: "REVIEW_REQUIRED",
      hasDateConflict: false,
      conflictingAssignmentIds: [],
      reason: `Unrecognized Worker.status value: "${input.workerStatus}"`,
      warnings: [`Worker.status "${input.workerStatus}" is not one of the known values — treated conservatively as needing review.`],
    });
  }

  if (input.workerStatus === "TERMINATED") {
    return buildResult(input, {
      availabilityStatus: "WORKER_UNAVAILABLE",
      eligibility: "INELIGIBLE",
      hasDateConflict: false,
      conflictingAssignmentIds: [],
      reason: "Worker.status is TERMINATED — never available for a new match.",
      warnings: [],
    });
  }

  if (input.workerStatus === "ON_LEAVE") {
    return buildResult(input, {
      availabilityStatus: "WORKER_UNAVAILABLE",
      eligibility: "INELIGIBLE",
      hasDateConflict: false,
      conflictingAssignmentIds: [],
      reason: "Worker.status is ON_LEAVE — unavailable regardless of Assignment dates.",
      warnings: [],
    });
  }

  // AVAILABLE o ASSIGNED — ninguno de los dos es automáticamente
  // elegible/inelegible; se decide únicamente por solapamiento de fechas.
  const blockingAssignments = input.assignments.filter((a) => BLOCKING_ASSIGNMENT_STATUSES.has(a.status));
  const conflicting = blockingAssignments.filter((a) =>
    doDateRangesOverlap(a.startDate, a.endDate, input.jobOrderStartDate, input.jobOrderEndDate),
  );

  if (conflicting.length > 0) {
    return buildResult(input, {
      availabilityStatus: "DATE_CONFLICT",
      eligibility: "INELIGIBLE",
      hasDateConflict: true,
      conflictingAssignmentIds: conflicting.map((a) => a.id),
      reason: `Worker has ${conflicting.length} overlapping SCHEDULED/ACTIVE assignment(s) for the evaluated Job Order dates.`,
      warnings: [],
    });
  }

  return buildResult(input, {
    availabilityStatus: "AVAILABLE",
    eligibility: "ELIGIBLE",
    hasDateConflict: false,
    conflictingAssignmentIds: [],
    reason:
      blockingAssignments.length > 0
        ? "No overlapping SCHEDULED/ACTIVE assignment found for the evaluated Job Order dates."
        : "Worker has no SCHEDULED/ACTIVE assignments.",
    warnings: [],
  });
}
