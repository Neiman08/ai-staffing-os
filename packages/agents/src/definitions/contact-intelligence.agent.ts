import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";
import { findContactsTool, findEmailTool } from "../tools/contact-intelligence-tools";

/**
 * F4.6/F4.7: Contact Intelligence Agent. Enriquece una Company recién
 * descubierta con contactos de decisión reales (F4.6) y sus emails
 * reales, verificados (F4.7 — ver docs/F4_7_EMAIL_INTELLIGENCE_PLAN.md
 * §5) — determinista (llamada a proveedor + reglas de scoring), no llama
 * al LLM directamente, por eso no tiene systemPromptTemplate (mismo
 * motivo que discoveryAgent).
 */
export const contactIntelligenceAgent: AgentDefinitionStub = {
  key: "contact_intelligence",
  name: "Contact Intelligence Agent",
  tools: [findContactsTool, findEmailTool],
};
