import { z } from "zod";
import type { AgentTool } from "../core/AgentTool";
import { NotImplementedError } from "../core/AgentRuntime";

/**
 * F1: typed tool contracts for the Sales / Market Intelligence / Revenue
 * agents (F2). Defining the Zod input/output shape now forces the data
 * contract to be thought through without committing to an implementation —
 * every execute() throws until F2. No network calls, no OpenAI.
 *
 * Per Arquitectura §3.4 (autonomy matrix): creating internal records
 * (createLead, suggestFollowUp) is FULL_AUTO-eligible; anything that
 * reaches a real client (draftOutreach) requires AUTO_WITH_APPROVAL.
 * Nothing here decides prices or rejects candidates — those stay
 * "siempre humano" per the same matrix.
 */

function notImplemented<TInput, TOutput>(): (input: TInput) => Promise<TOutput> {
  return async () => {
    throw new NotImplementedError("F2");
  };
}

export const searchCompaniesInputSchema = z.object({
  industryId: z.string().optional(),
  state: z.string().optional(),
  minEstimatedSize: z.enum(["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"]).optional(),
});
export const searchCompaniesTool: AgentTool<z.infer<typeof searchCompaniesInputSchema>, { companyIds: string[] }> = {
  name: "searchCompanies",
  description: "Busca empresas nuevas que calzan con el perfil de cliente ideal (industria, estado, tamaño).",
  inputSchema: searchCompaniesInputSchema,
  execute: notImplemented(),
};

export const detectHiringSignalsInputSchema = z.object({
  companyId: z.string(),
});
export const detectHiringSignalsTool: AgentTool<
  z.infer<typeof detectHiringSignalsInputSchema>,
  { signals: string[]; confidence: number }
> = {
  name: "detectHiringSignals",
  description: "Detecta señales públicas de que una empresa está contratando (vacantes publicadas, expansión, etc.).",
  inputSchema: detectHiringSignalsInputSchema,
  execute: notImplemented(),
};

export const identifyContactsInputSchema = z.object({
  companyId: z.string(),
  decisionRole: z
    .enum(["OWNER", "HR", "OPERATIONS_MANAGER", "PROJECT_MANAGER", "PLANT_MANAGER", "RECRUITER", "OTHER"])
    .optional(),
});
export const identifyContactsTool: AgentTool<z.infer<typeof identifyContactsInputSchema>, { contactIds: string[] }> = {
  name: "identifyContacts",
  description: "Identifica contactos con poder de decisión dentro de una empresa objetivo.",
  inputSchema: identifyContactsInputSchema,
  execute: notImplemented(),
};

export const createLeadInputSchema = z.object({
  companyId: z.string().optional(),
  industryId: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  source: z.string(),
});
export const createLeadTool: AgentTool<z.infer<typeof createLeadInputSchema>, { leadId: string }> = {
  name: "createLead",
  description: "Crea un Lead a partir de una empresa o señal detectada. FULL_AUTO-eligible (crear registro interno).",
  inputSchema: createLeadInputSchema,
  execute: notImplemented(),
};

export const draftOutreachInputSchema = z.object({
  leadId: z.string(),
  channel: z.enum(["EMAIL", "LINKEDIN"]),
});
export const draftOutreachTool: AgentTool<z.infer<typeof draftOutreachInputSchema>, { draftBody: string }> = {
  name: "draftOutreach",
  description: "Redacta un borrador de mensaje de contacto inicial. Requiere AUTO_WITH_APPROVAL antes de enviarse.",
  inputSchema: draftOutreachInputSchema,
  execute: notImplemented(),
};

export const suggestFollowUpInputSchema = z.object({
  entityType: z.enum(["company", "lead", "opportunity", "contact"]),
  entityId: z.string(),
});
export const suggestFollowUpTool: AgentTool<
  z.infer<typeof suggestFollowUpInputSchema>,
  { suggestedDueDate: string; suggestedType: string; reason: string }
> = {
  name: "suggestFollowUp",
  description: "Sugiere el próximo follow-up para una entidad comercial según su actividad reciente.",
  inputSchema: suggestFollowUpInputSchema,
  execute: notImplemented(),
};

export const scoreOpportunityInputSchema = z.object({
  opportunityId: z.string(),
});
export const scoreOpportunityTool: AgentTool<
  z.infer<typeof scoreOpportunityInputSchema>,
  { score: number; rationale: string }
> = {
  name: "scoreOpportunity",
  description: "Califica la probabilidad de cierre de una oportunidad con una explicación auditable.",
  inputSchema: scoreOpportunityInputSchema,
  execute: notImplemented(),
};
