import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";
import { discoverCompaniesTool } from "../tools/discovery-tools";

/**
 * F4.5A: Discovery Agent. Busca empresas reales en fuentes públicas
 * externas, deduplica contra el CRM, y crea Company/Lead con procedencia
 * completa (origin=EXTERNAL_DISCOVERY) — determinista (HTTP + reglas de
 * scoring), no llama al LLM directamente, por eso no tiene
 * systemPromptTemplate (mismo motivo que prospectingAgent).
 */
export const discoveryAgent: AgentDefinitionStub = {
  key: "discovery",
  name: "Discovery Agent",
  tools: [discoverCompaniesTool],
};
