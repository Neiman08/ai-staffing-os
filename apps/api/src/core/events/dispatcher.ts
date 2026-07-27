import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@ai-staffing-os/db";
import { claimUnprocessedEvents, markEventProcessed, markEventFailed } from "./outbox";
import { logger } from "../logger";

/**
 * F25.2 (consolidación): worker real de procesamiento de eventos --
 * reclama vía `claimUnprocessedEvents` (con lease real, ver su
 * docstring en outbox.ts -- múltiples EventDispatcher/instancias
 * corriendo a la vez ya no pueden reclamar el mismo evento), despacha
 * a los handlers registrados por `eventType`, marca processed/failed
 * (replay seguro).
 *
 * Hoy no hay NINGÚN handler real registrado en producción -- ningún
 * agente consume `company.discovered.v1`/`outreach.draft_created.v1`
 * todavía (esa es la pieza que Fase 6/7's AgentExecutor conectarían
 * si se registraran como CONSUMIDORES, no solo como productores vía
 * el Orchestrator). Un evento sin handlers registrados para su tipo
 * se marca processed inmediatamente -- es un resultado legítimo
 * ("nadie necesita reaccionar a esto todavía"), no un error.
 */
export type DomainEventHandler = (event: DomainEvent) => Promise<void>;

export interface EventDispatchMetrics {
  claimed: number;
  processed: number;
  failed: number;
}

export class EventDispatcher {
  private readonly handlers = new Map<string, DomainEventHandler[]>();
  // Un id estable por instancia -- suficiente como `claimedBy` para
  // trazabilidad (qué proceso/instancia tiene el lease de un evento en
  // AgentTask/DomainEvent.claimedBy), no una identidad de infraestructura real.
  private readonly workerId = `event-dispatcher-${randomUUID()}`;

  registerHandler(eventType: string, handler: DomainEventHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  async runOnce(limit = 25): Promise<EventDispatchMetrics> {
    const claimed = await claimUnprocessedEvents(this.workerId, limit);
    const metrics: EventDispatchMetrics = { claimed: claimed.length, processed: 0, failed: 0 };

    for (const event of claimed) {
      const handlers = this.handlers.get(event.type) ?? [];
      try {
        for (const handler of handlers) await handler(event);
        await markEventProcessed(event.id);
        metrics.processed += 1;
      } catch (err) {
        await markEventFailed(event.id, err);
        metrics.failed += 1;
      }
    }

    if (metrics.claimed > 0) logger.info("event_dispatcher_run_once", { ...metrics });
    return metrics;
  }
}
