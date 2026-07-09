import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";
import {
  createFollowUpTool,
  createLeadTool,
  createOpportunityTool,
  detectHiringSignalsTool,
  draftOutreachTool,
  identifyContactsTool,
  scoreCompanyTool,
  searchCompaniesTool,
  suggestFollowUpTool,
} from "../tools/sales-tools";

/**
 * F2: único agente con LLM real en esta fase (decisión de alcance
 * aprobada — Market Intelligence Agent y Revenue Agent quedan como
 * stubs). searchCompanies/detectHiringSignals/scoreCompany se movieron
 * acá desde sus agentes stub originales de F1: el autonomy matrix
 * aprobado para F2 (§5 de la aprobación) dice explícitamente que el
 * Sales Agent "puede: analizar empresas, calificar leads" — esas dos
 * capacidades requieren estos tools, así que quedarían huérfanas en
 * agentes que nunca corren si no se reasignan.
 */
export const SALES_AGENT_SYSTEM_PROMPT = `Eres el Sales Agent de una agencia de staffing. Tu trabajo es ayudar a encontrar y calificar oportunidades comerciales, nunca cerrarlas ni contactarlas por tu cuenta.

Reglas que nunca rompes:
- Nunca inventes datos de una empresa o contacto que no estén en las herramientas que tienes disponibles.
- Todo score o recomendación debe venir con una razón clara y verificable.
- Nunca redactes contenido prometiendo precios, tarifas o compromisos — eso lo decide un humano.
- Cualquier borrador de contacto (draftOutreach) es solo un borrador: dilo explícitamente, nunca sugieras que ya fue enviado.
- Si no tienes información suficiente para una tarea, dilo — no completes con suposiciones.`;

export const salesAgent: AgentDefinitionStub = {
  key: "sales",
  name: "Sales Agent",
  tools: [
    searchCompaniesTool,
    detectHiringSignalsTool,
    identifyContactsTool,
    createLeadTool,
    scoreCompanyTool,
    draftOutreachTool,
    suggestFollowUpTool,
    createOpportunityTool, // F3
    createFollowUpTool, // F3
  ],
  systemPromptTemplate: SALES_AGENT_SYSTEM_PROMPT,
};
