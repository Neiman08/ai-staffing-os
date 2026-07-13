import type { Request } from "express";
import { prisma } from "@ai-staffing-os/db";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";
import { isMfaEnforced } from "../../core/security-settings";
import type { AuthProvider, ResolvedIdentity } from "./auth-provider";

/**
 * SECURITY: dev-bypass — reemplazar por Clerk antes de cualquier deploy
 * real (ver modules/auth/clerk.provider.ts, ya implementado pero
 * inactivo mientras AUTH_MODE=dev-bypass; F4.9 dejó la integración de
 * Clerk explícitamente diferida — ver docs/F4_9_PRODUCTION_AUTH_PLAN.md).
 * Este provider confía ciegamente en el header `x-dev-user` (o usa
 * env.DEV_DEFAULT_USER_EMAIL) sin ninguna verificación criptográfica de
 * sesión. Solo debe activarse con AUTH_MODE=dev-bypass en entornos
 * locales o de prueba — nunca en producción (env.ts se niega a arrancar
 * si NODE_ENV=production con este modo activo).
 */
export class DevBypassAuthProvider implements AuthProvider {
  async resolveIdentity(req: Request): Promise<ResolvedIdentity> {
    const headerValue = req.header("x-dev-user");
    const email = (Array.isArray(headerValue) ? headerValue[0] : headerValue) || env.DEV_DEFAULT_USER_EMAIL;

    const user = await prisma.user.findFirst({
      where: { email, isActive: true },
      include: {
        role: {
          include: {
            permissions: { include: { permission: true } },
          },
        },
      },
    });

    if (!user) {
      throw AppError.unauthorized(`dev-bypass: no active user found for email "${email}"`);
    }

    // F4.9 §7/§6: dev-bypass no tiene sesión real ni MFA — usa
    // User.mfaEnabled (seed/DB) como proxy controlable para poder
    // probar el flujo de bloqueo localmente sin Clerk ("puede existir
    // una configuración que permita probar el flujo", decisión
    // aprobada del PO). La política en sí sigue apagada por default
    // (Tenant.settings.security.mfaEnforced), así que esto no bloquea
    // nada hasta que se active a propósito.
    const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });

    return {
      tenantId: user.tenantId,
      userId: user.id,
      permissions: user.role.permissions.map((rp) => rp.permission.key),
      mfaVerified: user.mfaEnabled,
      mfaEnforced: tenant ? isMfaEnforced(tenant) : false,
    };
  }
}
