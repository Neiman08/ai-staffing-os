/**
 * F4.9 §6: política de MFA por tenant — mismo patrón que
 * core/branding.ts (Tenant.settings es el Json existente, cero schema
 * nuevo). Default false: la política nunca se activa sola, exige que
 * el PO la prenda explícitamente para un tenant (ver
 * docs/F4_9_PRODUCTION_AUTH_PLAN.md §9 "Definición de rol sensible").
 */
interface SecuritySettings {
  mfaEnforced?: boolean;
}

export function isMfaEnforced(tenant: { settings: unknown }): boolean {
  const security = (tenant.settings as { security?: SecuritySettings } | null)?.security;
  return security?.mfaEnforced === true;
}
