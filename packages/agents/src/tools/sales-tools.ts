import { z } from "zod";
import type { AgentTool } from "../core/AgentTool";
import { NotImplementedError } from "../core/AgentRuntime";

/**
 * F1 defined these as typed contracts with execute() throwing until F2.
 * F2: all 7 belong to the Sales Agent (see ../definitions/sales.agent.ts)
 * — real execute() implementations live in apps/api (regla de oro:
 * ninguna tool toca SQL directo, todas pasan por los services que también
 * usan los humanos). This file only defines name/description/inputSchema;
 * apps/api's factory rebuilds each tool with a real execute() bound to a
 * specific AgentTask.
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
  // F2 §5: el humano puede pegar una señal de texto libre (ej. "vi que
  // publicaron una vacante en Indeed") — no reemplaza scraping, es un
  // input explícito y controlado por el humano.
  manualSignal: z.string().optional(),
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

// F2: renombrado de scoreOpportunity → scoreCompany. F1 lo había asociado
// al Revenue Agent (stub) con input opportunityId, pero el único campo de
// schema aprobado para scoring es Company.commercialScoreReason — este
// tool califica empresas prospecto, no oportunidades ya abiertas. Ver F2
// plan §7 y decisión de alcance aprobada (Company.commercialScore ya
// existía desde F1; solo se agregó el campo de razón).
export const scoreCompanyInputSchema = z.object({
  companyId: z.string(),
});
export const scoreCompanyTool: AgentTool<
  z.infer<typeof scoreCompanyInputSchema>,
  { score: number; rationale: string }
> = {
  name: "scoreCompany",
  description: "Califica el potencial comercial de una empresa (0-100) con una explicación auditable.",
  inputSchema: scoreCompanyInputSchema,
  execute: notImplemented(),
};

// F3: paso determinista del pipeline de prospección (Prospecting Agent,
// ver F3_PROSPECTING_ENGINE_PLAN.md §5). Nunca decide tarifas — igual que
// el resto de F2, eso sigue siendo exclusivo de un humano o del futuro
// Pricing Agent.
export const createOpportunityInputSchema = z.object({
  leadId: z.string(),
});
export const createOpportunityTool: AgentTool<z.infer<typeof createOpportunityInputSchema>, { opportunityId: string }> = {
  name: "createOpportunity",
  description:
    "Crea una Opportunity a partir de un Lead ya calificado, con probability conservador y sin tarifas (esas las decide un humano).",
  inputSchema: createOpportunityInputSchema,
  execute: notImplemented(),
};

// F3: en F2 suggestFollowUp solo proponía; este tool sí persiste — sigue
// siendo FULL_AUTO porque crear un recordatorio interno nunca sale del
// tenant (Arquitectura §3.4).
export const createFollowUpInputSchema = z.object({
  entityType: z.enum(["company", "lead", "opportunity", "contact"]),
  entityId: z.string(),
});
export const createFollowUpTool: AgentTool<z.infer<typeof createFollowUpInputSchema>, { followUpId: string }> = {
  name: "createFollowUp",
  description: "Crea el próximo follow-up para una entidad comercial según su actividad reciente (persiste la sugerencia de suggestFollowUp).",
  inputSchema: createFollowUpInputSchema,
  execute: notImplemented(),
};
