import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";
import { processCompanyPipelineTool } from "../tools/prospecting-tools";

/**
 * F3: nuevo agente. Orquesta la cadena completa de prospección llamando
 * a los tools ya reales de Sales Agent (y, para priorización, a la
 * memoria de industria que deja Market Intelligence Agent) — no define
 * lógica de negocio propia ni llama al LLM directamente, por eso no
 * tiene systemPromptTemplate (ver F3_PROSPECTING_ENGINE_PLAN.md §14).
 */
export const prospectingAgent: AgentDefinitionStub = {
  key: "prospecting",
  name: "Prospecting Agent",
  tools: [processCompanyPipelineTool],
};
