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
 * Nota de alcance (F25.2 Fase 2): esta fase entrega el mecanismo real
 * del outbox -- nunca lanza, nunca duplica (idempotencyKey único a
 * nivel de tabla), nunca pierde un evento fallido (queda con
 * processedAt=null, reclamable en el próximo poll = replay seguro).
 * Instrumentar los 4 call sites de producción reales (persistAccepted-
 * Candidate, los 3 de draft_outreach) queda para cuando esos flujos se
 * conviertan en AgentExecutor real (Fase 6/7) -- publicar un evento
 * hoy sin nadie que lo consuma sería builder trabajo muerto, y tocar
 * esos 4 call sites reales sin necesidad viola "no expandas el alcance
 * más allá de lo pedido".
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
 * Reclamo de hasta `limit` eventos sin procesar, ordenados por
 * antigüedad, usando `FOR UPDATE SKIP LOCKED` (mismo mecanismo que
 * ADR-0001 propone para AgentTask). Cruza tenants a propósito -- el
 * dispatcher es infraestructura, no una operación de negocio de un
 * tenant (mismo criterio que scheduler.ts:tickAllTenants usando el
 * cliente base).
 *
 * Límite de diseño explícito (a diferencia de AgentTask/Fase 3):
 * `DomainEvent` NO tiene columnas de lease (`claimedAt`/`claimedBy`) --
 * ADR-0002 las omitió deliberadamente, y ADR-0003 fija un único
 * Orchestrator in-process como consumidor. SKIP LOCKED acá solo evita
 * que dos transacciones VERDADERAMENTE simultáneas reclamen la misma
 * fila mientras ambas siguen abiertas; una vez que una transacción
 * confirma, la fila vuelve a quedar elegible para el próximo poll
 * aunque nadie la haya marcado processed/failed todavía -- esto es
 * SEGURO bajo la arquitectura real (un solo dispatcher, loop
 * secuencial: claim -> procesar cada evento -> marcar -> recién ahí el
 * siguiente poll), pero NO es una garantía de "cada evento reclamado
 * por como máximo un poller" bajo pollers concurrentes reales. Si en el
 * futuro se necesita más de un dispatcher a la vez, agregar lease acá
 * es la extensión natural (mismo patrón que AgentTask) -- fuera de
 * alcance hoy porque el ADR revisado no lo pide.
 */
export async function claimUnprocessedEvents(limit = 25): Promise<DomainEvent[]> {
  // Nota importante (encontrada corriendo el test de concurrencia real,
  // no una suposición): `UPDATE t SET ... WHERE id IN (SELECT id FROM t
  // ... LIMIT n FOR UPDATE SKIP LOCKED)` NO respeta el LIMIT cuando la
  // subquery referencia la MISMA tabla que el UPDATE -- el planner de
  // Postgres puede aplanar la subquery y terminar actualizando TODAS las
  // filas que matchean el WHERE interno, no solo las `n` bloqueadas
  // (reproducido directo en psql: LIMIT 3 actualizó las 12 filas
  // disponibles). El patrón correcto y documentado es un CTE: el
  // `WITH claimed AS (... FOR UPDATE SKIP LOCKED LIMIT n)` se materializa
  // como un resultado fijo ANTES del UPDATE, que solo hace JOIN contra
  // esas filas ya elegidas -- ahí el LIMIT sí se respeta.
  // ORDER BY attempt ASC, createdAt ASC (no solo createdAt): sin esto, un
  // evento que falla una y otra vez sin marcarse processed queda
  // PERMANENTEMENTE primero en la cola (siempre el más viejo) y bloquea
  // a todos los eventos más nuevos para siempre -- head-of-line blocking
  // real, encontrado con el test de dispatcher secuencial (9 eventos
  // nunca se procesaban porque 4 eventos viejos de otro tenant, ya
  // reclamados pero nunca marcados, se re-reclamaban en cada poll sin
  // ceder el lugar). Al ordenar primero por attempt, un evento que ya
  // falló cede prioridad a los que todavía no se intentaron -- se
  // sigue reintentando (nunca se pierde), pero deja de monopolizar el
  // frente de la cola.
  return prisma.$queryRaw<DomainEvent[]>`
    WITH claimed AS (
      SELECT "id" FROM "DomainEvent"
      WHERE "processedAt" IS NULL
      ORDER BY "attempt" ASC, "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "DomainEvent"
    SET "attempt" = "attempt" + 1
    FROM claimed
    WHERE "DomainEvent"."id" = claimed."id"
    RETURNING "DomainEvent".*;
  `;
}

export async function markEventProcessed(eventId: string): Promise<void> {
  await prisma.domainEvent.update({ where: { id: eventId }, data: { processedAt: new Date() } });
}

/**
 * Deja el evento sin procesar (processedAt sigue null) -- esa es toda la
 * garantía de "replay seguro": el próximo `claimUnprocessedEvents` lo
 * vuelve a tomar. `lastErrorCode` reusa `classifyError` de
 * packages/agents, la misma clasificación que AgentTask (Fase 1) --
 * ningún consumidor tiene que interpretar dos vocabularios de error
 * distintos.
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
    data: { lastErrorAt: new Date(), lastErrorCode: category },
  });
}
