import { scopedDb } from "./tenancy/prisma-extension";
import { getTenancyContext } from "./tenancy/context";
import { AppError } from "./errors";

/**
 * F4.9 §12: helper para AuditLog (modelo ya existente desde F1, ya
 * usado por agent tools/approvals) — evita repetir el `create()` a
 * mano en cada call site nuevo de auth. Requiere una TenancyContext ya
 * establecida; los pocos call sites que ocurren ANTES de que exista
 * contexto (login/login_failed durante la propia resolución de
 * identidad, o webhooks — que no son requests de usuario) escriben
 * directo con `prisma.auditLog.create` en vez de este helper, ver
 * clerk.provider.ts/clerk-identity.ts/webhook-handlers.ts.
 *
 * Nunca guarda tokens, contraseñas ni claims crudos de sesión — solo
 * IDs y metadatos ya resueltos (ver docs/F4_9_PRODUCTION_AUTH_PLAN.md §12).
 */
export async function logAuditEvent(params: {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}): Promise<void> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  await scopedDb.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorType: ctx.actor?.type === "AGENT" ? "AGENT" : "HUMAN",
      actorId: ctx.actor?.type === "AGENT" ? ctx.actor.agentInstanceId : ctx.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: params.before as never,
      after: params.after as never,
      ip: params.ip,
    },
  });
}
