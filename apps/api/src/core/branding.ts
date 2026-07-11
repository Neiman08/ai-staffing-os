import type { BrandingConfig } from "@ai-staffing-os/shared";
import { scopedDb } from "./tenancy/prisma-extension";
import { env } from "./env";

/**
 * Branding centralizado — única fuente de verdad para nombre comercial,
 * dominio, entidad legal y datos de remitente de outreach. Nunca se
 * hardcodea "DreiStaff"/"dreistaff.com"/"Data More LLC" en ningún otro
 * archivo (UI, prompts, docs de código) — todo pasa por acá. Mismo
 * patrón que getMissionSettings/getDataProviderBudgetStatus: default de
 * env.ts, overridable por Tenant.settings para el caso multi-tenant/
 * white-label futuro (nunca al revés).
 *
 * outreachFromEmail/outreachReplyTo/businessPostalAddress quedan `null`
 * hasta que el PO los configure explícitamente (env u override de
 * tenant) — ningún código de F4.7 puede enviar un email real mientras
 * falten, ver docs/F4_7_EMAIL_INTELLIGENCE_PLAN.md.
 */
interface BrandingOverrides {
  legalName?: string;
  brandName?: string;
  domain?: string;
  appDomain?: string;
  outreachFromName?: string;
  outreachFromEmail?: string;
  outreachReplyTo?: string;
  businessPostalAddress?: string;
}

export async function getBrandingConfig(tenantId: string): Promise<BrandingConfig> {
  const tenant = await scopedDb.tenant.findUnique({ where: { id: tenantId } });
  const overrides = ((tenant?.settings as { branding?: BrandingOverrides } | null)?.branding ?? {}) as BrandingOverrides;

  return {
    legalName: overrides.legalName ?? env.BUSINESS_LEGAL_NAME,
    brandName: overrides.brandName ?? env.BUSINESS_BRAND_NAME,
    domain: overrides.domain ?? env.BUSINESS_DOMAIN,
    appDomain: overrides.appDomain ?? env.APP_DOMAIN,
    outreachFromName: overrides.outreachFromName ?? env.OUTREACH_FROM_NAME,
    outreachFromEmail: overrides.outreachFromEmail ?? env.OUTREACH_FROM_EMAIL ?? null,
    outreachReplyTo: overrides.outreachReplyTo ?? env.OUTREACH_REPLY_TO ?? null,
    businessPostalAddress: overrides.businessPostalAddress ?? env.BUSINESS_POSTAL_ADDRESS ?? null,
  };
}
