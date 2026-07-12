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

// F4.9 §12: resolveIdentity corre en CADA request autenticado, no solo
// al iniciar sesión — sin este debounce, "auth.login" se escribiría en
// AuditLog decenas de veces por minuto de uso normal. 30 min sin
// actividad = se considera un login nuevo, no la continuación de la
// misma sesión. Aproximación deliberada: no hay un evento real de
// "sesión iniciada" separado sin suscribirse a session.created de
// Clerk (fuera del alcance de webhooks aprobado, ver
// docs/F4_9_PRODUCTION_AUTH_PLAN.md §8).
const LOGIN_AUDIT_DEBOUNCE_MS = 30 * 60 * 1000;

export async function bumpLastLoginAndMaybeAudit(userId: string, tenantId: string): Promise<void> {
  const previous = await prisma.user.findUnique({ where: { id: userId }, select: { lastLoginAt: true } });
  const isFreshLogin =
    !previous?.lastLoginAt || Date.now() - previous.lastLoginAt.getTime() > LOGIN_AUDIT_DEBOUNCE_MS;

  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });

  if (isFreshLogin) {
    await prisma.auditLog.create({
      data: { tenantId, actorType: "HUMAN", actorId: userId, action: "auth.login", entityType: "user", entityId: userId },
    });
  }
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
    bumpLastLoginAndMaybeAudit(identity.userId, identity.tenantId).catch((err) => {
      console.error("Failed to update lastLoginAt / auth.login audit:", err);
    });

    return identity;
  }
}
