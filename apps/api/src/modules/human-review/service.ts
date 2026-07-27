import { Prisma, type HumanReviewRequest, type HumanReviewType, type HumanReviewPriority } from "@ai-staffing-os/db";
import { buildEventEnvelope, buildIdempotencyKey } from "@ai-staffing-os/agents";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { publishEventSafe } from "../../core/events/outbox";

/**
 * F25.2 Fase 5: Human Review Center -- contrato ya diseñado en
 * docs/F25_AUTONOMY_POLICY_MODEL.md §8. Dedup real (índice único
 * parcial en la migración, no una convención de aplicación): nunca dos
 * `HumanReviewRequest` abiertos para el mismo (entityType, entityId,
 * type) simultáneamente -- el segundo caso se fusiona en el primero
 * (agrega evidencia, no crea fila nueva).
 */

export interface CreateHumanReviewInput {
  type: HumanReviewType;
  priority: HumanReviewPriority;
  deadline?: Date | null;
  entityType: string;
  entityId: string;
  summary: string;
  evidence: Record<string, unknown>[];
  requestedDecision: string;
  options: { label: string; consequence: string }[];
  recommendation?: string | null;
  impact: string;
  correlationId: string;
}

export interface CreateHumanReviewResult {
  request: HumanReviewRequest;
  merged: boolean;
}

function mergeEvidence(existing: HumanReviewRequest, newEvidence: Record<string, unknown>[]) {
  const existingEvidence = Array.isArray(existing.evidence) ? (existing.evidence as Record<string, unknown>[]) : [];
  return scopedDb.humanReviewRequest.update({
    where: { id: existing.id },
    data: { evidence: [...existingEvidence, ...newEvidence] as Prisma.InputJsonValue },
  });
}

/**
 * Chequea primero (camino feliz, sin contención) y si de todos modos
 * choca contra el índice único parcial (dos requests concurrentes para
 * la misma entidad+tipo, race real) usa el constraint de la DB como
 * fuente de verdad -- mismo patrón que publishEvent en outbox.ts.
 */
export async function createOrMergeHumanReviewRequest(input: CreateHumanReviewInput): Promise<CreateHumanReviewResult> {
  const openWhere = { entityType: input.entityType, entityId: input.entityId, type: input.type, resolvedAt: null } as const;

  const existing = await scopedDb.humanReviewRequest.findFirst({ where: openWhere });
  if (existing) return { request: await mergeEvidence(existing, input.evidence), merged: true };

  try {
    const ctx = getTenancyContext();
    if (!ctx) throw AppError.unauthorized();
    const created = await scopedDb.humanReviewRequest.create({
      data: {
        tenantId: ctx.tenantId,
        type: input.type,
        priority: input.priority,
        deadline: input.deadline ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        summary: input.summary,
        evidence: input.evidence as Prisma.InputJsonValue,
        requestedDecision: input.requestedDecision,
        options: input.options as Prisma.InputJsonValue,
        recommendation: input.recommendation ?? null,
        impact: input.impact,
        correlationId: input.correlationId,
      },
    });
    return { request: created, merged: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raceWinner = await scopedDb.humanReviewRequest.findFirstOrThrow({ where: openWhere });
      return { request: await mergeEvidence(raceWinner, input.evidence), merged: true };
    }
    throw err;
  }
}

export interface ListHumanReviewFilters {
  status?: "OPEN" | "RESOLVED";
  priority?: HumanReviewPriority;
}

export async function listHumanReviewRequests(filters: ListHumanReviewFilters = {}): Promise<HumanReviewRequest[]> {
  return scopedDb.humanReviewRequest.findMany({
    where: {
      resolvedAt: filters.status === "OPEN" ? null : filters.status === "RESOLVED" ? { not: null } : undefined,
      priority: filters.priority,
    },
    // Postgres ordena un enum por el orden de declaración (LOW < MEDIUM
    // < HIGH < URGENT, ver schema.prisma) -- "desc" es URGENT primero.
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
}

export async function getHumanReviewRequest(id: string): Promise<HumanReviewRequest> {
  return scopedDb.humanReviewRequest.findUniqueOrThrow({ where: { id } });
}

/**
 * F25.2 (activación controlada, Prioridad 3): publica
 * human.review_resolved.v1 -- permite que el pipeline REACCIONE a una
 * resolución humana (ver pipeline-handlers.ts: reanuda/finaliza la
 * AgentTask relacionada cuando entityType="agent_task"). Nunca lanza
 * si la publicación falla (publishEventSafe) -- la resolución humana ya
 * se guardó, eso es lo que importa; el evento es notificación, no debe
 * poder revertir la resolución.
 */
export async function resolveHumanReviewRequest(id: string, resolvedById: string, resolution: string): Promise<HumanReviewRequest> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.humanReviewRequest.findUniqueOrThrow({ where: { id } });
  if (existing.resolvedAt) {
    throw AppError.conflict(`HumanReviewRequest ${id} ya está resuelto`);
  }
  const resolved = await scopedDb.humanReviewRequest.update({
    where: { id },
    data: { resolvedAt: new Date(), resolvedById, resolution },
  });

  await publishEventSafe(
    buildEventEnvelope({
      eventType: "human.review_resolved.v1",
      tenantId: ctx.tenantId,
      correlationId: resolved.correlationId,
      causationId: null,
      actorType: "HUMAN",
      actorId: resolvedById,
      entityType: resolved.entityType,
      entityId: resolved.entityId,
      payload: { humanReviewRequestId: resolved.id, entityType: resolved.entityType, entityId: resolved.entityId, resolution, resolvedById },
      idempotencyKey: buildIdempotencyKey(resolved.correlationId, "human.review_resolved.v1", resolved.id),
    }),
  );

  return resolved;
}
