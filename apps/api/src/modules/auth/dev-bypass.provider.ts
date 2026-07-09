import type { Request } from "express";
import { prisma } from "@ai-staffing-os/db";
import { AppError } from "../../core/errors";
import type { AuthProvider, ResolvedIdentity } from "./auth-provider";

const DEFAULT_DEV_USER_EMAIL = "admin@titan.dev";

/**
 * SECURITY: dev-bypass — reemplazar por Clerk antes de cualquier deploy.
 * Este provider confía ciegamente en el header `x-dev-user` (o usa el
 * admin por defecto) sin ninguna verificación criptográfica de sesión.
 * Solo debe activarse con AUTH_MODE=dev-bypass en entornos locales.
 */
export class DevBypassAuthProvider implements AuthProvider {
  async resolveIdentity(req: Request): Promise<ResolvedIdentity> {
    const headerValue = req.header("x-dev-user");
    const email = (Array.isArray(headerValue) ? headerValue[0] : headerValue) || DEFAULT_DEV_USER_EMAIL;

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

    return {
      tenantId: user.tenantId,
      userId: user.id,
      permissions: user.role.permissions.map((rp) => rp.permission.key),
    };
  }
}
