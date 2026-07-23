/**
 * F25 Fase 1: vocabulario de estado operacional PROPUESTO -- ver
 * docs/F25_AUTONOMOUS_ORGANIZATION_MASTER_ARCHITECTURE.md §7 para el
 * mapeo completo contra el enum real de Prisma (`AgentTaskStatus`:
 * QUEUED, RUNNING, AWAITING_APPROVAL, DONE, FAILED -- sin cambios en
 * esta sesión). Este es un SUPERSET conceptual más fino, no un
 * reemplazo: distingue "reclamado pero no arrancó" de "ejecutando",
 * y "falla que puede reintentar" de "falla terminal" -- ninguna de las
 * dos distinciones existe hoy en el enum real.
 *
 * NO se aplica a `AgentTask.status` todavía -- eso es F25.2 (migración
 * aditiva que agrega las columnas de lease en la misma migración donde
 * tendría sentido extender el enum). Hasta entonces, este tipo es
 * puramente para código nuevo que necesite razonar sobre el estado más
 * fino ANTES de que la columna exista (ej. `classifyError`, que decide
 * "esto sería FAILED_RETRYABLE o FAILED_FINAL" sin que la DB todavía
 * distinga los dos).
 */
export const AGENT_TASK_EXECUTION_STATUSES = [
  "QUEUED",
  "CLAIMED",
  "RUNNING",
  "WAITING",
  "RETRY_SCHEDULED",
  "COMPLETED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "BLOCKED",
  "CANCELED",
  "HUMAN_REVIEW",
] as const;

export type AgentTaskExecutionStatus = (typeof AGENT_TASK_EXECUTION_STATUSES)[number];

// Mapeo hacia el enum REAL de Prisma (AgentTaskStatus) -- usado por
// cualquier código que necesite persistir hoy mismo, sin esperar F25.2.
// Nunca al revés (el enum real no se puede reconstruir sin pérdida de
// información desde el nuevo, por diseño -- ver docstring de arriba).
const TO_PRISMA_STATUS: Record<AgentTaskExecutionStatus, "QUEUED" | "RUNNING" | "AWAITING_APPROVAL" | "DONE" | "FAILED"> = {
  QUEUED: "QUEUED",
  CLAIMED: "RUNNING",
  RUNNING: "RUNNING",
  WAITING: "RUNNING",
  RETRY_SCHEDULED: "QUEUED",
  COMPLETED: "DONE",
  FAILED_RETRYABLE: "FAILED",
  FAILED_FINAL: "FAILED",
  BLOCKED: "FAILED",
  CANCELED: "FAILED",
  HUMAN_REVIEW: "AWAITING_APPROVAL",
};

export function toPrismaAgentTaskStatus(status: AgentTaskExecutionStatus): "QUEUED" | "RUNNING" | "AWAITING_APPROVAL" | "DONE" | "FAILED" {
  return TO_PRISMA_STATUS[status];
}
