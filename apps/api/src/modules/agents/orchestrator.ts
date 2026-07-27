import { DEFAULT_POLICY_ENVELOPE, type AgentExecutionContext, type AgentExecutor } from "@ai-staffing-os/agents";
import { claimNextTasks, DEFAULT_LEASE_MS } from "../../core/queue/postgres-queue";
import { recordTaskSuccess, recordTaskFailure, heartbeatTask } from "./task-lifecycle";
import { publishEvent } from "../../core/events/outbox";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { logger } from "../../core/logger";

/**
 * F25.2 Fase 4: Orchestrator real -- reemplaza el prototipo dry-run
 * (packages/agents/src/orchestrator/DryRunOrchestrator.ts) con la
 * misma forma (claim -> ejecutar -> completar/reintentar/bloquear ->
 * publicar eventos) pero contra infraestructura real: claimNextTasks
 * (Fase 3, Postgres SKIP LOCKED), recordTaskSuccess/recordTaskFailure
 * (Fase 1), publishEvent (Fase 2).
 *
 * "No ejecutar acciones externas todavía": el Orchestrator en sí NO
 * tiene ningún AgentExecutor registrado por defecto -- es un registro
 * vacío hasta que Fase 6/7/8 conviertan Discovery/Contact
 * Intelligence/Quality en AgentExecutor real y se registren acá. Sin
 * ejecutores registrados, `runOnce` no reclama ni ejecuta nada (ver
 * el guard explícito más abajo). Todo lo que corre hoy son
 * AgentExecutor SINTÉTICOS de test, igual que el prototipo dry-run.
 *
 * `hasCapability` (ADR-0007) todavía NO se aplica acá como gate --
 * coincide con el roadmap (F25.5: "solo logueando violaciones, sin
 * bloquear todavía"). `policyEnvelope`/`capabilities` del contexto
 * usan el default más restrictivo (DEFAULT_POLICY_ENVELOPE, sin
 * capacidades) hasta que exista una resolución real por tenant.
 */

export interface OrchestratorRunMetrics {
  claimed: number;
  completed: number;
  retried: number;
  blocked: number;
  humanReview: number;
  failed: number;
  eventsPublished: number;
}

function emptyMetrics(): OrchestratorRunMetrics {
  return { claimed: 0, completed: 0, retried: 0, blocked: 0, humanReview: 0, failed: 0, eventsPublished: 0 };
}

export class Orchestrator {
  private readonly executors = new Map<string, AgentExecutor>();

  registerExecutor(executor: AgentExecutor): void {
    this.executors.set(executor.taskType, executor);
  }

  hasExecutor(taskType: string): boolean {
    return this.executors.has(taskType);
  }

  /**
   * Reclama y ejecuta hasta `limit` tareas de los tipos registrados.
   * Cada tarea corre dentro de su propio `runWithTenancyContext` --
   * el Orchestrator cruza tenants (mismo criterio que scheduler.ts y
   * el dispatcher del outbox), pero cada ejecución individual es
   * tenant-scoped como cualquier otro código de negocio.
   */
  async runOnce(workerId: string, limit = 10, leaseMs: number = DEFAULT_LEASE_MS): Promise<OrchestratorRunMetrics> {
    const metrics = emptyMetrics();
    const registeredTypes = [...this.executors.keys()];
    if (registeredTypes.length === 0) return metrics; // sin ejecutores -- nunca reclama nada (ver docstring)

    const claimedTasks = await claimNextTasks(workerId, limit, leaseMs, { types: registeredTypes });
    metrics.claimed = claimedTasks.length;

    for (const task of claimedTasks) {
      await runWithTenancyContext({ tenantId: task.tenantId, userId: "system-orchestrator", permissions: [] }, async () => {
        const executor = this.executors.get(task.type);
        if (!executor) {
          // No debería pasar -- claimNextTasks solo pide `registeredTypes` -- pero un AgentTask nunca debe quedar RUNNING para siempre.
          await recordTaskFailure(task.id, new Error(`Orchestrator: no hay AgentExecutor registrado para type="${task.type}"`));
          metrics.failed += 1;
          return;
        }

        const context: AgentExecutionContext = {
          tenantId: task.tenantId,
          agentInstanceId: task.agentInstanceId,
          taskId: task.id,
          triggeredBy: task.triggeredBy,
          correlationId: task.correlationId ?? task.id,
          causationId: task.causationId,
          capabilities: [],
          policyEnvelope: DEFAULT_POLICY_ENVELOPE,
        };

        let parsedInput: unknown;
        try {
          parsedInput = executor.inputSchema.parse(task.input);
        } catch (err) {
          await recordTaskFailure(task.id, err);
          metrics.failed += 1;
          return;
        }

        // Bug real encontrado en auditoría: heartbeatTask (Fase 1, ya
        // probado) nunca se llamaba desde ningún camino de producción --
        // un executor real (p.ej. draft_outreach, llamada real a un LLM)
        // que tarde más que `leaseMs` (5 min default) hace que
        // reclaimExpiredLeases() libere el lease MIENTRAS execute()
        // sigue corriendo de verdad. Un segundo tick del scheduler
        // reclama la misma fila y la ejecuta en paralelo; cuando el
        // primer execute() finalmente resuelve, recordTaskSuccess/
        // recordTaskFailure la pisan sin chequear si el lease seguía
        // siendo suyo -- doble ejecución real y un lost-update en el
        // estado final de la tarea. Renovar el lease en cada intervalo
        // mientras execute() sigue en vuelo cierra la ventana; el
        // heartbeat se detiene apenas execute() resuelve (éxito o error).
        const heartbeatIntervalMs = Math.floor(leaseMs / 2);
        const heartbeatHandle = setInterval(() => {
          heartbeatTask(task.id, workerId, leaseMs).catch((err) => {
            logger.error("orchestrator_heartbeat_failed", { taskId: task.id, workerId, message: err instanceof Error ? err.message : String(err) });
          });
        }, heartbeatIntervalMs);

        let result;
        try {
          result = await executor.execute(context, parsedInput);
        } finally {
          clearInterval(heartbeatHandle);
        }

        if (result.success) {
          await recordTaskSuccess(task.id, result.output);
          metrics.completed += 1;
          for (const event of result.events) {
            await publishEvent(event);
            metrics.eventsPublished += 1;
          }
          return;
        }

        const { task: updated, retryScheduled } = await recordTaskFailure(task.id, result.error);
        if (retryScheduled) metrics.retried += 1;
        else if (updated.status === "BLOCKED") metrics.blocked += 1;
        else if (updated.status === "HUMAN_REVIEW") metrics.humanReview += 1;
        else metrics.failed += 1;
      });
    }

    logger.info("orchestrator_run_once", { workerId, ...metrics });
    return metrics;
  }
}
