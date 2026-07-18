/**
 * F10.8: Notifications Center -- helper único de emisión, mismo patrón
 * que `audit-log.ts`/`activity-log.ts` (evita repetir `.create()` en
 * cada call site). Solo canal in-app -- nunca email/SMS reales (prohibido
 * explícito de F10). Requiere exactamente uno de `recipientUserId`/
 * `recipientRole` -- `recipientRole` SOLO es seguro para roles internos
 * tenant-wide (RECRUITER/OPERATIONS/etc.); un rol de portal
 * (CLIENT_ADMIN/WORKER/CANDIDATE) siempre debe resolverse a userIds
 * específicos ANTES de llamar acá (ver notifyPortalUsers), nunca un
 * broadcast por rol que cruzaría companies/workers dentro del mismo
 * tenant.
 */
import { scopedDb } from "./tenancy/prisma-extension";
import { getTenancyContext } from "./tenancy/context";
import { AppError } from "./errors";

export type NotificationTypeValue =
  | "INFO"
  | "ALERT"
  | "APPROVAL"
  | "AGENT_ACTIVITY"
  | "JOB_REQUEST_SUBMITTED"
  | "JOB_REQUEST_NEEDS_INFORMATION"
  | "SHORTLIST_READY"
  | "DOCUMENT_REQUIRED"
  | "DOCUMENT_EXPIRING"
  | "ONBOARDING_BLOCKED"
  | "ASSIGNMENT_UPDATED"
  | "SCHEDULE_CHANGED"
  | "TIME_ENTRY_REJECTED"
  | "TIME_ENTRY_APPROVED"
  | "INCIDENT_UPDATED"
  | "COMPLIANCE_ACTION_REQUIRED"
  | "PLACEMENT_READY"
  | "SYSTEM_NOTICE";

export interface EmitNotificationInput {
  recipientUserId?: string;
  recipientRole?: string;
  type: NotificationTypeValue;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  /** F10.8: relativo, nunca un origen externo -- validado en el router (ver parseActionUrl). */
  actionUrl?: string;
}

/**
 * Idempotencia: si ya existe una notificación NO LEÍDA con el mismo
 * (tenant, recipiente, type, entityId), no se crea una segunda -- evita
 * spam cuando el mismo evento dispara el trigger más de una vez (ej. un
 * reintento). Una vez leída, un evento nuevo del mismo tipo sí genera
 * una notificación nueva (es información nueva para el usuario).
 */
export async function emitNotification(input: EmitNotificationInput): Promise<void> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  if (!!input.recipientUserId === !!input.recipientRole) {
    throw new Error("emitNotification requires exactly one of recipientUserId or recipientRole");
  }

  const existing = await scopedDb.notification.findFirst({
    where: {
      userId: input.recipientUserId,
      recipientRole: input.recipientRole,
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      readAt: null,
    },
  });
  if (existing) return;

  await scopedDb.notification.create({
    data: {
      tenantId: ctx.tenantId,
      userId: input.recipientUserId,
      recipientRole: input.recipientRole,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.actionUrl,
      entityType: input.entityType,
      entityId: input.entityId,
      priority: input.priority ?? "MEDIUM",
    },
  });
}

/**
 * F10.8: resuelve un conjunto de Users de PORTAL (companyId/workerId/
 * candidateId, F10.1) a partir del dueño real del recurso, y emite una
 * notificación a cada uno por separado (userId específico, nunca
 * recipientRole) -- así una notificación "para el cliente X" nunca
 * puede filtrar hacia el cliente Y aunque compartan tenant.
 */
export async function notifyPortalUsers(
  scope: { companyId?: string; workerId?: string; candidateId?: string },
  input: Omit<EmitNotificationInput, "recipientUserId" | "recipientRole">,
): Promise<void> {
  const recipients = await scopedDb.user.findMany({
    where: {
      companyId: scope.companyId,
      workerId: scope.workerId,
      candidateId: scope.candidateId,
      isActive: true,
    },
    select: { id: true },
  });
  for (const r of recipients) {
    await emitNotification({ ...input, recipientUserId: r.id });
  }
}
