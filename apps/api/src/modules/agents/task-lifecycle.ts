import {
  classifyError,
  computeBackoffMs,
  isRetryableCategory,
  type AgentErrorCategory,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";

/**
 * F25.2 Fase 1: transiciones de estado durables para AgentTask, sobre las
 * columnas de lease/retry/correlación agregadas en las migraciones
 * `f25_2_fase1_agent_task_lifecycle` y `f25_2_fase1_human_review_status`
 * (ADR-0004). Todas las funciones operan sobre UNA tarea a la vez y
 * asumen que ya corren dentro de runWithTenancyContext (mismo patrón que
 * el resto de este módulo, ver task-executor.ts). El reclamo masivo
 * concurrente (SKIP LOCKED sobre muchas tareas a la vez) es Fase 3 --
 * acá solo vive el vocabulario de transición de UNA tarea, que Fase 3 y
 * Fase 4 van a reusar.
 */

export const DEFAULT_LEASE_MS = 5 * 60 * 1000; // 5 min -- suficiente para un tool call real, ver task-executor.ts
export const DEFAULT_MAX_ATTEMPTS = 3;

// Categorías que nunca deben reintentarse pero tampoco son un error de
// programación -- terminan en BLOCKED (política/datos), no en el estado
// muerto FAILED. Espeja TERMINAL_STATUS_BY_CATEGORY del prototipo dry-run
// (packages/agents/src/orchestrator/DryRunOrchestrator.ts) -- misma
// semántica, ahora contra Postgres real.
const BLOCKED_CATEGORIES: ReadonlySet<AgentErrorCategory> = new Set(["POLICY_BLOCKED", "DATA_INSUFFICIENT"]);

function clearedLeaseFields() {
  return { claimedAt: null, claimedBy: null, leaseExpiresAt: null } as const;
}

async function requireTask(taskId: string) {
  const task = await scopedDb.agentTask.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError(404, "AGENT_TASK_NOT_FOUND", `AgentTask ${taskId} no existe`);
  return task;
}

/**
 * Toma el lease de una tarea reclamable: QUEUED, RETRY_SCHEDULED con
 * nextAttemptAt ya vencido, o CLAIMED/RUNNING cuyo lease ya expiró (un
 * worker anterior murió sin liberar la tarea). Cualquier otro estado
 * actual es un error de uso -- nunca se reclama una tarea DONE/BLOCKED/
 * CANCELED/FAILED silenciosamente.
 */
export async function claimTask(taskId: string, workerId: string, leaseMs: number = DEFAULT_LEASE_MS) {
  const task = await requireTask(taskId);
  const now = new Date();

  const reclaimableExpiredLease =
    (task.status === "CLAIMED" || task.status === "RUNNING") &&
    task.leaseExpiresAt !== null &&
    task.leaseExpiresAt.getTime() <= now.getTime();

  const readyForRetry = task.status === "RETRY_SCHEDULED" && (task.nextAttemptAt === null || task.nextAttemptAt.getTime() <= now.getTime());

  if (task.status !== "QUEUED" && !readyForRetry && !reclaimableExpiredLease) {
    throw new AppError(409, "AGENT_TASK_NOT_CLAIMABLE", `AgentTask ${taskId} no es reclamable (status=${task.status})`);
  }

  return scopedDb.agentTask.update({
    where: { id: taskId },
    data: {
      status: "CLAIMED",
      claimedAt: now,
      claimedBy: workerId,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
    },
  });
}

/** CLAIMED -> RUNNING, conserva el lease tal cual (no lo renueva). */
export async function startTask(taskId: string, workerId: string) {
  const task = await requireTask(taskId);
  if (task.status !== "CLAIMED" || task.claimedBy !== workerId) {
    throw new AppError(409, "AGENT_TASK_LEASE_MISMATCH", `AgentTask ${taskId} no está reclamada por worker="${workerId}" (status=${task.status}, claimedBy=${task.claimedBy ?? "null"})`);
  }
  return scopedDb.agentTask.update({ where: { id: taskId }, data: { status: "RUNNING" } });
}

/**
 * Heartbeat: renueva leaseExpiresAt para una tarea CLAIMED/RUNNING.
 * Fencing por workerId -- un worker que ya perdió su lease (otro la
 * reclamó tras expirar) no puede reclamar haberla renovado.
 */
export async function heartbeatTask(taskId: string, workerId: string, leaseMs: number = DEFAULT_LEASE_MS) {
  const task = await requireTask(taskId);
  if ((task.status !== "CLAIMED" && task.status !== "RUNNING") || task.claimedBy !== workerId) {
    throw new AppError(409, "AGENT_TASK_LEASE_MISMATCH", `AgentTask ${taskId} no tiene un lease activo de worker="${workerId}" (status=${task.status}, claimedBy=${task.claimedBy ?? "null"})`);
  }
  return scopedDb.agentTask.update({
    where: { id: taskId },
    data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
  });
}

export async function recordTaskSuccess(taskId: string, output: unknown, extra?: { tokensUsed?: number; costUsd?: number }) {
  return scopedDb.agentTask.update({
    where: { id: taskId },
    data: {
      status: "DONE",
      output: output as never,
      completedAt: new Date(),
      tokensUsed: extra?.tokensUsed,
      costUsd: extra?.costUsd,
      ...clearedLeaseFields(),
    },
  });
}

export interface RecordTaskFailureResult {
  task: Awaited<ReturnType<typeof requireTask>>;
  category: AgentErrorCategory;
  retryScheduled: boolean;
}

/**
 * Clasifica el error (reusa classifyError de packages/agents -- no hay
 * una segunda heurística acá) y decide la transición: reintento con
 * backoff+jitter si es retryable y quedan intentos, BLOCKED si es
 * política/datos insuficientes, HUMAN_REVIEW si requiere una decisión
 * humana, o FAILED (estado muerto) en cualquier otro caso -- incluido un
 * retryable que ya agotó maxAttempts. Nunca reintento infinito.
 */
export async function recordTaskFailure(taskId: string, error: unknown): Promise<RecordTaskFailureResult> {
  const existing = await requireTask(taskId);
  const category = classifyError(error);
  const message = error instanceof Error ? error.message : String(error);
  const nextAttempt = existing.attempt + 1;

  if (isRetryableCategory(category) && nextAttempt < existing.maxAttempts) {
    const task = await scopedDb.agentTask.update({
      where: { id: taskId },
      data: {
        status: "RETRY_SCHEDULED",
        attempt: nextAttempt,
        nextAttemptAt: new Date(Date.now() + computeBackoffMs({ attempt: nextAttempt })),
        lastErrorCategory: category,
        errorMessage: message,
        ...clearedLeaseFields(),
      },
    });
    return { task, category, retryScheduled: true };
  }

  const terminalStatus = category === "HUMAN_ACTION_REQUIRED" ? "HUMAN_REVIEW" : BLOCKED_CATEGORIES.has(category) ? "BLOCKED" : "FAILED";

  const task = await scopedDb.agentTask.update({
    where: { id: taskId },
    data: {
      status: terminalStatus,
      // attempt no avanza en una terminación -- solo RETRY_SCHEDULED lo incrementa (arriba).
      lastErrorCategory: category,
      errorMessage: message,
      completedAt: new Date(),
      ...clearedLeaseFields(),
    },
  });
  return { task, category, retryScheduled: false };
}

/**
 * Cancelación explícita -- humana o del sistema (p.ej. la misión padre
 * se canceló). Terminal: una tarea CANCELED nunca vuelve a reclamarse.
 * Permitida desde cualquier estado no-terminal (QUEUED/CLAIMED/RUNNING/
 * RETRY_SCHEDULED); cancelar una tarea ya terminal es un no-op reportado
 * como error de uso, no se pisa silenciosamente un resultado real.
 */
const TERMINAL_STATUSES = new Set(["DONE", "FAILED", "BLOCKED", "CANCELED", "HUMAN_REVIEW"]);

export async function cancelTask(taskId: string, canceledBy: string, reason?: string) {
  const task = await requireTask(taskId);
  if (TERMINAL_STATUSES.has(task.status)) {
    throw new AppError(409, "AGENT_TASK_ALREADY_TERMINAL", `AgentTask ${taskId} ya está en un estado terminal (status=${task.status}), no se puede cancelar`);
  }
  return scopedDb.agentTask.update({
    where: { id: taskId },
    data: {
      status: "CANCELED",
      canceledAt: new Date(),
      canceledBy,
      errorMessage: reason ?? task.errorMessage,
      completedAt: new Date(),
      ...clearedLeaseFields(),
    },
  });
}

/**
 * Reclama de vuelta UNA tarea cuyo lease expiró sin que el worker la
 * haya terminado (murió, se colgó, el proceso se reinició). Vuelve a
 * QUEUED si todavía hay intentos disponibles, o termina en FAILED si ya
 * no los hay -- un lease expirado cuenta como un intento fallido
 * (RETRYABLE_TIMEOUT), nunca queda en CLAIMED/RUNNING para siempre
 * (principio #8, "nunca un estado ambiguo"). El escaneo masivo de MUCHAS
 * tareas expiradas a la vez es responsabilidad de Fase 3 (queue) -- esta
 * función solo resuelve UNA tarea ya identificada como expirada.
 */
export async function reclaimExpiredLease(taskId: string) {
  const task = await requireTask(taskId);
  if (task.status !== "CLAIMED" && task.status !== "RUNNING") {
    throw new AppError(409, "AGENT_TASK_NO_LEASE", `AgentTask ${taskId} no tiene un lease para reclamar (status=${task.status})`);
  }
  if (task.leaseExpiresAt === null || task.leaseExpiresAt.getTime() > Date.now()) {
    throw new AppError(409, "AGENT_TASK_LEASE_ACTIVE", `AgentTask ${taskId} todavía tiene un lease vigente`);
  }
  return recordTaskFailure(taskId, new Error("Lease expirado: el worker no terminó la tarea dentro del tiempo asignado (timeout)"));
}
