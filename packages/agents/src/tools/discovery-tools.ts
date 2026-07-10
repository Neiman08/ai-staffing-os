import { z } from "zod";
import type { AgentTool } from "../core/AgentTool";
import { NotImplementedError } from "../core/AgentRuntime";

function notImplemented<TInput, TOutput>(): (input: TInput) => Promise<TOutput> {
  return async () => {
    throw new NotImplementedError("F4.5A");
  };
}

/**
 * F4.5A (External Discovery Pilot): busca empresas reales fuera del CRM en
 * fuentes públicas autorizadas (ver docs/F4_5_EXTERNAL_DISCOVERY_AND_EMAIL_PLAN.md,
 * addendum del piloto), las deduplica contra el CRM, y crea Company con
 * origin=EXTERNAL_DISCOVERY. Nunca inventa un dato: cada campo encontrado
 * se clasifica CONFIRMED/INFERRED/NOT_FOUND (ver fieldStatusSchema) y solo
 * CONFIRMED llega a una columna de Company. No envía nada — sin
 * ApprovalGate, no está en TOOLS_REQUIRING_APPROVAL.
 */
export const fieldStatusSchema = z.enum(["CONFIRMED", "INFERRED", "NOT_FOUND"]);
export type FieldStatus = z.infer<typeof fieldStatusSchema>;

export const discoveredFieldSchema = z.object({
  status: fieldStatusSchema,
  value: z.union([z.string(), z.number()]).nullable(),
});
export type DiscoveredField = z.infer<typeof discoveredFieldSchema>;

export const discoverCompaniesInputSchema = z.object({
  industryNames: z.array(z.string()).min(1),
  state: z.string().min(1),
  city: z.string().optional(),
  categoryNames: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(50).optional(),
});
export type DiscoverCompaniesInput = z.infer<typeof discoverCompaniesInputSchema>;

export const discoveredCompanySchema = z.object({
  companyId: z.string(),
  name: z.string(),
  fields: z.record(z.string(), discoveredFieldSchema),
  sourceUrl: z.string(),
  confidenceScore: z.number(),
});
export type DiscoveredCompany = z.infer<typeof discoveredCompanySchema>;

export const discoverCompaniesOutputSchema = z.object({
  companiesCreated: z.array(discoveredCompanySchema),
  candidatesFound: z.number(),
  duplicatesSkipped: z.number(),
  insufficientDataSkipped: z.number(),
  sourcesUsed: z.array(z.string()),
  patternsFailed: z.array(z.string()),
});
export type DiscoverCompaniesOutput = z.infer<typeof discoverCompaniesOutputSchema>;

export const discoverCompaniesTool: AgentTool<DiscoverCompaniesInput, DiscoverCompaniesOutput> = {
  name: "discoverCompanies",
  description:
    "Busca empresas reales en fuentes públicas externas (industria + ubicación), deduplica contra el CRM, y crea Company/Lead para las que tienen datos suficientes — nunca inventa un dato, nunca envía nada.",
  inputSchema: discoverCompaniesInputSchema,
  execute: notImplemented(),
};
