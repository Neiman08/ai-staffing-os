import { z } from "zod";

/**
 * Branding centralizado — ver apps/api/src/core/branding.ts (única fuente
 * de verdad del lado del servidor). El frontend nunca hardcodea el
 * nombre comercial/dominio, siempre los pide acá.
 */
export const brandingConfigSchema = z.object({
  legalName: z.string(),
  brandName: z.string(),
  domain: z.string(),
  appDomain: z.string(),
  outreachFromName: z.string(),
  outreachFromEmail: z.string().nullable(),
  outreachReplyTo: z.string().nullable(),
  businessPostalAddress: z.string().nullable(),
});
export type BrandingConfig = z.infer<typeof brandingConfigSchema>;
