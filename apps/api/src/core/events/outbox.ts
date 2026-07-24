import { prisma, Prisma, type DomainEvent } from "@ai-staffing-os/db";
import { classifyError, type AgentEventEnvelope } from "@ai-staffing-os/agents";
import { scopedDb } from "../tenancy/prisma-extension";
import { logger } from "../logger";

/**
 * F25.2 Fase 2 (ADR-0002): outbox real sobre `DomainEvent` -- persistencia,
 * publicación, polling y replay seguro contra Postgres real, no un stub en
 * memoria. `publishEvent` corre del lado del escritor (tenant-scoped,
 * dentro de runWithTenancyContext, mismo patrón que task-lifecycle.ts);
 * `claimUnprocessedEvents`/`markEventProcessed`/`markEventFailed` corren
 * del lado del dispatcher (cross-tenant, mismo patrón que
 * scheduler.ts:tickAllTenants -- usa el cliente base sin scope porque
 * itera TODOS los tenants, no uno).
 *
 * Nota de alcance (F25.2 Fase 2): esta fase entregó el mecanismo real
 * del outbox -- nunca duplica (idempotencyKey único a nivel de tabla),
 * nunca pierde un evento fallido (queda con processedAt=null,
 * reclamable en el próximo poll = replay seguro). Instrumentar los 4
 * call sites de producción reales quedó explícitamente diferido; la
 * sesión de consolidación (F25.2 Fase "outbox completo") los conecta
 * -- ver `publishEventSafe` abajo, la variante que SÍ es segura de
 * llamar desde código de negocio real (nunca lanza, un fallo se
 * loguea y la transacción de negocio sigue intacta).
 */

export interface PublishEventResult {
  event: DomainEvent;
  wasAlreadyPublished: boolean;
}

/**
 * Inserta un evento del catálogo (ver AgentEventEnvelope) como una fila
 * de `DomainEvent`. Nunca lanza: un choque de idempotencyKey (el mismo
 * evento publicado dos veces -- reintento del caller, no un bug) se
 * resuelve devolviendo la fila YA existente, no un error. `metadata`/
 * `eventId`/`occurredAt` del sobre no tienen columna propia -- una vez
 * persistido, `DomainEvent.id`/`createdAt` son la identidad canónica
 * (un causationId de un evento futuro debe referenciar `event.id`, no
 * `envelope.eventId`).
 */
export async function publishEvent(envelope: AgentEventEnvelope): Promise<PublishEventResult> {
  try {
    const event = await scopedDb.domainEvent.create({
      data: {
        tenantId: envelope.tenantId,
        type: envelope.eventType,
        payload: envelope.payload as Prisma.InputJsonValue,
        correlationId: envelope.correlationId,
        causationId: envelope.causationId,
        actorType: envelope.actorType,
        actorId: envelope.actorId,
        entityType: envelope.entityType,
        entityId: envelope.entityId,
        idempotencyKey: envelope.idempotencyKey,
      },
    });
    return { event, wasAlreadyPublished: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await scopedDb.domainEvent.findFirst({ where: { idempotencyKey: envelope.idempotencyKey } });
      if (existing) return { event: existing, wasAlreadyPublished: true };
    }
    throw err;
  }
}

/**
 * Variante segura de `publishEvent` para llamar desde un call site de
 * negocio real (persistAcceptedCandidate, los 3 de draft_outreach) --
 * nunca lanza. La escritura del evento es observabilidad/outbox, no
 * debe poder romper el pipeline comercial real que la origina: un
 * fallo (de infraestructura, no un choque de idempotencyKey -- ESE ya
 * lo resuelve publishEvent sin error) se loguea y se sigue de largo.
 */
