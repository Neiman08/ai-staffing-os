import type { Request } from "express";

export interface ResolvedIdentity {
  tenantId: string;
  userId: string;
  permissions: string[];
  // F4.9 §6: si la sesión actual verificó un segundo factor (Clerk:
  // sessionClaims.fva; dev-bypass: User.mfaEnabled como proxy local
  // controlable, ver docs/F4_9_PRODUCTION_AUTH_PLAN.md) y si el tenant
  // tiene la política de MFA activa. requirePermission usa ambos para
  // bloquear permisos sensibles — nunca confía solo en que el frontend
  // muestre un aviso.
  mfaVerified: boolean;
  mfaEnforced: boolean;
  // F10.1: identidad de portal -- poblado desde User.companyId/workerId/
  // candidateId (ver dev-bypass.provider.ts). undefined para todo
  // personal interno (comportamiento sin cambios desde F0). Exactamente
  // uno debería estar presente para un usuario de portal real, nunca
  // más de uno -- validado en el service de creación de usuarios de
  // portal (F10.1), no acá.
  companyId?: string;
  workerId?: string;
  candidateId?: string;
}

/**
 * Enchufable: dev-bypass.provider.ts implementa esto en F0. Clerk se
 * enchufa en F1 con un clerk.provider.ts que satisface la misma interfaz
 * (verificar sesión de Clerk, resolver tenantId de la org activa) sin
 * tocar ningún módulo de negocio.
 */
export interface AuthProvider {
  resolveIdentity(req: Request): Promise<ResolvedIdentity>;
}
