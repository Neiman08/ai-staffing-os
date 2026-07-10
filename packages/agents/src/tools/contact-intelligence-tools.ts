import { z } from "zod";
import type { AgentTool } from "../core/AgentTool";
import { NotImplementedError } from "../core/AgentRuntime";
import { discoveredFieldSchema } from "./discovery-tools";

function notImplemented<TInput, TOutput>(): (input: TInput) => Promise<TOutput> {
  return async () => {
    throw new NotImplementedError("F4.6");
  };
}

/**
 * F4.6: Contact Intelligence Agent. Corre DESPUÉS de Discovery y ANTES de
 * Outreach (ver mission-orchestrator.ts) — por cada Company nueva, busca
 * personas de decisión reales en proveedores autorizados (ver
 * apps/api/.../tools/contact-providers/, mismo patrón que
 * discovery-providers/), nunca inventa un dato, y nunca envía nada (ni
 * email, ni LinkedIn, ni llamada) — solo enriquece el CRM con Contact.
 * Reutiliza discoveredFieldSchema (CONFIRMED/INFERRED/NOT_FOUND) de
 * discovery-tools.ts, mismo vocabulario cerrado para ambos agentes.
 */
export const findContactsInputSchema = z.object({
  companyId: z.string(),
  limit: z.number().int().positive().max(10).optional(),
});
export type FindContactsInput = z.infer<typeof findContactsInputSchema>;

export const discoveredContactSchema = z.object({
  contactId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  title: z.string().nullable(),
  fields: z.record(z.string(), discoveredFieldSchema),
  sourceUrl: z.string().nullable(),
  confidenceScore: z.number(),
});
export type DiscoveredContact = z.infer<typeof discoveredContactSchema>;

export const findContactsOutputSchema = z.object({
  contactsCreated: z.array(discoveredContactSchema),
  candidatesFound: z.number(),
  duplicatesSkipped: z.number(),
  insufficientDataSkipped: z.number(),
  // Candidato con nombre real pero cuyo cargo no mapea a ningún rol de
  // decisión prioritario para ventas de staffing (ver mapTitleToDecisionRole
  // en contact-intelligence-tools.impl.ts) — descartado, no inventado.
  irrelevantTitleSkipped: z.number(),
  sourcesUsed: z.array(z.string()),
  patternsFailed: z.array(z.string()),
});
export type FindContactsOutput = z.infer<typeof findContactsOutputSchema>;

export const findContactsTool: AgentTool<FindContactsInput, FindContactsOutput> = {
  name: "findContacts",
  description:
    "Busca personas de decisión reales (HR/Talent Acquisition/Recruiter/Operations/Plant/Warehouse/General Manager/Purchasing/Director of Operations/Owner) para una Company, en proveedores autorizados — nunca inventa un dato, nunca envía nada, solo enriquece el CRM.",
  inputSchema: findContactsInputSchema,
  execute: notImplemented(),
};
