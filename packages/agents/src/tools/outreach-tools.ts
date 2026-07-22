import { z } from "zod";
import type { AgentTool } from "../core/AgentTool";
import { NotImplementedError } from "../core/AgentRuntime";

function notImplemented<TInput, TOutput>(): (input: TInput) => Promise<TOutput> {
  return async () => {
    throw new NotImplementedError("F4");
  };
}

/**
 * F4: Outreach Agent. Ver F4_AUTONOMOUS_OUTREACH_PLAN.md §4/§13/§14.
 * Planifica la secuencia comercial (día 1/4/9/18), personaliza cada
 * mensaje justo a tiempo (nunca los 4 por adelantado), y decide el
 * siguiente paso tras una respuesta clasificada. personalizeMessage es
 * la única tool de este agente que siempre termina en ApprovalRequest
 * (ver ApprovalGate.ts) — nada se envía automáticamente.
 */
export const planSequenceInputSchema = z.object({
  campaignCompanyId: z.string(),
});
export const planSequenceTool: AgentTool<
  z.infer<typeof planSequenceInputSchema>,
  { followUpIds: string[]; alreadyExisted: boolean }
> = {
  name: "planSequence",
  description:
    "Crea los 4 FollowUp de la secuencia comercial (día 1/4/9/18) para una empresa en campaña — idempotente, no duplica si ya existen.",
  inputSchema: planSequenceInputSchema,
  execute: notImplemented(),
};

export const personalizeMessageInputSchema = z.object({
  campaignCompanyId: z.string(),
  step: z.number().int().min(0).max(3), // 0=día1, 1=día4, 2=día9, 3=día18
});
export const personalizeMessageTool: AgentTool<
  z.infer<typeof personalizeMessageInputSchema>,
  // F21 Fase 2/3: null cuando no hay ningún canal de email real disponible
  // -- en ese caso se crea una tarea comercial alternativa
  // (alternativeChannelTaskId) en vez de un ApprovalRequest, y nunca se
  // llama al LLM.
  { draftBody: string | null; subject?: string | null; channel: string; alternativeChannelTaskId: string | null }
> = {
  name: "personalizeMessage",
  description:
    "Redacta el mensaje del paso de secuencia que corresponde, usando el contexto real de la empresa (industria, señales, historial) -- SOLO cuando hay un canal de email real disponible (termina en ApprovalRequest); si no, crea una tarea comercial con el mejor canal alternativo real.",
  inputSchema: personalizeMessageInputSchema,
  execute: notImplemented(),
};

export const suggestNextStepInputSchema = z.object({
  campaignCompanyId: z.string(),
});
export const suggestNextStepTool: AgentTool<
  z.infer<typeof suggestNextStepInputSchema>,
  { action: string; recommendation: string }
> = {
  name: "suggestNextStep",
  description:
    "Aplica el árbol de decisión determinista sobre la intención clasificada (continuar secuencia / pausar / escalar) — sin LLM.",
  inputSchema: suggestNextStepInputSchema,
  execute: notImplemented(),
};
