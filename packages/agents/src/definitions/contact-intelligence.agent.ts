import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";
import { findContactsTool } from "../tools/contact-intelligence-tools";

/**
 * F4.6: Contact Intelligence Agent. Enriquece una Company recién
 * descubierta con contactos de decisión reales — determinista (llamada a
 * proveedor + reglas de scoring), no llama al LLM directamente, por eso
 * no tiene systemPromptTemplate (mismo motivo que discoveryAgent).
 */
export const contactIntelligenceAgent: AgentDefinitionStub = {
  key: "contact_intelligence",
  name: "Contact Intelligence Agent",
  tools: [findContactsTool],
};
