import { prisma } from "@ai-staffing-os/db";
import { scopedDb } from "../../core/tenancy/prisma-extension";

/**
 * F25.2 Fase 9: observabilidad -- reusa exclusivamente columnas que ya
 * existen (AgentTask.correlationId/causationId de Fase 1,
 * DomainEvent.correlationId de Fase 2) y datos que la cola/outbox ya
 * persisten. Ninguna tabla nueva: la "historia" de una misión ya está
 * completa en AgentTask+DomainEvent, esto solo la reconstruye y la
 * expone de forma legible.
 */

export type MissionTimelineEntry =
  | {
      kind: "task";
      id: string;
      type: string;
      status: string;
      attempt: number;
      lastErrorCategory: string | null;
      causationId: string | null;
      createdAt: Date;
      completedAt: Date | null;
    }
  | {
      kind: "event";
      id: string;
      type: string;
      causationId: string | null;
      processedAt: Date | null;
      createdAt: Date;
      entityType: string | null;
      entityId: string | null;
    };

/**
 * Reconstruye la línea de tiempo completa de una misión/workflow --
 * todas las AgentTask y todos los DomainEvent que comparten
 * `correlationId`, mezclados en un único orden cronológico. Con
 * `causationId` en cada entrada, el llamador puede reconstruir la
 * cadena exacta (qué causó qué), no solo la lista.
 */
export async function getMissionTimeline(correlationId: string): Promise<MissionTimelineEntry[]> {
  const [tasks, events] = await Promise.all([
    scopedDb.agentTask.findMany({ where: { correlationId } }),
    scopedDb.domainEvent.findMany({ where: { correlationId } }),
  ]);

  const entries: MissionTimelineEntry[] = [
    ...tasks.map(
      (t): MissionTimelineEntry => ({
        kind: "task",
        id: t.id,
        type: t.type,
        status: t.status,
        attempt: t.attempt,
        lastErrorCategory: t.lastErrorCategory,
        causationId: t.causationId,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      }),
    ),
    ...events.map(
      (e): MissionTimelineEntry => ({
        kind: "event",
        id: e.id,
        type: e.type,
        causationId: e.causationId,
        processedAt: e.processedAt,
        createdAt: e.createdAt,
        entityType: e.entityType,
        entityId: e.entityId,
      }),
    ),
  ];

  return entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export interface OrchestratorHealth {
  tasksByStatus: Record<string, number>;
  queueDepth: number; // QUEUED + RETRY_SCHEDULED reclamables ahora
  oldestQueuedTaskAgeMs: number | null;
  expiredLeases: number; // CLAIMED/RUNNING con leaseExpiresAt vencido -- candidatas a reclaimExpiredLeases
  unprocessedEvents: number;
}

/**
 * Estado de salud cross-tenant -- mismo criterio que
 * scheduler.ts/outbox.ts para operaciones de infraestructura (usa el
 * cliente base, no scopedDb, porque agrega sobre TODOS los tenants;
 * ver GET /api/v1/agents/orchestrator/health).
 */
export async function getOrchestratorHealth(): Promise<OrchestratorHealth> {
  const now = new Date();

  const [statusCounts, queueDepth, oldestQueued, expiredLeases, unprocessedEvents] = await Promise.all([
    prisma.agentTask.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.agentTask.count({
      where: { OR: [{ status: "QUEUED" }, { status: "RETRY_SCHEDULED", nextAttemptAt: { lte: now } }] },
    }),
    prisma.agentTask.findFirst({
      where: { OR: [{ status: "QUEUED" }, { status: "RETRY_SCHEDULED", nextAttemptAt: { lte: now } }] },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.agentTask.count({ where: { status: { in: ["CLAIMED", "RUNNING"] }, leaseExpiresAt: { lte: now } } }),
    prisma.domainEvent.count({ where: { processedAt: null } }),
  ]);

  return {
    tasksByStatus: Object.fromEntries(statusCounts.map((row) => [row.status, row._count._all])),
    queueDepth,
    oldestQueuedTaskAgeMs: oldestQueued ? now.getTime() - oldestQueued.createdAt.getTime() : null,
    expiredLeases,
    unprocessedEvents,
  };
}
