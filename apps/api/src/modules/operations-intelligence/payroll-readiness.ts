/**
 * F9.7: Payroll Readiness -- puro, determinista, sin Prisma/fetch/LLM.
 * Evalúa si el período de un Worker está listo para entrar a un
 * PayrollRun (F5.7) -- NUNCA procesa pagos reales, NUNCA conecta a un
 * banco/ACH, NUNCA calcula impuestos definitivos. Es una señal de
 * lectura sobre datos que ya existen (TimeEntry/Worker.complianceStatus),
 * nunca un modelo persistido nuevo (a diferencia de PlacementReadiness,
 * F8.10) -- se recalcula en cada consulta.
 */

export const PAYROLL_READINESS_VERSION = 1;

export type PayrollReadinessStatus = "NOT_READY" | "NEEDS_REVIEW" | "READY_FOR_EXPORT" | "EXPORTED" | "BLOCKED";

/** Estados de TimeEntry que aún no llegaron a un punto de decisión humana -- el período no puede considerarse listo mientras alguno siga así. */
const UNRESOLVED_TIME_ENTRY_STATUSES = new Set(["DRAFT", "PENDING", "SUBMITTED"]);

export interface PayrollReadinessTimeEntryInput {
  status: string;
  overtimeFlag: boolean;
  discrepancyFlag: boolean;
}

export interface PayrollReadinessInput {
  workerComplianceStatus: string;
  timeEntries: PayrollReadinessTimeEntryInput[];
  /** true si ya existe un PayrollItem de este Worker dentro de un PayrollRun EXPORTED que cubre el período consultado. */
  alreadyExported: boolean;
}

export interface PayrollReadinessResult {
  status: PayrollReadinessStatus;
  blockers: string[];
  /** Informativo, nunca bloqueante por sí solo -- entradas ya APPROVED/LOCKED que llevan una bandera de revisión (un humano ya decidió aprobar a pesar de la señal). */
  reviewNotes: string[];
}

/**
 * Prioridad determinística: EXPORTED (hecho histórico, nunca se
 * reescribe por cambios posteriores de compliance) > BLOCKED (compliance
 * real) > NOT_READY (sin datos o con TimeEntries todavía en flujo/
 * rechazadas) > NEEDS_REVIEW (alguna entrada requiere revisión humana
 * explícita) > READY_FOR_EXPORT.
 */
export function evaluatePayrollReadiness(input: PayrollReadinessInput): PayrollReadinessResult {
  if (input.alreadyExported) {
    return { status: "EXPORTED", blockers: [], reviewNotes: [] };
  }

  const blockers: string[] = [];
  if (input.workerComplianceStatus === "BLOCKED") {
    blockers.push("Worker compliance status is BLOCKED");
  }
  if (blockers.length > 0) {
    return { status: "BLOCKED", blockers, reviewNotes: [] };
  }

  if (input.timeEntries.length === 0) {
    return { status: "NOT_READY", blockers: ["No time entries logged for this period"], reviewNotes: [] };
  }

  const unresolvedCount = input.timeEntries.filter((e) => UNRESOLVED_TIME_ENTRY_STATUSES.has(e.status)).length;
  const rejectedCount = input.timeEntries.filter((e) => e.status === "REJECTED").length;
  if (unresolvedCount > 0 || rejectedCount > 0) {
    const notReadyBlockers: string[] = [];
    if (unresolvedCount > 0) notReadyBlockers.push(`${unresolvedCount} time entr${unresolvedCount === 1 ? "y is" : "ies are"} still in progress (not yet approved)`);
    if (rejectedCount > 0) notReadyBlockers.push(`${rejectedCount} time entr${rejectedCount === 1 ? "y was" : "ies were"} rejected and need correction`);
    return { status: "NOT_READY", blockers: notReadyBlockers, reviewNotes: [] };
  }

  const needsReviewCount = input.timeEntries.filter((e) => e.status === "NEEDS_REVIEW").length;
  if (needsReviewCount > 0) {
    return {
      status: "NEEDS_REVIEW",
      blockers: [`${needsReviewCount} time entr${needsReviewCount === 1 ? "y" : "ies"} flagged for manual review`],
      reviewNotes: [],
    };
  }

  // A este punto todas las entradas están APPROVED o LOCKED.
  const reviewNotes: string[] = [];
  const flaggedButApproved = input.timeEntries.filter((e) => e.overtimeFlag || e.discrepancyFlag).length;
  if (flaggedButApproved > 0) {
    reviewNotes.push(`${flaggedButApproved} approved entr${flaggedButApproved === 1 ? "y carries" : "ies carry"} an overtime/discrepancy flag -- already reviewed by a human, informational only`);
  }

  return { status: "READY_FOR_EXPORT", blockers: [], reviewNotes };
}
