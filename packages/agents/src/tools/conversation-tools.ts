import { z } from "zod";
import type { AgentTool } from "../core/AgentTool";
import { NotImplementedError } from "../core/AgentRuntime";

function notImplemented<TInput, TOutput>(): (input: TInput) => Promise<TOutput> {
  return async () => {
    throw new NotImplementedError("F4");
  };
}

/**
 * F4: Conversation Agent. Ver F4_AUTONOMOUS_OUTREACH_PLAN.md §4/§15.
 * Clasifica texto de respuesta pegado MANUALMENTE por un humano (no hay
 * integración de bandeja de entrada todavía — ver F4.5) en una de 7
 * categorías cerradas de intención, y actualiza el estado de la empresa
 * dentro de su campaña. FULL_AUTO — clasificar y actualizar estado
 * interno no produce nada externo.
 */
export const conversationIntentSchema = z.enum([
  "INTERESTED",
  "VERY_INTERESTED",
  "CALL_LATER",
  "NO_BUDGET",
  "HAS_PROVIDER",
  "NOT_INTERESTED",
  "OUT_OF_MARKET",
]);
export type ConversationIntentValue = z.infer<typeof conversationIntentSchema>;

export const classifyConversationInputSchema = z.object({
  campaignCompanyId: z.string(),
  replyText: z.string().min(1).max(5000),
});
export const classifyConversationTool: AgentTool<
  z.infer<typeof classifyConversationInputSchema>,
  { intent: ConversationIntentValue; rationale: string; newStatus: string }
> = {
  name: "classifyConversation",
  description:
    "Clasifica una respuesta pegada manualmente en una de 7 categorías de intención cerradas y actualiza el estado de la empresa en su campaña.",
  inputSchema: classifyConversationInputSchema,
  execute: notImplemented(),
};
