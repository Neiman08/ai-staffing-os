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
]);

const INFO = new Set(["LEAD", "NEW", "OPEN", "DRAFT", "SCHEDULED", "MANUAL", "FULL_AUTO", "SENT"]);

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
