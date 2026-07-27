import { Orchestrator } from "./orchestrator";
import { createDiscoveryExecutor } from "./executors/discovery.executor";
import { createContactIntelligenceExecutor } from "./executors/contact-intelligence.executor";
import { createQualityAgentExecutor } from "./executors/quality.executor";
import { createDraftExecutor } from "./executors/draft.executor";
import { reclaimExpiredLeases } from "../../core/queue/postgres-queue";
import { EventDispatcher } from "../../core/events/dispatcher";
import { registerPipelineHandlers } from "./pipeline-handlers";
import { logger } from "../../core/logger";
import { PIPELINE_FLAGS, type PipelineFlags } from "../../core/pipeline-flags";

/**
 * F25.2 (consolidación): worker autónomo real -- claim+ejecución
 * (Orchestrator, Fase 4), recuperación de leases vencidos (Fase 3),
 * despacho de eventos (dispatcher.ts) en un único tick periódico,
 * mismo patrón `setInterval` que scheduler.ts/compliance/billing
 * (ver apps/api/src/index.ts).
 *
 * SOLO tareas internas seguras: los 4 AgentExecutor registrados
 * (discover_companies, find_contacts, evaluate_draft_quality,
 * draft_outreach) nunca envían un email, nunca agendan una reunión,
 * nunca ejecutan una acción irreversible hacia un tercero real. El
 * draft_outreach (F26) SÍ llama a un LLM real y SÍ crea un
 * ApprovalRequest real -- pero un ApprovalRequest nunca se envía solo;
 * el único camino de envío real (sendApproval, approvals/service.ts,
 * Microsoft Graph) exige un click humano explícito en "Approve & Send"
 * y no lee nada de este Orchestrator ni de PIPELINE_FLAGS. Ningún
 * AgentExecutor de envío/reunión existe en este registro.
 */

const TICK_INTERVAL_MS = 30_000;
const ORCHESTRATOR_CLAIM_LIMIT = 10;
const WORKER_ID = "autonomous-worker-1";

/**
 * Cada AgentExecutor se registra SOLO si su flag específico está
 * encendido -- un flag apagado significa que ese ejecutor ni siquiera
 * existe para el Orchestrator, no es una comprobación que el ejecutor
 * podría saltarse (ver pipeline-flags.ts: "no permitas que esos flags
 * puedan ser ignorados por un agente").
 */
export function buildProductionOrchestrator(flags: PipelineFlags = PIPELINE_FLAGS): Orchestrator {
  const orchestrator = new Orchestrator();
  if (flags.discoveryAgentEnabled) orchestrator.registerExecutor(createDiscoveryExecutor());
  if (flags.contactIntelligenceAgentEnabled) orchestrator.registerExecutor(createContactIntelligenceExecutor());
  if (flags.qualityAgentEnabled) orchestrator.registerExecutor(createQualityAgentExecutor());
  if (flags.draftAgentEnabled) orchestrator.registerExecutor(createDraftExecutor());
  return orchestrator;
}

export function buildProductionEventDispatcher(flags: PipelineFlags = PIPELINE_FLAGS): EventDispatcher {
  const dispatcher = new EventDispatcher();
  if (flags.eventHandlersEnabled) registerPipelineHandlers(dispatcher, flags);
  return dispatcher;
}

let orchestrator: Orchestrator | null = null;
let dispatcher: EventDispatcher | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

export interface AutonomousWorkerTickResult {
  orchestrator: Awaited<ReturnType<Orchestrator["runOnce"]>>;
  reclaimedTaskIds: string[];
  eventDispatch: Awaited<ReturnType<EventDispatcher["runOnce"]>>;
}

/**
 * Un tick completo -- exportado (a diferencia del resto del módulo,
 * que es estado de proceso vía setInterval) para poder probarlo
 * directamente sin esperar un timer real. Cada una de las 3
 * sub-operaciones está aislada en su propio try/catch: una falla en
 * una nunca debe impedir que las otras dos corran.
 */
export async function runAutonomousWorkerTick(orch: Orchestrator, disp: EventDispatcher): Promise<AutonomousWorkerTickResult> {
  const result: AutonomousWorkerTickResult = {
    orchestrator: { claimed: 0, completed: 0, retried: 0, blocked: 0, humanReview: 0, failed: 0, eventsPublished: 0 },
    reclaimedTaskIds: [],
    eventDispatch: { claimed: 0, processed: 0, failed: 0 },
  };

  try {
    result.orchestrator = await orch.runOnce(WORKER_ID, ORCHESTRATOR_CLAIM_LIMIT);
    if (result.orchestrator.claimed > 0) logger.info("autonomous_worker_orchestrator_tick", { ...result.orchestrator });
  } catch (err) {
    logger.error("autonomous_worker_orchestrator_tick_failed", { message: err instanceof Error ? err.message : String(err) });
  }

  try {
    const { reclaimedTaskIds } = await reclaimExpiredLeases();
    result.reclaimedTaskIds = reclaimedTaskIds;
    if (reclaimedTaskIds.length > 0) logger.warn("autonomous_worker_lease_reclaim_tick", { count: reclaimedTaskIds.length });
  } catch (err) {
    logger.error("autonomous_worker_lease_reclaim_tick_failed", { message: err instanceof Error ? err.message : String(err) });
  }

  try {
    result.eventDispatch = await disp.runOnce();
    if (result.eventDispatch.claimed > 0) logger.info("autonomous_worker_event_dispatch_tick", { ...result.eventDispatch });
  } catch (err) {
    logger.error("autonomous_worker_event_dispatch_tick_failed", { message: err instanceof Error ? err.message : String(err) });
  }

  return result;
}

export function startAutonomousWorkers(): void {
  if (intervalHandle) return;
  orchestrator = buildProductionOrchestrator();
  dispatcher = buildProductionEventDispatcher();
  intervalHandle = setInterval(() => void runAutonomousWorkerTick(orchestrator!, dispatcher!), TICK_INTERVAL_MS);
  // No corre inmediatamente al arrancar -- mismo criterio que
  // scheduler.ts (evita trabajo redundante en cada reinicio).
}

export function stopAutonomousWorkers(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  orchestrator = null;
  dispatcher = null;
}
