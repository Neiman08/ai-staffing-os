import { randomUUID } from "node:crypto";
import type { AgentStage } from "../core/AgentStage";
import type { AgentTaskExecutionStatus } from "../core/AgentTaskExecutionStatus";
import type { AgentErrorCategory } from "../core/AgentError";

/**
 * F25 Fase H: representación en memoria de una tarea -- espeja el
 * shape que `AgentTask` tendría DESPUÉS de la migración de F25.2
 * (columnas de lease de ADR-0004), pero sin ninguna tabla real. Nunca
 * se usa contra Postgres -- es exclusivamente el prototipo local.
 */
export interface DryRunTask {
  id: string;
  type: string;
  stage: AgentStage;
  status: AgentTaskExecutionStatus;
  input: unknown;
  output: unknown | null;
  correlationId: string;
  causationId: string | null;
  parentTaskId: string | null;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  lastErrorCategory: AgentErrorCategory | null;
  lastErrorMessage: string | null;
  createdAt: Date;
}

export type NewDryRunTask = Pick<DryRunTask, "type" | "stage" | "input" | "correlationId" | "causationId" | "parentTaskId"> &
  Partial<Pick<DryRunTask, "maxAttempts">>;

/**
 * `SKIP LOCKED` real (ADR-0001) no existe en memoria -- no hace falta,
 * un `Map` de un solo proceso ya es exclusión mutua. El prototipo
 * demuestra el CONTRATO (claim atómico, nunca la misma tarea dos
 * veces), no el mecanismo de concurrencia real de Postgres (eso se
 * prueba en F25.4 contra una DB real, ver roadmap).
 */
export class InMemoryTaskStore {
  private readonly tasks = new Map<string, DryRunTask>();

  create(input: NewDryRunTask): DryRunTask {
    const task: DryRunTask = {
      id: `task_${randomUUID()}`,
      type: input.type,
      stage: input.stage,
      status: "QUEUED",
      input: input.input,
      output: null,
      correlationId: input.correlationId,
      causationId: input.causationId,
      parentTaskId: input.parentTaskId,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 3,
      nextAttemptAt: null,
      lastErrorCategory: null,
      lastErrorMessage: null,
      createdAt: new Date(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /** Reclama hasta `limit` tareas QUEUED o RETRY_SCHEDULED cuyo nextAttemptAt ya venció -- las marca CLAIMED antes de devolverlas. */
  claimQueued(limit = 10): DryRunTask[] {
    const now = Date.now();
    const claimable = [...this.tasks.values()]
      .filter((t) => (t.status === "QUEUED" || t.status === "RETRY_SCHEDULED") && (t.nextAttemptAt === null || t.nextAttemptAt.getTime() <= now))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
    for (const task of claimable) task.status = "CLAIMED";
    return claimable;
  }

  update(id: string, patch: Partial<DryRunTask>): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`InMemoryTaskStore: tarea ${id} no existe`);
    Object.assign(task, patch);
  }

  get(id: string): DryRunTask | undefined {
    return this.tasks.get(id);
  }

  all(): DryRunTask[] {
    return [...this.tasks.values()];
  }
}
