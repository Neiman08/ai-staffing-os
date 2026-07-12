import type { Request } from "express";
import { getAuth } from "@clerk/express";
import { prisma } from "@ai-staffing-os/db";
import { AppError } from "../../core/errors";
import type { AuthProvider, ResolvedIdentity } from "./auth-provider";
import { resolveIdentityFromClerkSession } from "./clerk-identity";

/**
 * F4.9 §6: `fva` (factor verification age) es un claim estándar de
 * Clerk — [minutosDesdeVerificar1erFactor, minutosDesdeVerificar2doFactor].
 * -1 o ausente = el segundo factor nunca se verificó EN ESTA sesión
 * (aunque el usuario tenga MFA habilitado — puede tener una sesión
 * vieja de antes de habilitarlo). Nunca se infiere desde
 * User.mfaEnabled acá: eso es solo enrollment, esto es verificación
 * real de la sesión actual. Exportada para poder testear la lógica sin
 * un AuthObject real de Clerk (ver clerk.provider.test.ts).
 */
export function deriveMfaVerified(sessionClaims: unknown): boolean {
  const fva = (sessionClaims as { fva?: unknown } | null | undefined)?.fva;
  if (!Array.isArray(fva) || typeof fva[1] !== "number") return false;
  return fva[1] >= 0;
}

/**
 * F4.9: reemplaza DevBypassAuthProvider en producción. La verificación
 * criptográfica del JWT (firma, issuer, audience, expiración) la hace
 * enteramente el SDK oficial (@clerk/express, montado como
 * clerkMiddleware() en app.ts antes de tenancyMiddleware) — este
 * provider nunca toca un token crudo, solo lee el AuthObject ya
 * verificado que getAuth(req) expone.
 *
 * La resolución real (Clerk orgId → Tenant, Clerk userId → User,
 * chequeos de isActive) vive en clerk-identity.ts como una función pura
 * separada de Express — así se puede testear con objetos de auth
 * simulados sin necesitar una sesión real de Clerk ni credenciales.
 */
export class ClerkAuthProvider implements AuthProvider {
  async resolveIdentity(req: Request): Promise<ResolvedIdentity> {
    const auth = getAuth(req);
    if (!auth.userId) {
      throw AppError.unauthorized("No valid Clerk session");
    }
    const identity = await resolveIdentityFromClerkSession({
      userId: auth.userId,
      orgId: auth.orgId ?? null,
      mfaVerified: deriveMfaVerified(auth.sessionClaims),
    });

    // Fire-and-forget: nunca debe bloquear ni fallar la request por esto.
    prisma.user.update({ where: { id: identity.userId }, data: { lastLoginAt: new Date() } }).catch((err) => {
      console.error("Failed to update lastLoginAt:", err);
    });

    return identity;
  }
}
