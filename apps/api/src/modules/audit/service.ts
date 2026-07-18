/**
 * F10.9: Portal Audit Trail -- una sola tabla `AuditLog` (F1, ya usada
 * por TODO F10 para cada escritura sensible), tres niveles de
 * visibilidad distintos:
 *  - Interno (`listInternalAuditLog`): tenant completo, gateado por
 *    `auditLogs.view` (deny by default -- la mayoría de roles
 *    operativos internos NO lo tienen, solo CEO/Admin/Manager, ver
 *    seed.ts ROLE_PERMISSIONS).
 *  - Cliente (`listClientAuditLog`): solo acciones sobre recursos de
 *    SU Company -- nunca tenant-wide (solo CLIENT_ADMIN tiene el
 *    permiso, CLIENT_MANAGER no).
 *  - Worker/Candidate (`listWorkerAuditLog`/`listCandidateAuditLog`):
 *    solo su propio historial (`actorId === ctx.userId` -- acciones
 *    que ELLOS realizaron desde el portal; correcto por construcción,
 *    sin superficie de IDOR ya que nunca se filtra por un id externo).
 *
 * Nunca se exponen `before`/`after` (payloads crudos, pueden contener
 * PII/notas internas) ni `ip` (spec: "no exponer IP completa si no es
 * necesaria") en NINGÚN nivel -- mismo criterio que el widget de F1
 * (`dashboard/service.ts::getRecentAuditLog`), que ya omitía ambos.
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { AppError } from "../../core/errors";

export interface AuditLogEntry {
  id: string;
  actorType: string;
  actorId: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

export interface AuditLogQuery {
  cursor?: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  actorId?: string;
  entityType?: string;
  action?: string;
}

async function resolveActorLabels(
  entries: Array<{ actorType: string; actorId: string }>,
): Promise<Map<string, string>> {
  const userIds = entries.filter((e) => e.actorType === "HUMAN").map((e) => e.actorId);
  const agentInstanceIds = entries.filter((e) => e.actorType === "AGENT").map((e) => e.actorId);

  const [users, agentInstances] = await Promise.all([
    userIds.length ? scopedDb.user.findMany({ where: { id: { in: userIds } } }) : [],
    agentInstanceIds.length
      ? scopedDb.agentInstance.findMany({ where: { id: { in: agentInstanceIds } }, include: { definition: true } })
      : [],
  ]);

  const map = new Map<string, string>();
  for (const u of users) map.set(u.id, `${u.firstName} ${u.lastName}`);
  for (const a of agentInstances) map.set(a.id, a.definition.name);
  return map;
}

function toEntry(
  row: { id: string; actorType: string; actorId: string; action: string; entityType: string; entityId: string; createdAt: Date },
  labels: Map<string, string>,
): AuditLogEntry {
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    actorLabel: row.actorType === "HUMAN" ? (labels.get(row.actorId) ?? "Unknown user") : row.actorType === "AGENT" ? (labels.get(row.actorId) ?? "Unknown agent") : "System",
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    createdAt: row.createdAt.toISOString(),
  };
}

function dateRangeWhere(query: AuditLogQuery) {
  return query.dateFrom || query.dateTo
    ? { gte: query.dateFrom ? new Date(query.dateFrom) : undefined, lte: query.dateTo ? new Date(query.dateTo) : undefined }
    : undefined;
}

export async function listInternalAuditLog(query: AuditLogQuery) {
  const limit = query.limit ?? 25;
  const rows = await scopedDb.auditLog.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: {
      createdAt: dateRangeWhere(query),
      actorId: query.actorId,
      entityType: query.entityType,
      action: query.action ? { contains: query.action, mode: "insensitive" } : undefined,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  const labels = await resolveActorLabels(items);
  return { items: items.map((r) => toEntry(r, labels)), nextCursor };
}

// F10.9: tipos de entidad company-scoped que el Client Portal ya
// expone (F10.2/F10.3/F10.6/F10.7) -- cada uno resuelve su companyId
// real antes de decidir si pertenece al caller. Nunca confía en
// entityId "parece" pertenecer -- siempre valida contra la tabla real.
async function clientOwnedEntityIds(companyId: string, entityType: string): Promise<string[] | null> {
  switch (entityType) {
    case "clientJobRequest": {
      const rows = await scopedDb.clientJobRequest.findMany({ where: { companyId }, select: { id: true } });
      return rows.map((r) => r.id);
    }
    case "timeEntry": {
      const rows = await scopedDb.timeEntry.findMany({ where: { assignment: { jobOrder: { companyId } } }, select: { id: true } });
      return rows.map((r) => r.id);
    }
    case "schedule_change_request": {
      const rows = await scopedDb.scheduleChangeRequest.findMany({ where: { assignment: { jobOrder: { companyId } } }, select: { id: true } });
      return rows.map((r) => r.id);
    }
    default:
      return null;
  }
}

const CLIENT_SCOPED_ENTITY_TYPES = ["clientJobRequest", "timeEntry", "schedule_change_request"];

export async function listClientAuditLog(query: AuditLogQuery) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  if (!ctx.companyId) throw AppError.forbidden("This account is not linked to a Company portal identity");
  const limit = query.limit ?? 25;

  const entityTypes = query.entityType ? [query.entityType] : CLIENT_SCOPED_ENTITY_TYPES;
  const idsByType = await Promise.all(entityTypes.map((t) => clientOwnedEntityIds(ctx.companyId!, t).then((ids) => ({ t, ids }))));
  const validTypes = idsByType.filter((x) => x.ids !== null && x.ids.length > 0);

  if (validTypes.length === 0) return { items: [], nextCursor: null };

  const rows = await scopedDb.auditLog.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: {
      createdAt: dateRangeWhere(query),
      action: query.action ? { contains: query.action, mode: "insensitive" } : undefined,
      OR: validTypes.map(({ t, ids }) => ({ entityType: t, entityId: { in: ids! } })),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  const labels = await resolveActorLabels(items);
  return { items: items.map((r) => toEntry(r, labels)), nextCursor };
}

/**
 * F10.9: Worker/Candidate ven su PROPIO historial -- `actorId ===
 * ctx.userId` es correcto por construcción (nunca filtra por un id
 * externo, cero superficie de IDOR). No incluye acciones que un
 * revisor interno tomó SOBRE sus registros (ej. `timeEntry.approved`
 * hecho por un Admin) -- decisión conservadora documentada en
 * docs/F10_PLAN.md §11, no un descuido.
 */
export async function listOwnActionsAuditLog(query: AuditLogQuery) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const limit = query.limit ?? 25;

  const rows = await scopedDb.auditLog.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: {
      actorId: ctx.userId,
      createdAt: dateRangeWhere(query),
      entityType: query.entityType,
      action: query.action ? { contains: query.action, mode: "insensitive" } : undefined,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  const labels = await resolveActorLabels(items);
  return { items: items.map((r) => toEntry(r, labels)), nextCursor };
}
