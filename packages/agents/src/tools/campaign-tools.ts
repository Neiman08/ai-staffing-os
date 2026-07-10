import { z } from "zod";
import type { AgentTool } from "../core/AgentTool";
import { NotImplementedError } from "../core/AgentRuntime";

function notImplemented<TInput, TOutput>(): (input: TInput) => Promise<TOutput> {
  return async () => {
    throw new NotImplementedError("F4");
  };
}

/**
 * F4: Campaign Agent. Ver F4_AUTONOMOUS_OUTREACH_PLAN.md §4/§11. Crea
 * campañas, selecciona empresas objetivo ya existentes en el CRM, mide
 * resultados y sugiere optimizaciones — nunca envía nada, nunca cambia
 * una campaña activa por su cuenta (optimizeCampaign solo recomienda).
 */
export const createCampaignInputSchema = z.object({
  name: z.string().min(1),
  industryId: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  minCompanySize: z.enum(["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"]).optional(),
  maxCompanySize: z.enum(["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"]).optional(),
  targetCategoryIds: z.array(z.string()).optional(),
  minScore: z.number().min(0).max(100).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  createdByAgentTaskId: z.string().optional(),
});
export const createCampaignTool: AgentTool<
  z.infer<typeof createCampaignInputSchema>,
  { campaignId: string; reused: boolean }
> = {
  name: "createCampaign",
  description:
    "Crea una campaña comercial con criterios de segmentación, o reutiliza una ya DRAFT/ACTIVE con criterios equivalentes en vez de duplicarla.",
  inputSchema: createCampaignInputSchema,
  execute: notImplemented(),
};

export const selectTargetCompaniesInputSchema = z.object({
  campaignId: z.string(),
  limit: z.number().int().positive().max(50).optional(),
});
export const selectTargetCompaniesTool: AgentTool<
  z.infer<typeof selectTargetCompaniesInputSchema>,
  { companyIds: string[]; addedCount: number }
> = {
  name: "selectTargetCompanies",
  description:
    "Selecciona empresas ya existentes en el CRM que calzan con los criterios de la campaña (industria, ubicación, tamaño, score mínimo), excluyendo las ya targeteadas en otra campaña activa.",
  inputSchema: selectTargetCompaniesInputSchema,
  execute: notImplemented(),
};

export const measureCampaignInputSchema = z.object({
  campaignId: z.string(),
});
export interface CampaignMetrics {
  statusCounts: Record<string, number>;
  costUsd: number;
  leadsCreated: number;
  opportunitiesCreated: number;
  opportunitiesValueUsd: number;
}
export const measureCampaignTool: AgentTool<z.infer<typeof measureCampaignInputSchema>, CampaignMetrics> = {
  name: "measureCampaign",
  description: "Agrega los resultados reales de una campaña (empresas por estado, costo, leads/oportunidades generadas) — sin LLM.",
  inputSchema: measureCampaignInputSchema,
  execute: notImplemented(),
};

export const optimizeCampaignInputSchema = z.object({
  campaignId: z.string(),
});
export const optimizeCampaignTool: AgentTool<z.infer<typeof optimizeCampaignInputSchema>, { recommendation: string }> = {
  name: "optimizeCampaign",
  description:
    "Redacta una recomendación corta para mejorar una campaña a partir de sus métricas reales — solo asesora, nunca cambia la campaña por su cuenta.",
  inputSchema: optimizeCampaignInputSchema,
  execute: notImplemented(),
};
