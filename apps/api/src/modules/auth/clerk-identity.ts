import { prisma } from "@ai-staffing-os/db";
import { AppError } from "../../core/errors";
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
    throw new AppError(401, "USER_NOT_PROVISIONED", "No internal user is linked to this Clerk account");
  }
  // Defensa en profundidad: un User cuyo clerkId resuelve pero cuyo
  // tenantId no coincide con el tenant de la organización activa nunca
  // debe autorizarse — évita cualquier fuga entre tenants si alguna vez
  // hay una inconsistencia de datos.
  if (user.tenantId !== tenant.id) {
    throw AppError.unauthorized("User does not belong to the active organization's tenant");
  }
  if (!user.isActive) {
    throw new AppError(403, "USER_DISABLED", "User account is disabled");
  }

  return {
    tenantId: tenant.id,
    userId: user.id,
    permissions: user.role.permissions.map((rp) => rp.permission.key),
  };
}
