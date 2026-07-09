import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";

/**
 * F2: sigue como stub (decisión de alcance aprobada — solo el Sales Agent
 * recibe LLM real en esta fase). searchCompanies/detectHiringSignals se
 * reasignaron al Sales Agent (ver ./sales.agent.ts) para que "analizar
 * empresas" sea posible dentro del alcance aprobado; este agente queda
 * sin tools hasta que se apruebe una fase futura para él.
 */
export const marketIntelligenceAgent: AgentDefinitionStub = {
  key: "market_intelligence",
  name: "Market Intelligence Agent",
  tools: [],
};
