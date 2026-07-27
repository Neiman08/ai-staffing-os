import type { AgentTaskStatus } from "@ai-staffing-os/db";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { logAuditEvent } from "../../core/audit-log";
import { logger } from "../../core/logger";
import { cancelTask } from "./task-lifecycle";

/**
 * F25.2 (activación controlada, Prioridad 8): control de ciclo de vida
 * de una misión piloto -- listar, pausar, reanudar, cancelar. "No crees
 * una tabla nueva": el AgentTask raíz (type="discover_companies") sigue
 * siendo la misión (mismo criterio que mission-producer.ts/observability.ts).
 *
 * El modelo viejo (mission-orchestrator.ts, applyMissionAction) no aplica
 * acá -- ese pausa/reanuda un ÚNICO loop en proceso de larga duración
 * (missionState en AgentTask.output, chequeado por checkForStop() en cada
 * iteración). La misión piloto NO es un loop: es una cadena de AgentTask
 * discretas que el EventDispatcher va creando reactivamente (Discovery ->
 * company.discovered.v1 -> find_contacts -> ... , ver pipeline-handlers.ts).
 * No hay ningún loop en proceso al que pausar.
 *
 * Por eso "pausar"/"cancelar" una misión piloto significa acá: (1) marcar
 * un estado de control en el AgentTask.output del task raíz
 * (`pilotMissionControl`, mismo patrón exacto que `missionState` del
 * modelo viejo -- Json, sin migración), que `isPilotMissionActive` lee
 * ANTES de que un handler de pipeline-handlers.ts cree la siguiente tarea
 * reactiva; y (2) para cancel específicamente, cancelar además
 * (`cancelTask`, ya real/terminal/con lease limpio) cualquier AgentTask
 * de la misma correlationId que siga en un estado no terminal ahora mismo
 * (QUEUED/CLAIMED/RUNNING/RETRY_SCHEDULED/AWAITING_APPROVAL/HUMAN_REVIEW).
 *
 * Límite documentado (no rediseño): una tarea ya CLAIMED por un worker en
 * este mismo instante sigue corriendo hasta que ese worker termine -- no
 * hay forma de interrumpir una ejecución en curso sin un mecanismo de
 * cancelación cooperativa que esta sesión no construye. cancelTask sí la
 * marca CANCELED igual (best-effort: el resultado de esa ejecución en
 * curso, cuando llegue, se descarta por el Orchestrator vía
 * TERMINAL_STATUSES en el próximo intento de recordTaskSuccess/Failure).
 */

const TERMINAL_TASK_STATUSES: AgentTaskStatus[] = ["DONE", "FAILED", "BLOCKED", "CANCELED", "HUMAN_REVIEW"];

export type PilotMissionControlState = "ACTIVE" | "PAUSED" | "CANCELED";

export interface PilotMissionSummary {
  missionTaskId: string;
  correlationId: string;
  status: string;
  controlState: PilotMissionControlState;
  pilotMeta: unknown;
  createdAt: Date;
  completedAt: Date | null;
}

function readControlState(output: unknown): PilotMissionControlState {
  const state = (output as { pilotMissionControl?: string } | null)?.pilotMissionControl;
  return state === "PAUSED" || state === "CANCELED" ? state : "ACTIVE";
}

function toSummary(t: {
  id: string;
  correlationId: string | null;
  status: string;
  output: unknown;
  input: unknown;
  createdAt: Date;
  completedAt: Date | null;
}): PilotMissionSummary {
  return {
    missionTaskId: t.id,
    correlationId: t.correlationId ?? t.id,
    status: t.status,
    controlState: readControlState(t.output),
    pilotMeta: (t.input as { pilotMeta?: unknown } | null)?.pilotMeta ?? null,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  };
}

