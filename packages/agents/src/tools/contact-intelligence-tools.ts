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

// Corrección estructural (misión Iowa, 2026-07-13): antes, "el proveedor
// no encontró a nadie" y "la cuenta del proveedor se quedó sin créditos"
// solo se distinguían leyendo el texto libre de patternsFailed — ningún
// campo estructurado lo exponía para que el orquestador de la misión (o
// el humano en Mission Detail) supiera que 0 contactos no significa "no
// existen", significa "no se pudo preguntar". Ver provider-health.ts.
export const providerStatusSchema = z.enum(["AVAILABLE", "CREDIT_EXHAUSTED", "UNAUTHORIZED", "UNAVAILABLE", "NOT_CONFIGURED"]);
export type ProviderStatusValue = z.infer<typeof providerStatusSchema>;

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
  providerStatus: providerStatusSchema,
});
export type FindContactsOutput = z.infer<typeof findContactsOutputSchema>;

export const findContactsTool: AgentTool<FindContactsInput, FindContactsOutput> = {
  name: "findContacts",
  description:
    "Busca personas de decisión reales (HR/Talent Acquisition/Recruiter/Operations/Plant/Warehouse/General Manager/Purchasing/Director of Operations/Owner) para una Company, en proveedores autorizados — nunca inventa un dato, nunca envía nada, solo enriquece el CRM.",
  inputSchema: findContactsInputSchema,
  execute: notImplemented(),
};

/**
 * F4.7: ampliación del Contact Intelligence Agent — busca y VERIFICA
 * emails reales para los Contact de una Company (Website Intelligence
 * primero, gratis; Hunter.io como respaldo pago). Nunca envía nada, solo
 * enriquece Contact.email/emailVerificationStatus. Ver
 * docs/F4_7_EMAIL_INTELLIGENCE_PLAN.md §5.
 */
export const findEmailInputSchema = z.object({
  companyId: z.string(),
  contactId: z.string().optional(), // si se omite, procesa todos los Contact sin email VERIFIED de esa Company
});
export type FindEmailInput = z.infer<typeof findEmailInputSchema>;

export const emailUpdatedContactSchema = z.object({
  contactId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  emailSource: z.string().nullable(),
  emailVerificationStatus: z.enum(["NOT_VERIFIED", "VERIFIED", "RISKY", "INVALID", "UNKNOWN"]),
  emailConfidenceScore: z.number().nullable(),
});
export type EmailUpdatedContact = z.infer<typeof emailUpdatedContactSchema>;

export const findEmailOutputSchema = z.object({
  contactsProcessed: z.number(),
  // Corrección estructural: ahora incluye el email organizacional
  // (Company.email) cuando se encontró, no solo los emails por Contact —
  // antes, una Company sin ningún Contact pero con "info@empresa.com"
  // encontrado en su sitio reportaba emailsFound=0, subestimando el
  // trabajo real hecho.
  emailsFound: z.number(),
  emailsVerified: z.number(), // status distinto de NOT_VERIFIED/UNKNOWN, es decir, el proveedor devolvió una clasificación real
  contactsUpdated: z.array(emailUpdatedContactSchema),
  companyEmailUpdated: z.boolean(), // Company.email se completó con un email genérico encontrado en el sitio o en Hunter
  websitePagesVisited: z.number(),
  sourcesUsed: z.array(z.string()),
  patternsFailed: z.array(z.string()),
  hunterProviderStatus: providerStatusSchema,
});
export type FindEmailOutput = z.infer<typeof findEmailOutputSchema>;

export const findEmailTool: AgentTool<FindEmailInput, FindEmailOutput> = {
  name: "findEmail",
  description:
    "Busca y verifica emails reales para los Contact de una Company — website oficial primero (gratis), Hunter.io como respaldo. Nunca inventa un email ni por patrón ni por inferencia, nunca envía nada, solo enriquece el CRM. Solo un email VERIFIED queda disponible para outreach futuro.",
  inputSchema: findEmailInputSchema,
  execute: notImplemented(),
};
