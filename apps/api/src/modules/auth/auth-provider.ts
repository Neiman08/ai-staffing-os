import type { Request } from "express";

export interface ResolvedIdentity {
  tenantId: string;
  userId: string;
  permissions: string[];
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
