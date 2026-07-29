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
  // F28 (aislamiento entre misiones, hallazgo real 2026-07-27): cuando
  // la misión actual acaba de descubrir empresas nuevas (external
  // discovery fallback real, ver mission-orchestrator.ts), la selección
  // debe limitarse EXCLUSIVAMENTE a esos ids reales (los que
  // executeDiscoveryPlan/DiscoveryExecutionReport.createdCompanyIds ya
  // devuelve) -- nunca al resto del CRM que matchea la misma industria/
  // estado por casualidad (el bug real: una misión de roofing con 25
  // empresas nuevas terminó con 33 "seleccionadas" porque tomó también
  // empresas de una misión anterior de data centers, mismo bucket
  // Construction). Ids explícitos, NUNCA un AgentTask id -- ver el
  // comentario de diseño en campaign-tools.impl.ts sobre por qué
  // Company.discoveredByAgentTaskId no sirve acá (apunta al child task
  // "discover_companies", no a la misión raíz). Opcional: cuando la
  // misión NO descubrió nada nuevo (ya había suficiente oferta interna
  // -- el caso real de "trabajar sobre la base existente"), se omite y
  // el comportamiento de selección amplia por industria/estado sigue
  // igual que siempre.
  restrictToCompanyIds: z.array(z.string()).optional(),
  // F28 (misión real de Hospitality, 2026-07-29): cuando
  // restrictToCompanyIds queda vacío porque el descubrimiento de ESTA
  // misión no encontró NADA nuevo (todo duplicado de una misión anterior
  // del mismo trade+estado, mismo día) -- nunca porque el trade no tenga
  // industria real -- la selección amplia por industria/estado NO
  // alcanza sola: varios trades comparten el mismo bucket de Industry
  // (ej. roofing/electrical/data centers, todos "Construction"), así que
  // sin este filtro adicional se reintroduciría el bug de aislamiento
  // original (D). Se acota por Company.tradeKey (poblado con evidencia
  // real, ver F19 Fase 1) a los taxonomyKey NO genéricos que esta misión
  // matcheó -- nunca al bucket amplio completo.
  restrictToTradeKeys: z.array(z.string()).optional(),
  // F28 (hallazgo real, misión de Hospitality, 2026-07-29): cuando la
  // misión excluye explícitamente un tipo de negocio (ej. "excluye
  // motels, inns, bed & breakfast y guest houses"), esa exclusión debe
  // prevalecer también sobre empresas YA existentes en el CRM -- no solo
  // sobre candidatos nuevos de Discovery (que ya la aplican en
  // business-validation.ts, ver matchesMissionExclusion). Bug real:
  // "Cornerstone Inn", ya en el CRM desde una misión anterior sin esta
  // exclusión, fue seleccionada por el fallback de restrictToTradeKeys y
  // llegó a generar Lead+Opportunity pese a la exclusión explícita de
  // esta misión. Mismos términos que StructuredIntent.exclusions
  // (intent-interpreter.ts) -- nunca una lista fija de nombres de
  // empresa, siempre genérica por tipo de negocio.
  excludeNameTerms: z.array(z.string()).optional(),
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
