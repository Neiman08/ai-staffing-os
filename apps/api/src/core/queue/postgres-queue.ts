import { prisma, Prisma, type AgentTask } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../tenancy/context";
import { recordTaskFailure } from "../../modules/agents/task-lifecycle";

/**
 * F25.2 Fase 3 (ADR-0001, "sin Redis"): cola real de AgentTask sobre
 * PostgreSQL -- claim atómico con `FOR UPDATE SKIP LOCKED`, prioridad,
 * fairness entre tenants, y recuperación de leases vencidos. Reintentos/
 * backoff/clasificación de error NO se reimplementan acá -- se reusa
 * `recordTaskFailure` de task-lifecycle.ts (Fase 1), la misma lógica
 * que ya decide retry/BLOCKED/HUMAN_REVIEW/FAILED.
 *
 * Nota de la migración de F25.4 (roadmap) a esta implementación: se
 * agregó una columna `priority` (Int, default 0, aditiva) que el
 * roadmap original no preveía -- el pedido explícito de esta sesión
 * incluye "prioridades" como requisito de primera clase de la cola, y
 * el roadmap es de una sesión anterior a esta instrucción.
 */

export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export interface ClaimNextTasksOptions {
  /** Si se da, solo reclama AgentTask.type dentro de esta lista (p.ej. un worker especializado en un solo tipo). */
  types?: string[];
}

/**
 * Claim atómico y SEGURO de hasta `limit` tareas de UN tenant (o
 * globalmente si no se pasa tenantId), por prioridad/intentos/
 * antigüedad. Este es el único lugar donde se hace `FOR UPDATE SKIP
 * LOCKED` -- un CTE simple (sin funciones de ventana) materializado
 * ANTES del UPDATE final, el mismo patrón validado en outbox.ts
 * (Fase 2): `WITH claimed AS (SELECT ... LIMIT n FOR UPDATE SKIP
 * LOCKED) UPDATE ... FROM claimed ...`.
 *
 * Encontrado y descartado durante esta fase: una primera versión
 * intentaba fairness entre tenants en un solo statement combinando
 * `ROW_NUMBER() OVER (PARTITION BY tenantId ...)` con `FOR UPDATE SKIP
 * LOCKED` sobre el resultado ya rankeado -- reproduciblemente (2 de 15
 * corridas concurrentes reales) devolvía las MISMAS filas a dos
 * workers distintos, doble-claim real. La combinación de funciones de
 * ventana con locking en Postgres no da la garantía de exclusión mutua
 * que este código necesitaba. `claimTasksForTenant` es la pieza
 * atómica probada (ver el test de concurrencia); `claimNextTasks`
 * logra fairness haciendo ROUND-ROBIN de esta pieza segura entre
 * tenants EN CÓDIGO, no en una sola query compleja.
 */
async function claimTasksForTenant(
  workerId: string,
  limit: number,
  leaseMs: number,
  tenantId: string | null,
  types: string[] | undefined,
): Promise<AgentTask[]> {
  const tenantFilter = tenantId !== null ? Prisma.sql`AND "tenantId" = ${tenantId}` : Prisma.empty;
  const typesFilter = types && types.length > 0 ? Prisma.sql`AND "type" = ANY(${types})` : Prisma.empty;

  return prisma.$queryRaw<AgentTask[]>`
    WITH claimed AS (
      SELECT "id" FROM "AgentTask"
      WHERE (
        "status" = 'QUEUED'
        OR ("status" = 'RETRY_SCHEDULED' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now()))
      )
      ${tenantFilter}
      ${typesFilter}
      ORDER BY "priority" DESC, "attempt" ASC, "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "AgentTask"
    SET "status" = 'CLAIMED', "claimedAt" = now(), "claimedBy" = ${workerId},
        "leaseExpiresAt" = now() + (${leaseMs}::text || ' milliseconds')::interval
    FROM claimed
    WHERE "AgentTask"."id" = claimed."id"
    RETURNING "AgentTask".*;
  `;
}

/**
 * Reclamo justo entre tenants: ronda robin sobre `claimTasksForTenant`
 * (1 tarea por tenant activo por ronda) hasta llegar a `limit` o
 * quedarse sin tenants con trabajo disponible -- un tenant con miles de
 * QUEUED nunca acapara el batch mientras otro con una sola tarea
 * espera turno.
 */
export async function claimNextTasks(
  workerId: string,
  limit: number,
  leaseMs: number = DEFAULT_LEASE_MS,
  opts: ClaimNextTasksOptions = {},
): Promise<AgentTask[]> {
  const typesFilter = opts.types && opts.types.length > 0 ? Prisma.sql`AND "type" = ANY(${opts.types})` : Prisma.empty;

  const tenantRows = await prisma.$queryRaw<{ tenantId: string }[]>`
    SELECT DISTINCT "tenantId" FROM "AgentTask"
    WHERE (
      "status" = 'QUEUED'
      OR ("status" = 'RETRY_SCHEDULED' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now()))
    )
    ${typesFilter}
    ORDER BY "tenantId";
  `;
  let activeTenantIds = tenantRows.map((r) => r.tenantId);

  const claimed: AgentTask[] = [];
  while (claimed.length < limit && activeTenantIds.length > 0) {
    const stillActive: string[] = [];
    for (const tenantId of activeTenantIds) {
      if (claimed.length >= limit) break;
      const [task] = await claimTasksForTenant(workerId, 1, leaseMs, tenantId, opts.types);
      if (task) {
        claimed.push(task);
        stillActive.push(tenantId); // puede tener más trabajo -- reintenta el próximo round
      }
    }
    if (stillActive.length === 0) break; // ninguna ronda completa reclamó nada -- no queda trabajo
    activeTenantIds = stillActive;
  }

  return claimed;
}

/**
 * Recupera leases vencidos (worker muerto/colgado) -- generaliza el
 * watchdog que hoy solo existe para `daily_revenue_mission`
 * (scheduler.ts:runMissionCloseSweep) a CUALQUIER AgentTask con lease.
 * Atómico en dos pasos: (1) un UPDATE...FOR UPDATE SKIP LOCKED limpia
 * `leaseExpiresAt` -- esto por sí solo ya saca a la fila de la ventana
 * de reclamo (leaseExpiresAt=NULL nunca matchea `<= now()`), cerrando
 * la carrera entre dos reclaimers concurrentes; (2) para cada fila así
 * marcada, `recordTaskFailure` (Fase 1, reusada sin duplicar) decide
 * retry/BLOCKED/HUMAN_REVIEW/FAILED igual que cualquier otra falla.
 */
export async function reclaimExpiredLeases(): Promise<{ reclaimedTaskIds: string[] }> {
  const expired = await prisma.$queryRaw<{ id: string; tenantId: string }[]>`
    WITH claimable AS (
      SELECT "id" FROM "AgentTask"
      WHERE "status" IN ('CLAIMED', 'RUNNING') AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" <= now()
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "AgentTask"
    SET "leaseExpiresAt" = NULL
    FROM claimable
    WHERE "AgentTask"."id" = claimable."id"
    RETURNING "AgentTask"."id", "AgentTask"."tenantId";
  `;

  for (const task of expired) {
    await runWithTenancyContext({ tenantId: task.tenantId, userId: "system-queue-reclaimer", permissions: [] }, () =>
      recordTaskFailure(task.id, new Error("Lease expirado: el worker no terminó la tarea dentro del tiempo asignado (timeout)")),
    );
  }

  return { reclaimedTaskIds: expired.map((t) => t.id) };
}
