import { isRetryableCategory, computeBackoffMs, type AgentErrorCategory } from "../core/AgentError";
import type { AgentResult } from "../core/AgentResult";
import { InMemoryTaskStore, type DryRunTask } from "./InMemoryTaskStore";
import { InMemoryEventBus } from "./InMemoryEventBus";

/**
 * F25 Fase H: prototipo local/dry-run del Orchestrator -- demuestra
 * que los contratos de Fase G (AgentResult, AgentError/classifyError,
 * AgentEventEnvelope, backoff con jitter) componen un flujo real de
 * claim -> ejecutar -> reintentar/bloquear/completar -> publicar
 * eventos, sin ninguna infraestructura real (Postgres/LLM/proveedores
 * externos). Nunca se conecta a producción -- ver
 * docs/F25_IMPLEMENTATION_ROADMAP.md F25.4/F25.5 para la versión real.
 */
export type DryRunHandler = (task: DryRunTask) => Promise<AgentResult<unknown>>;

// Terminal para esta categoría en el prototipo -- nunca reintenta,
// nunca queda en un estado ambiguo (principio #8).
const TERMINAL_STATUS_BY_CATEGORY: Partial<Record<AgentErrorCategory, DryRunTask["status"]>> = {
  POLICY_BLOCKED: "BLOCKED",
  INVALID_INPUT: "FAILED_FINAL",
  DATA_INSUFFICIENT: "BLOCKED",
  PERMANENT_PROVIDER_ERROR: "FAILED_FINAL",
  HUMAN_ACTION_REQUIRED: "HUMAN_REVIEW",
  UNKNOWN: "FAILED_FINAL",
};

export class DryRunOrchestrator {
  constructor(
    private readonly store: InMemoryTaskStore,
    private readonly bus: InMemoryEventBus,
    private readonly handlers: Map<string, DryRunHandler>,
    // Inyectable para tests -- el backoff real (computeBackoffMs) usa
    // segundos/minutos reales, un test no debería esperar minutos.
    private readonly backoff: (attempt: number) => number = (attempt) => computeBackoffMs({ attempt }),
  ) {}

  async runTask(task: DryRunTask): Promise<void> {
    this.store.update(task.id, { status: "RUNNING" });
    const handler = this.handlers.get(task.type);
    if (!handler) {
      this.store.update(task.id, { status: "FAILED_FINAL", lastErrorCategory: "INVALID_INPUT", lastErrorMessage: `Sin handler registrado para type="${task.type}"` });
      return;
    }

    const result = await handler(task);

    if (result.success) {
      this.store.update(task.id, { status: "COMPLETED", output: result.output });
      for (const event of result.events) this.bus.publish(event);
      return;
    }

    const category = result.error.category;
    const nextAttempt = task.attempt + 1;

    if (isRetryableCategory(category) && nextAttempt < task.maxAttempts) {
      this.store.update(task.id, {
        status: "RETRY_SCHEDULED",
        attempt: nextAttempt,
        nextAttemptAt: new Date(Date.now() + this.backoff(nextAttempt)),
        lastErrorCategory: category,
        lastErrorMessage: result.error.message,
      });
      return;
    }

    // Agotó maxAttempts siendo retryable, o nunca fue retryable --
    // termina, nunca reintento infinito (principio #13).
    const terminalStatus: DryRunTask["status"] = isRetryableCategory(category) ? "FAILED_FINAL" : (TERMINAL_STATUS_BY_CATEGORY[category] ?? "FAILED_FINAL");
    this.store.update(task.id, { status: terminalStatus, lastErrorCategory: category, lastErrorMessage: result.error.message });
  }

  /** Reclama y ejecuta hasta `limit` tareas disponibles AHORA MISMO -- devuelve cuántas corrió. */
  async drainOnce(limit = 10): Promise<number> {
    const claimed = this.store.claimQueued(limit);
    for (const task of claimed) await this.runTask(task);
    return claimed.length;
  }

  /**
   * Corre hasta que no quede ninguna tarea reclamable -- incluye
   * esperar a que venzan los `nextAttemptAt` de tareas en
   * RETRY_SCHEDULED. `maxTicks` evita un loop infinito real si algo
   * queda mal diseñado en un test (nunca cuelga la suite).
   */
  async runUntilIdle(params: { maxTicks?: number; tickDelayMs?: number } = {}): Promise<void> {
    const maxTicks = params.maxTicks ?? 200;
    const tickDelayMs = params.tickDelayMs ?? 5;
    for (let i = 0; i < maxTicks; i++) {
      const ran = await this.drainOnce();
      const stillPending = this.store.all().some((t) => t.status === "QUEUED" || t.status === "RETRY_SCHEDULED" || t.status === "CLAIMED" || t.status === "RUNNING");
      if (ran === 0 && !stillPending) return;
      if (ran === 0) await new Promise((resolve) => setTimeout(resolve, tickDelayMs));
    }
  }
}
