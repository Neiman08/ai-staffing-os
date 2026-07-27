import type { AgentEventEnvelope } from "../core/AgentEventEnvelope";

/**
 * F25 Fase H: bus de eventos en memoria para el prototipo dry-run del
 * Orchestrator -- nunca toca DomainEvent/Postgres (eso es F25.3, ADR-0002).
 * Sirve exactamente para demostrar el contrato de AgentEventEnvenlope
 * funcionando de punta a punta sin ninguna infraestructura real.
 */
export class InMemoryEventBus {
  private readonly published: AgentEventEnvelope[] = [];
  private readonly handlers = new Map<string, Array<(event: AgentEventEnvelope) => void>>();

  publish(event: AgentEventEnvelope): void {
    this.published.push(event);
    for (const handler of this.handlers.get(event.eventType) ?? []) handler(event);
  }

  subscribe(eventType: string, handler: (event: AgentEventEnvelope) => void): void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  getPublished(): readonly AgentEventEnvelope[] {
    return this.published;
  }
}
