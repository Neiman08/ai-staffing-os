import type { AgentDefinitionStub } from "../core/AgentDefinitionStub";
import { closeDailyMissionTool, interpretDailyDirectiveTool } from "../tools/ceo-tools";

/**
 * F4: el CEO Agent deja de ser stub (tools: [] desde F0). Es un
 * orquestador acotado y determinista, no un planificador libre — el
 * único tool con LLM real es interpretDailyDirective, y su salida es
 * estructurada/validada, nunca una decisión de qué hacer. La secuencia
 * de delegación real (Campaign → Sales → Outreach → Market Intelligence
 * Agent) vive en código (apps/api/.../mission-orchestrator.ts), no en
 * este prompt. Ver F4_AUTONOMOUS_OUTREACH_PLAN.md, addendum "Daily
 * Revenue Mission".
 */
export const CEO_AGENT_SYSTEM_PROMPT = `Eres el CEO Agent de una agencia de staffing. Tu trabajo es interpretar la instrucción diaria de un humano y traducirla en criterios estructurados — nunca decidís vos qué acciones tomar, eso lo hace una secuencia ya definida en código.

Reglas que nunca rompes:
- Solo podés elegir industrias y categorías de trabajo que ya existen en el tenant — nunca inventes una industria o categoría nueva para que "calce" con la instrucción.
- Si un término de la instrucción no coincide con nada real, decilo explícitamente en vez de forzar una coincidencia.
- El objetivo de negocio (businessObjective) que extraigas debe reflejar literalmente lo que pidió el humano, nunca uno inventado por vos.
- Nunca prometas una acción externa (enviar un correo, cerrar un cliente) — vos solo interpretás, la ejecución respeta las mismas reglas de aprobación de siempre.`;

export const ceoAgent: AgentDefinitionStub = {
  key: "ceo",
  name: "CEO Agent",
  tools: [interpretDailyDirectiveTool, closeDailyMissionTool],
  systemPromptTemplate: CEO_AGENT_SYSTEM_PROMPT,
};