export async function publishEventSafe(envelope: AgentEventEnvelope): Promise<void> {
  try {
    await publishEvent(envelope);
  } catch (err) {
    logger.error("outbox_publish_failed", {
      eventType: envelope.eventType,
      idempotencyKey: envelope.idempotencyKey,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export const DEFAULT_EVENT_LEASE_MS = 60_000;

/**
 * Reclamo de hasta `limit` eventos sin procesar, con lease real
 * (`claimedAt`/`claimedBy`/`leaseExpiresAt`) -- mismo patrón que
 * `claimTasksForTenant` (postgres-queue.ts/Fase 3). Cruza tenants a
 * propósito -- el dispatcher es infraestructura, no una operación de
 * negocio de un tenant.
 *
 * REVIERTE una decisión previa (ADR-0002/ADR-0003: "sin lease,
 * DomainEvent no lo necesita, un único dispatcher in-process
 * alcanza"). Encontrado con un test de concurrencia real, reproducido
 * también en psql puro sin Prisma de por medio: `attempt++` por sí
 * solo NUNCA saca a una fila de `processedAt IS NULL` -- dos
 * transacciones separadas, cada una ejecutando `claimUnprocessedEvents`
 * de punta a punta ANTES de que la otra empezara (sin overlap real de
 * ninguna transacción, SKIP LOCKED nunca llegó a intervenir),
 * reclamaban la MISMA fila igual, porque para la segunda transacción
 * la fila seguía pareciendo "nunca tocada". `FOR UPDATE SKIP LOCKED`
 * solo protege mientras AMBAS transacciones siguen abiertas
 * simultáneamente -- no alcanza por sí solo como mecanismo de
 * "reclamo" cuando el claim y el marcado-como-procesado son pasos
 * separados en el tiempo. El lease cierra exactamente ese hueco.
 *
 * Nota histórica (Fase 2): `UPDATE t SET ... WHERE id IN (SELECT id
 * FROM t ... LIMIT n FOR UPDATE SKIP LOCKED)` tampoco respeta el LIMIT
 * cuando la subquery referencia la misma tabla del UPDATE -- por eso
 * el patrón acá sigue siendo un CTE materializado antes del UPDATE
 * final (`WITH claimed AS (... FOR UPDATE SKIP LOCKED LIMIT n) UPDATE
 * ... FROM claimed ...`).
 *
 * `ORDER BY attempt ASC, createdAt ASC` (no solo createdAt): sin esto,
 * un evento que falla una y otra vez sin marcarse processed queda
 * PERMANENTEMENTE primero en la cola y bloquea a todos los eventos más
 * nuevos para siempre -- head-of-line blocking real, encontrado con el
 * test de dispatcher secuencial de Fase 2.
 */
export async function claimUnprocessedEvents(workerId: string, limit = 25, leaseMs: number = DEFAULT_EVENT_LEASE_MS): Promise<DomainEvent[]> {
  return prisma.$queryRaw<DomainEvent[]>`
    WITH claimed AS (
      SELECT "id" FROM "DomainEvent"
      WHERE "processedAt" IS NULL
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= now())
      ORDER BY "attempt" ASC, "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "DomainEvent"
    SET "attempt" = "attempt" + 1, "claimedAt" = now(), "claimedBy" = ${workerId},
        "leaseExpiresAt" = now() + (${leaseMs}::text || ' milliseconds')::interval
    FROM claimed
    WHERE "DomainEvent"."id" = claimed."id"
    RETURNING "DomainEvent".*;
  `;
}

export async function markEventProcessed(eventId: string): Promise<void> {
  await prisma.domainEvent.update({
    where: { id: eventId },
    data: { processedAt: new Date(), claimedAt: null, claimedBy: null, leaseExpiresAt: null },
  });
}

/**
 * Deja el evento sin procesar (processedAt sigue null) -- esa es toda la
 * garantía de "replay seguro": el próximo `claimUnprocessedEvents` lo
 * vuelve a tomar. Limpia el lease de inmediato (no espera a que
 * expire) -- una falla real ya identificada debe quedar reclamable
 * ahora, no recién cuando venza el lease del intento anterior.
 * `lastErrorCode` reusa `classifyError` de packages/agents, la misma
 * clasificación que AgentTask (Fase 1) -- ningún consumidor tiene que
 * interpretar dos vocabularios de error distintos.
 */
export async function markEventFailed(eventId: string, error: unknown): Promise<void> {
  const category = classifyError(error);
  logger.error("domain_event_processing_failed", {
    eventId,
    category,
    message: error instanceof Error ? error.message : String(error),
  });
  await prisma.domainEvent.update({
    where: { id: eventId },
    data: { lastErrorAt: new Date(), lastErrorCode: category, claimedAt: null, claimedBy: null, leaseExpiresAt: null },
  });
}
