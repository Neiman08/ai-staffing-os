import { z } from "zod";
import {
  CONVERSATION_AGENT_SYSTEM_PROMPT,
  DEFAULT_MODEL,
  classifyConversationTool as classifyConversationToolStub,
  classifyConversationInputSchema,
  conversationIntentSchema,
  type AgentTool,
  type ConversationIntentValue,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../../core/tenancy/context";
import { logActivity } from "../../../core/activity-log";
import { AppError } from "../../../core/errors";
import type { UsageAccumulator } from "../usage";

function tryParseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const parsed: unknown = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    return schema.parse(parsed);
  } catch {
    return null;
  }
}

async function auditAgentAction(params: {
  agentInstanceId: string;
  action: string;
  entityType: string;
  entityId: string;
  after?: unknown;
}) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  await scopedDb.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorType: "AGENT",
      actorId: params.agentInstanceId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      after: params.after as never,
    },
  });
}

/**
 * F4 §16: intención positiva -> HOT (o RECOVERED si venía de un estado
 * frío/excluido); NO_BUDGET/HAS_PROVIDER -> COLD; NOT_INTERESTED/
 * OUT_OF_MARKET -> EXCLUDED (simplificación deliberada respecto al "180
 * días" del plan original — exclusión permanente hasta que un humano la
 * reactive manualmente, más simple y igual de segura).
 */
function nextStatus(intent: ConversationIntentValue, previousStatus: string): string {
  const positive = intent === "INTERESTED" || intent === "VERY_INTERESTED" || intent === "CALL_LATER";
  if (positive) {
    return previousStatus === "COLD" || previousStatus === "EXCLUDED" ? "RECOVERED" : "HOT";
  }
  if (intent === "NOT_INTERESTED" || intent === "OUT_OF_MARKET") return "EXCLUDED";
  return "COLD"; // NO_BUDGET | HAS_PROVIDER
}

export interface ConversationToolDeps {
  taskId: string;
  agentInstanceId: string;
  llmProvider: LLMProvider;
  usage: UsageAccumulator;
}

/**
 * F4: único tool del Conversation Agent. Clasifica texto de respuesta
 * PEGADO MANUALMENTE por un humano (no hay integración de bandeja de
 * entrada — ver F4.5) en una de 7 categorías cerradas, validadas con Zod
 * — si el LLM devuelve algo fuera de esas 7, la tarea falla en vez de
 * persistir una categoría inventada (F4 §15).
 */
export function createConversationTools(deps: ConversationToolDeps): AgentTool[] {
  return [
    {
      ...classifyConversationToolStub,
      async execute(input: z.infer<typeof classifyConversationInputSchema>) {
        const cc = await scopedDb.campaignCompany.findUnique({
          where: { id: input.campaignCompanyId },
          include: { company: true },
        });
        if (!cc) throw AppError.notFound("CampaignCompany not found");

        await logActivity({
          entityType: "campaignCompany",
          entityId: cc.id,
          type: "EMAIL",
          subject: `Respuesta recibida — ${cc.company.name}`,
          body: input.replyText,
        });

        const prompt = `Texto de la respuesta recibida (pegado manualmente por un humano):
"""
${input.replyText}
"""

Clasificá esta respuesta en EXACTAMENTE una de estas categorías: INTERESTED, VERY_INTERESTED, CALL_LATER, NO_BUDGET, HAS_PROVIDER, NOT_INTERESTED, OUT_OF_MARKET.

Responde ÚNICAMENTE con un JSON de la forma {"intent": "<una de las 7 categorías exactas>", "rationale": "<1-2 frases en español explicando por qué, basadas solo en el texto de arriba>"}.`;

        const completion = await deps.llmProvider.complete({
          model: DEFAULT_MODEL,
          messages: [
            { role: "system", content: CONVERSATION_AGENT_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        });
        deps.usage.record(completion);

        const parsed = tryParseJson(
          completion.content,
          z.object({ intent: conversationIntentSchema, rationale: z.string().min(1) }),
        );
        if (!parsed) {
          throw AppError.internal("El Conversation Agent no pudo clasificar la respuesta. Intenta de nuevo.");
        }

        const newStatus = nextStatus(parsed.intent, cc.status);

        await scopedDb.campaignCompany.update({
          where: { id: cc.id },
          data: { lastIntent: parsed.intent, lastIntentAt: new Date(), status: newStatus as never },
        });
        await logActivity({
          entityType: "campaignCompany",
          entityId: cc.id,
          type: "SYSTEM",
          subject: `Conversation Agent clasificó la respuesta: ${parsed.intent}`,
          body: parsed.rationale,
        });
        await auditAgentAction({
          agentInstanceId: deps.agentInstanceId,
          action: "conversation.classified_by_agent",
          entityType: "campaignCompany",
          entityId: cc.id,
          after: { intent: parsed.intent, newStatus },
        });

        return { intent: parsed.intent, rationale: parsed.rationale, newStatus };
      },
    },
  ];
}
