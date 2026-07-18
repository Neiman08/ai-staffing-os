import type { BadgeProps } from "@/components/ui/badge";

const SUCCESS = new Set([
  "CLIENT",
  "FILLED",
  "PLACED",
  "QUALIFIED",
  "VERIFIED",
  "COMPLIANT",
  "APPROVED",
  "ACCEPTED",
  "ACTIVE",
  "COMPLETED",
  "PAID",
  // F6.7: matching (eligibility/availability de WorkerMatchResult)
  "ELIGIBLE",
  "AVAILABLE",
  // F8.11: qualification/interview (F8.5/F8.9) -- estado ya aprobado/listo
  "HIGH",
  "APPROVED_FOR_SEND",
  // F9.9: onboarding (F9.1) listo para activar; readiness (F9.7/F9.8) ya
  // resuelta contra un run/invoice real -- hecho histórico, no se reescribe.
  "READY",
  "EXPORTED",
]);

const WARNING = new Set([
  "PROSPECT",
  "PARTIALLY_FILLED",
  "SCREENING",
  "PENDING_REVIEW",
  "PENDING",
  "LOCKED",
  "PRESENTED",
  "EXPIRING",
  "AWAITING_APPROVAL",
  "ASSISTED",
  // F6.7
  "REVIEW_REQUIRED",
  "DATE_CONFLICT",
  // F8.11: qualification/shortlist/interview/placement readiness (F8.5-F8.10)
  "POSSIBLY_QUALIFIED",
  "NEEDS_REVIEW",
  "READY_FOR_REVIEW",
  "HOLD",
  "NEEDS_AVAILABILITY",
  "READY_FOR_APPROVAL",
  "CONDITIONALLY_READY",
  "MEDIUM",
  // F9.9: onboarding/checklist (F9.1/F9.2) en curso, todavía requieren
  // acción humana; readiness (F9.7/F9.8) lista para el siguiente paso
  // manual (sweep de nómina / generar invoice); TimeEntry ya enviado
  // (F9.6), esperando revisión.
  "IN_PROGRESS",
  "DOCUMENTS_PENDING",
  "COMPLIANCE_REVIEW",
  "UNDER_REVIEW",
  "READY_FOR_EXPORT",
  "READY_FOR_INVOICE",
  "SUBMITTED",
]);

const DANGER = new Set([
  "INACTIVE",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "BLOCKED",
  "FAILED_CHECK",
  "CLOSED",
  "TERMINATED",
  "OVERDUE",
  "VOID",
  "MISSING",
  // F6.7
  "INELIGIBLE",
  "WORKER_UNAVAILABLE",
  // F8.11: qualification/shortlist/placement readiness (F8.5/F8.7/F8.10)
  "NOT_QUALIFIED",
  "REMOVED",
  "NOT_READY",
  "LOW",
  // F9.9: onboarding terminado (F9.1) -- mismo criterio que TERMINATED.
  "OFFBOARDED",
]);

const INFO = new Set([
  "LEAD",
  "NEW",
  "OPEN",
  "DRAFT",
  "SCHEDULED",
  "MANUAL",
  "FULL_AUTO",
  "SENT",
  // F9.9: onboarding/checklist (F9.1/F9.2) -- etapa temprana/no aplicable,
  // ni positiva ni negativa.
  "INVITED",
  "NOT_REQUESTED",
  "WAIVED",
]);

export function statusVariant(status: string): NonNullable<BadgeProps["variant"]> {
  const s = status.toUpperCase();
  if (SUCCESS.has(s)) return "success";
  if (WARNING.has(s)) return "warning";
  if (DANGER.has(s)) return "danger";
  if (INFO.has(s)) return "info";
  return "neutral";
}

export function formatStatusLabel(status: string): string {
  return status
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}
