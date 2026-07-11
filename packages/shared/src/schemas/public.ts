import { z } from "zod";

/**
 * F4.8: contrato entre el sitio público (apps/marketing) y
 * apps/api/src/modules/public/ — la ÚNICA superficie que el sitio
 * público puede tocar del backend, nunca las rutas internas del CRM.
 */
export const publicIndustrySchema = z.object({
  id: z.string(),
  name: z.string(),
  categories: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type PublicIndustry = z.infer<typeof publicIndustrySchema>;

export const publicJobOpeningSchema = z.object({
  id: z.string(),
  title: z.string(),
  categoryName: z.string(),
  industryName: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  shiftType: z.string(),
  workersNeeded: z.number(),
});
export type PublicJobOpening = z.infer<typeof publicJobOpeningSchema>;

export const publicStatsSchema = z.object({
  industriesServed: z.number(),
  statesActive: z.number(),
  companiesInNetwork: z.number(),
  aiAgentsActive: z.number(),
});
export type PublicStats = z.infer<typeof publicStatsSchema>;

// Contact / Request Talent — ambos crean un Lead real, nunca envían un
// email. companyName/industryName/message son opcionales en Contact,
// más exigidos en Request Talent (el frontend decide qué pide).
export const publicLeadInputSchema = z.object({
  companyName: z.string().max(200).optional(),
  contactName: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  industryName: z.string().max(120).optional(),
  state: z.string().max(2).optional(),
  city: z.string().max(120).optional(),
  message: z.string().max(2000).optional(),
});
export type PublicLeadInput = z.infer<typeof publicLeadInputSchema>;

export const publicApplicationInputSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(2).optional(),
  yearsExperience: z.coerce.number().int().min(0).max(60).optional(),
  categoryName: z.string().max(120).optional(),
  resumeUrl: z.string().url().max(500).optional(),
  smsOptIn: z.boolean().default(false),
});
export type PublicApplicationInput = z.infer<typeof publicApplicationInputSchema>;
