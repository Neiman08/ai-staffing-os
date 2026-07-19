import { prisma } from "@ai-staffing-os/db";
import { AppError } from "../../core/errors";
import { isMfaEnforced } from "../../core/security-settings";
import type { ResolvedIdentity } from "./auth-provider";

/**
 * F4.9: subconjunto mínimo del AuthObject de Clerk que esta función
 * necesita — deliberadamente no depende de @clerk/express acá, así se
 * puede testear con objetos simulados (ver clerk-identity.test.ts) sin
 * levantar una sesión real de Clerk ni requerir credenciales.
 */
export interface ClerkSessionIdentity {
  userId: string;
  orgId: string | null;
  // F4.9 §6: derivado en clerk.provider.ts desde sessionClaims.fva (si
  // el segundo factor fue verificado EN ESTA sesión) — nunca desde
  // User.mfaEnabled acá (eso es solo estado de enrollment, no de
  // verificación de la sesión actual).
  mfaVerified: boolean;
}

// F4.9 §12: "login fallido cuando sea observable" — solo se puede
// atribuir a un tenant real en los casos donde ya resolvimos uno antes
// de fallar (a partir de acá abajo). El caso "sin orgId"/"orgId no
// mapea a ningún Tenant" nunca se audita: no hay tenantId real al que
// asociar la fila (AuditLog.tenantId es NOT NULL) y este código nunca
// inventa uno. actorId es el clerkId crudo cuando todavía no existe un
// User interno (USER_NOT_PROVISIONED) — la única identidad real
// disponible en ese caso.
async function logLoginFailed(tenantId: string, actorId: string, reason: string): Promise<void> {
  await prisma.auditLog.create({
    data: { tenantId, actorType: "HUMAN", actorId, action: "auth.login_failed", entityType: "user", entityId: actorId, after: { reason } },
  });
}

/**
 * Resuelve una sesión de Clerk ya verificada (firma/issuer/audience/exp
 * ya validados por el SDK antes de llegar acá) a la identidad interna
 * real: tenantId/userId/permissions vienen SIEMPRE de la DB, nunca del
 * JWT — Clerk es fuente de verdad de identidad, la DB de tenant/rol/
 * permisos/estado operativo (ver docs/F4_9_PRODUCTION_AUTH_PLAN.md §1).
 *
 * Nunca crea un Tenant o User al vuelo: si la organización o el usuario
 * no están provistos en la DB, se rechaza — el único camino para que un
 * User exista es el webhook `user.created` encontrando una invitación
 * PENDING (ver webhook.router.ts, F4.9-5).
 */
export async function resolveIdentityFromClerkSession(auth: ClerkSessionIdentity): Promise<ResolvedIdentity> {
  if (!auth.orgId) {
    throw AppError.unauthorized("No active organization in session");
  }

  const tenant = await prisma.tenant.findUnique({ where: { clerkOrganizationId: auth.orgId } });
  if (!tenant) {
    throw AppError.unauthorized("Organization is not linked to a tenant");
  }
  if (!tenant.isActive) {
    await logLoginFailed(tenant.id, auth.userId, "tenant_inactive");
    throw new AppError(401, "TENANT_INACTIVE", "Tenant is inactive");
  }

  const user = await prisma.user.findUnique({
    where: { clerkId: auth.userId },
    include: {
      role: {
        include: { permissions: { include: { permission: true } } },
      },
    },
  });

  // Sin User interno vinculado a este clerkId → nunca se autoprovisiona
  // acá (eso es responsabilidad exclusiva del webhook user.created, y
  // solo cuando hay una invitación PENDING real esperándolo).
  if (!user) {
    await logLoginFailed(tenant.id, auth.userId, "user_not_provisioned");
    throw new AppError(401, "USER_NOT_PROVISIONED", "No internal user is linked to this Clerk account");
  }
  // Defensa en profundidad: un User cuyo clerkId resuelve pero cuyo
  // tenantId no coincide con el tenant de la organización activa nunca
  // debe autorizarse — évita cualquier fuga entre tenants si alguna vez
  // hay una inconsistencia de datos.
  if (user.tenantId !== tenant.id) {
    await logLoginFailed(tenant.id, user.id, "tenant_mismatch");
    throw AppError.unauthorized("User does not belong to the active organization's tenant");
  }
  if (!user.isActive) {
    await logLoginFailed(tenant.id, user.id, "user_disabled");
    throw new AppError(403, "USER_DISABLED", "User account is disabled");
  }

  return {
    tenantId: tenant.id,
    userId: user.id,
    permissions: user.role.permissions.map((rp) => rp.permission.key),
    mfaVerified: auth.mfaVerified,
    mfaEnforced: isMfaEnforced(tenant),
    // F12.3 (bugfix real, encontrado en la verificación de Clerk): faltaba
    // acá -- dev-bypass.provider.ts ya poblaba estos 3 campos desde F10.1,
    // pero este resolver nunca los leyó del mismo User que ya tenía en
    // memoria. Sin esto, CUALQUIER identidad de portal (Client/Worker/
    // Candidate) autenticada por Clerk real quedaba indistinguible de un
    // usuario interno: requireInternalIdentity() (agregado en la
    // auditoría pre-F11 para bloquear exactamente /dashboard/audit-log,
    // /revenue/*, /analytics/*) solo revisa
    // ctx.companyId/workerId/candidateId -- con los tres en undefined,
    // un CLIENT_ADMIN/WORKER/CANDIDATE real habría pasado esa gate como
    // si fuera personal interno. Nunca se detectó antes porque dev-bypass
    // (el único camino ejercitado en tests hasta ahora) sí los poblaba.
    companyId: user.companyId ?? undefined,
    workerId: user.workerId ?? undefined,
    candidateId: user.candidateId ?? undefined,
  };
}
