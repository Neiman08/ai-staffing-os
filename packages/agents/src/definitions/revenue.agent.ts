import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";

/**
 * F2: sigue como stub (decisión de alcance aprobada — solo el Sales Agent
 * recibe LLM real en esta fase). scoreCompany/suggestFollowUp se
 * reasignaron al Sales Agent (ver ./sales.agent.ts) para que "calificar
 * leads" y "sugerir oportunidades" sean posibles dentro del alcance
 * aprobado; este agente queda sin tools hasta que se apruebe una fase
 * futura para él.
 */
export const revenueAgent: AgentDefinitionStub = {
  key: "revenue",
  name: "Revenue Agent",
  tools: [],
};
