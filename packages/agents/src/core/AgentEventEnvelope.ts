import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * F25 Fase 1 (ADR-0002, ADR-0005): el sobre de todo evento del catálogo
 * -- docs/F25_AGENT_EVENTS_AND_CONTRACTS.md §1. `payload` se valida
 * por separado, por evento (ver eventPayloadSchema más abajo) --
 * `.passthrough()` en el payload de CADA evento concreto es la regla
 * de compatibilidad hacia adelante (ADR-0005): un publisher más nuevo
 * agregando un campo opcional nunca rompe un consumidor viejo.
 *
 * Puramente un tipo/validador hoy -- ningún publisher real lo usa
 * todavía (eso es F25.3, cuando `DomainEvent` se extienda con las
 * columnas de ADR-0002).
 */
export const agentEventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  // "company.discovered.v1" -- versión embebida en el string, nunca
  // una columna separada (ADR-0005).
  eventType: z.string().regex(/^[a-z_]+\.[a-z_]+\.v\d+$/, "eventType debe tener la forma dominio.evento.vN"),
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  causationId: z.string().nullable(),
  actorType: z.enum(["AGENT", "HUMAN", "SYSTEM"]),
  actorId: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  occurredAt: z.string().datetime(),
  payload: z.unknown(),
  metadata: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1),
});

export type AgentEventEnvelope<TPayload = unknown> = Omit<z.infer<typeof agentEventEnvelopeSchema>, "payload"> & {
  payload: TPayload;
};

/**
 * Helper para construir el sobre con los campos derivables completados
 * -- nunca hay que recordar generar `eventId`/`occurredAt` a mano en
 * cada publisher. `eventId` usa un prefijo legible (`evt_`) mismo
 * criterio que el resto del proyecto usa cuids sin prefijo para
 * entidades de negocio -- acá el prefijo ayuda a distinguir un eventId
 * de cualquier otro id en logs mezclados.
 */
export function buildEventEnvelope<TPayload>(params: {
  eventType: string;
  tenantId: string;
  correlationId: string;
  causationId: string | null;
  actorType: "AGENT" | "HUMAN" | "SYSTEM";
  actorId: string;
  entityType: string;
  entityId: string;
  payload: TPayload;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
  eventId?: string;
  occurredAt?: Date;
}): AgentEventEnvelope<TPayload> {
  return {
    eventId: params.eventId ?? `evt_${randomUUID()}`,
    eventType: params.eventType,
    tenantId: params.tenantId,
    correlationId: params.correlationId,
    causationId: params.causationId,
    actorType: params.actorType,
    actorId: params.actorId,
    entityType: params.entityType,
    entityId: params.entityId,
    occurredAt: (params.occurredAt ?? new Date()).toISOString(),
    payload: params.payload,
    metadata: params.metadata ?? {},
    idempotencyKey: params.idempotencyKey,
  };
}
