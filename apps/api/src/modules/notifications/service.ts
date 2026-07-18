/**
 * F10.8: Notifications Center -- un solo servicio para TODOS los roles
 * (internos y de portal), ya que `notifications.view`/`.markRead` se
 * agregaron a los 15 roles desde F10.1. El scoping real ocurre acá:
 * un usuario ve sus propias notificaciones (`userId`) MÁS las emitidas
 * para su rol (`recipientRole`, solo relevante para roles internos --
 * ningún rol de portal recibe nunca una notificación por
 * `recipientRole`, ver core/notifications.ts).
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  priority: string;
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

function toItem(n: {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  priority: string;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationItem {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    entityType: n.entityType,
    entityId: n.entityId,
    priority: n.priority,
    actionUrl: n.link,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

async function currentUserRoleName(userId: string): Promise<string | null> {
  const user = await scopedDb.user.findUnique({ where: { id: userId }, select: { role: { select: { name: true } } } });
  return user?.role.name ?? null;
}

export async function listNotifications(query: { cursor?: string; limit?: number; unreadOnly?: boolean }) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const roleName = await currentUserRoleName(ctx.userId);
  const limit = query.limit ?? 20;

  const rows = await scopedDb.notification.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: {
      OR: [{ userId: ctx.userId }, ...(roleName ? [{ recipientRole: roleName }] : [])],
      readAt: query.unreadOnly ? null : undefined,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  return { items: items.map(toItem), nextCursor };
}

export async function countUnreadNotifications(): Promise<number> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const roleName = await currentUserRoleName(ctx.userId);

  return scopedDb.notification.count({
    where: {
      OR: [{ userId: ctx.userId }, ...(roleName ? [{ recipientRole: roleName }] : [])],
      readAt: null,
    },
  });
}

/**
 * F10.8: "permitir marcar leída; no eliminar automáticamente" -- nunca
 * un DELETE, siempre `readAt`. Ownership: una notificación por
 * `recipientRole` puede marcarse leída por cualquier usuario de ese rol
 * (comportamiento esperado de una bandeja compartida por rol) -- una
 * por `userId` específico solo por su dueño exacto.
 */
export async function markNotificationRead(id: string): Promise<NotificationItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const roleName = await currentUserRoleName(ctx.userId);

  const existing = await scopedDb.notification.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Notification not found");
  const ownedByUser = existing.userId === ctx.userId;
  const ownedByRole = existing.recipientRole !== null && existing.recipientRole === roleName;
  if (!ownedByUser && !ownedByRole) throw AppError.notFound("Notification not found");

  const updated = existing.readAt
    ? existing
    : await scopedDb.notification.update({ where: { id }, data: { readAt: new Date() } });

  if (!existing.readAt) {
    await logAuditEvent({
      action: "notification.marked_read",
      entityType: "notification",
      entityId: id,
      after: { readAt: updated.readAt?.toISOString() },
    });
  }

  return toItem(updated);
}
