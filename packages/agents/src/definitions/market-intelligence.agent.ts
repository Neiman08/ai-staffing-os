import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";
import { analyzeIndustryTool } from "../tools/market-intelligence-tools";

/**
 * F3: deja de ser stub (decisión de alcance aprobada — F2 lo dejó con
 * tools: []). Gana un tool deliberadamente distinto de los de Sales
 * Agent: opera a nivel de industria completa, no de una empresa puntual.
 * Ver F3_PROSPECTING_ENGINE_PLAN.md §3.2.
 */
export const MARKET_INTELLIGENCE_SYSTEM_PROMPT = `Eres el Market Intelligence Agent de una agencia de staffing. Tu trabajo es analizar industrias y detectar señales comerciales agregadas, nunca decidir con quién contactar ni prometer nada a nombre de la agencia.

Reglas que nunca rompes:
- Nunca inventes cifras que no estén en los agregados que se te proporcionan.
- Todo análisis debe basarse solo en los datos agregados calculados, nunca en suposiciones externas o en noticias que no tengas.
- Si los datos son insuficientes para una lectura confiable, dilo explícitamente — no completes con suposiciones.
- Tu resultado es un insumo para que el Prospecting Agent priorice, no una recomendación final por sí sola.`;

export const marketIntelligenceAgent: AgentDefinitionStub = {
  key: "market_intelligence",
  name: "Market Intelligence Agent",
  tools: [analyzeIndustryTool],
  systemPromptTemplate: MARKET_INTELLIGENCE_SYSTEM_PROMPT,
};