/** Todas las misiones piloto del tenant actual (AgentTask raíz), más recientes primero. */
export async function listPilotMissions(): Promise<PilotMissionSummary[]> {
  const tasks = await scopedDb.agentTask.findMany({
    where: { type: "discover_companies", idempotencyKey: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return tasks.map(toSummary);
}

async function requireRootTask(missionTaskId: string) {
  const task = await scopedDb.agentTask.findUnique({ where: { id: missionTaskId } });
  if (!task || task.type !== "discover_companies") throw AppError.notFound("Misión piloto no encontrada");
  return task;
}

/**
 * Leído por pipeline-handlers.ts antes de crear cualquier tarea reactiva
 * de esta misión. `correlationId=null` (evento sin misión asociada) o sin
 * AgentTask raíz encontrado (evento que no viene de una misión piloto
 * controlada, p.ej. otro flujo futuro) -- nunca bloquea, no es su misión
 * que controlar.
 */
export async function isPilotMissionActive(correlationId: string | null): Promise<boolean> {
  if (!correlationId) return true;
  const root = await scopedDb.agentTask.findFirst({ where: { correlationId, type: "discover_companies" } });
  if (!root) return true;
  return readControlState(root.output) === "ACTIVE";
}

export async function pausePilotMission(missionTaskId: string): Promise<PilotMissionSummary> {
  const task = await requireRootTask(missionTaskId);
  if (readControlState(task.output) === "CANCELED") {
    throw new AppError(409, "MISSION_ALREADY_CANCELED", "Esta misión ya está cancelada -- no se puede pausar.");
  }
  const updated = await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { output: { ...((task.output as object) ?? {}), pilotMissionControl: "PAUSED" } as never },
  });
  // Bug real encontrado en auditoría: a diferencia de cancelPilotMission,
  // esta transición nunca quedaba en el AuditLog real -- solo en el
  // logger.info (no auditable/consultable vía GET /audit-log).
  await logAuditEvent({ action: "mission.pilot_paused", entityType: "agentTask", entityId: missionTaskId, after: { correlationId: task.correlationId } });
  logger.info("pilot_mission_paused", { missionTaskId, correlationId: task.correlationId });
  return toSummary(updated);
}

export async function resumePilotMission(missionTaskId: string): Promise<PilotMissionSummary> {
  const task = await requireRootTask(missionTaskId);
  if (readControlState(task.output) === "CANCELED") {
    throw new AppError(409, "MISSION_ALREADY_CANCELED", "Esta misión ya está cancelada -- no se puede reanudar.");
  }
  const updated = await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { output: { ...((task.output as object) ?? {}), pilotMissionControl: "ACTIVE" } as never },
  });
  // Bug real encontrado en auditoría: mismo hueco que pausePilotMission.
  await logAuditEvent({ action: "mission.pilot_resumed", entityType: "agentTask", entityId: missionTaskId, after: { correlationId: task.correlationId } });
  logger.info("pilot_mission_resumed", { missionTaskId, correlationId: task.correlationId });
  return toSummary(updated);
}

export async function cancelPilotMission(missionTaskId: string): Promise<PilotMissionSummary> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const task = await requireRootTask(missionTaskId);

  const nonTerminal = await scopedDb.agentTask.findMany({
    where: { correlationId: task.correlationId, status: { notIn: TERMINAL_TASK_STATUSES } },
  });
  for (const t of nonTerminal) {
    try {
      await cancelTask(t.id, ctx.userId, "Misión piloto cancelada por el usuario.");
    } catch (err) {
      // Ya se volvió terminal entre el findMany y este cancelTask (carrera
      // real pero benigna) -- no es un error de la cancelación de la misión.
      logger.warn("pilot_mission_cancel_task_skip", { missionTaskId, taskId: t.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const refreshed = await scopedDb.agentTask.findUniqueOrThrow({ where: { id: missionTaskId } });
  const updated = await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { output: { ...((refreshed.output as object) ?? {}), pilotMissionControl: "CANCELED" } as never },
  });

  await logAuditEvent({
    action: "mission.pilot_canceled",
    entityType: "agentTask",
    entityId: missionTaskId,
    after: { correlationId: task.correlationId, tasksCanceled: nonTerminal.length },
  });
  logger.warn("pilot_mission_canceled", { missionTaskId, correlationId: task.correlationId, tasksCanceled: nonTerminal.length });
  return toSummary(updated);
}
