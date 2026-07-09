import { z } from "zod";
import type { AgentTool } from "../core/AgentTool";
import { NotImplementedError } from "../core/AgentRuntime";

function notImplemented<TInput, TOutput>(): (input: TInput) => Promise<TOutput> {
  return async () => {
    throw new NotImplementedError("F3");
  };
}

/**
 * F3: primer tool real del Market Intelligence Agent (F2 lo dejó como
 * stub con tools: []). Opera a nivel de industria completa — agregados
 * deterministas sobre todas las Company del tenant en esa industria +
 * una capa LLM que redacta el resumen (mismo patrón híbrido D8 que
 * scoreCompany). Distinto de scoreCompany (Sales Agent), que opera sobre
 * una empresa puntual. Ver F3_PROSPECTING_ENGINE_PLAN.md §3.2.
 */
export const analyzeIndustryInputSchema = z.object({
  industryId: z.string(),
});

export interface IndustryMetrics {
  activeCompanies: number;
  averageScore: number | null;
  openJobOrders: number;
  wonOpportunitiesLast90d: number;
  wonRevenueLast90dUsd: number;
}

export const analyzeIndustryTool: AgentTool<
  z.infer<typeof analyzeIndustryInputSchema>,
  { summary: string; metrics: IndustryMetrics }
> = {
  name: "analyzeIndustry",
  description:
    "Analiza los agregados de todas las empresas de una industria (score promedio, job orders abiertos, oportunidades ganadas recientes) y redacta una lectura del mercado.",
  inputSchema: analyzeIndustryInputSchema,
  execute: notImplemented(),
};
