import { z } from "zod";
import {
  DEFAULT_MODEL,
  OUTREACH_AGENT_SYSTEM_PROMPT,
  personalizeMessageTool as personalizeMessageToolStub,
  personalizeMessageInputSchema,
  planSequenceTool as planSequenceToolStub,
  planSequenceInputSchema,
  suggestNextStepTool as suggestNextStepToolStub,
  suggestNextStepInputSchema,
  type AgentTool,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../../core/tenancy/context";
import { AppError } from "../../../core/errors";
import * as followUpsService from "../../followups/service";
import type { UsageAccumulator } from "../usage";

// F4 §14: día 1 (hoy) / día 4 / día 9 / día 18 — offsets en días desde hoy.
const SEQUENCE_DAY_OFFSETS = [0, 4, 9, 18];
const STEP_LABELS = ["primer contacto", "seguimiento", "caso de éxito", "último intento"];

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

async function getSequenceFollowUps(campaignId: string, companyId: string) {
  return scopedDb.followUp.findMany({
    where: { campaignId, entityType: "company", entityId: companyId },
    orderBy: { dueDate: "asc" },
  });
}

export interface OutreachToolDeps {
  taskId: string;
  agentInstanceId: string;
  llmProvider: LLMProvider;
  usage: UsageAccumulator;
}

/**
 * F4: tools del Outreach Agent. planSequence/suggestNextStep son
 * deterministas; personalizeMessage es híbrido D8 y SIEMPRE termina en
 * ApprovalRequest (ver ApprovalGate.ts) — nunca envía nada.
 */
export function createOutreachTools(deps: OutreachToolDeps): AgentTool[] {
  return [
    // ---- planSequence: deterministic, idempotent ----
    {
      ...planSequenceToolStub,
      async execute(input: z.infer<typeof planSequenceInputSchema>) {
        const cc = await scopedDb.campaignCompany.findUnique({ where: { id: input.campaignCompanyId } });
        if (!cc) throw AppError.notFound("CampaignCompany not found");

        const existing = await getSequenceFollowUps(cc.campaignId, cc.companyId);
        if (existing.length > 0) {
          return { followUpIds: existing.map((f) => f.id), alreadyExisted: true };
        }

        const followUps = [];
        for (let i = 0; i < SEQUENCE_DAY_OFFSETS.length; i++) {
          const dayOffset = SEQUENCE_DAY_OFFSETS[i]!;
          const dueDate = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
          const followUp = await followUpsService.createFollowUp({
            entityType: "company",
            entityId: cc.companyId,
            type: "EMAIL",
            dueDate: dueDate.toISOString(),
            priority: "MEDIUM",
            notes: `Paso ${i + 1}/4 de la secuencia de campaña (${STEP_LABELS[i]}).`,
          });
          await scopedDb.followUp.update({
            where: { id: followUp.id },
            data: { campaignId: cc.campaignId, createdByAgentTaskId: deps.taskId },
          });
          followUps.push(followUp);
        }

        await scopedDb.campaignCompany.update({ where: { id: cc.id }, data: { status: "SEQUENCING" } });
        await auditAgentAction({
          agentInstanceId: deps.agentInstanceId,
          action: "sequence.planned_by_agent",
          entityType: "campaignCompany",
          entityId: cc.id,
          after: { followUpIds: followUps.map((f) => f.id) },
        });

        return { followUpIds: followUps.map((f) => f.id), alreadyExisted: false };
      },
    },

    // ---- personalizeMessage: hybrid D8, ALWAYS creates an ApprovalRequest ----
    {
      ...personalizeMessageToolStub,
      async execute(input: z.infer<typeof personalizeMessageInputSchema>) {
        const ctx = getTenancyContext();
        if (!ctx) throw AppError.unauthorized();

        const cc = await scopedDb.campaignCompany.findUnique({
          where: { id: input.campaignCompanyId },
          include: { company: { include: { industry: true, possibleCategories: true } } },
        });
        if (!cc) throw AppError.notFound("CampaignCompany not found");

        const sequence = await getSequenceFollowUps(cc.campaignId, cc.companyId);
        const step = sequence[input.step];
        if (!step) {
          throw AppError.badRequest("No existe ese paso de secuencia todavía — corré planSequence primero.");
        }

        const [recentActivity, openOpportunities] = await Promise.all([
          scopedDb.activity.findMany({
            where: { entityType: "company", entityId: cc.companyId },
            orderBy: { createdAt: "desc" },
            take: 3,
          }),
          scopedDb.opportunity.findMany({
            where: { companyId: cc.companyId, stage: { notIn: ["WON", "LOST"] } },
            select: { title: true },
          }),
        ]);

        const stepLabel = STEP_LABELS[input.step] ?? "seguimiento";
        const prompt = `Redactá el mensaje de "${stepLabel}" (paso ${input.step + 1}/4) de una secuencia comercial por email. Es SOLO un borrador — nunca digas que ya fue enviado.

Empresa: ${cc.company.name}
Industria: ${cc.company.industry.name}
Ciudad/estado: ${cc.company.city ?? "—"}, ${cc.company.state ?? "—"}
Tamaño: ${cc.company.estimatedSize ?? "desconocido"}
Señales detectadas: ${cc.company.commercialScoreReason ?? "sin señales registradas"}
Necesidades posibles: ${cc.company.possibleCategories.map((c) => c.name).join(", ") || "sin datos"}
Oportunidades abiertas: ${openOpportunities.map((o) => o.title).join(", ") || "ninguna"}
Historial reciente: ${recentActivity.map((a) => a.subject).join("; ") || "sin actividad previa"}

Responde ÚNICAMENTE con un JSON de la forma {"subject": "<asunto corto>", "body": "<mensaje breve, profesional, sin prometer precios ni compromisos, usando el contexto real de arriba — nunca una plantilla genérica>"}.`;

        const completion = await deps.llmProvider.complete({
          model: DEFAULT_MODEL,
          messages: [
            { role: "system", content: OUTREACH_AGENT_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        });
        deps.usage.record(completion);

        const parsed = tryParseJson(
          completion.content,
          z.object({ subject: z.string().min(1), body: z.string().min(1) }),
        );
        if (!parsed) {
          throw AppError.internal("El Outreach Agent no pudo generar un borrador válido. Intenta de nuevo.");
        }

        const proposedAction = {
          campaignId: cc.campaignId,
          campaignCompanyId: cc.id,
          sequenceStep: input.step,
          channel: "EMAIL",
          subject: parsed.subject,
          body: parsed.body,
        };

        await scopedDb.approvalRequest.create({
          data: {
            tenantId: ctx.tenantId,
            agentTaskId: deps.taskId,
            summary: `Borrador (paso ${input.step + 1}/4, ${stepLabel}) para ${cc.company.name}`,
            proposedAction,
            riskLevel: "MEDIUM",
          },
        });
        await auditAgentAction({
          agentInstanceId: deps.agentInstanceId,
          action: "outreach.message_personalized_by_agent",
          entityType: "campaignCompany",
          entityId: cc.id,
          after: proposedAction,
        });

        return { draftBody: parsed.body, subject: parsed.subject };
      },
    },

    // ---- suggestNextStep: deterministic decision tree (F4 §16) ----
    {
      ...suggestNextStepToolStub,
      async execute(input: z.infer<typeof suggestNextStepInputSchema>) {
        const cc = await scopedDb.campaignCompany.findUnique({
          where: { id: input.campaignCompanyId },
          include: { company: true },
        });
        if (!cc) throw AppError.notFound("CampaignCompany not found");

        // Cancela los pasos de secuencia todavía pendientes — cualquier
        // intención clasificada detiene el avance automático (F4 §16).
        await scopedDb.followUp.updateMany({
          where: {
            campaignId: cc.campaignId,
            entityType: "company",
            entityId: cc.companyId,
            status: "PENDING",
          },
          data: { status: "CANCELLED" },
        });

        let action: string;
        let recommendation: string;

        switch (cc.lastIntent) {
          case "VERY_INTERESTED":
            action = "escalate_to_opportunity";
            recommendation = "Intención muy positiva — recomendado escalar a Opportunity de inmediato (Sales Agent).";
            break;
          case "INTERESTED":
            action = "human_follow_up";
            recommendation = "Intención positiva — se creó un seguimiento de llamada para un humano, no se continúa la secuencia automática.";
            await followUpsService.createFollowUp({
              entityType: "company",
              entityId: cc.companyId,
              type: "CALL",
              dueDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
              priority: "HIGH",
              notes: "Interés detectado por Conversation Agent — seguimiento humano directo.",
            });
            break;
          case "CALL_LATER":
            action = "schedule_call";
            recommendation = "Pidió que lo contacten después — se agendó una llamada en 7 días.";
            await followUpsService.createFollowUp({
              entityType: "company",
              entityId: cc.companyId,
              type: "CALL",
              dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
              priority: "MEDIUM",
              notes: "Llamar después — según respuesta clasificada por Conversation Agent.",
            });
            break;
          case "NO_BUDGET":
          case "HAS_PROVIDER":
            action = "mark_cold";
            recommendation = "Sin presupuesto o ya tiene proveedor — secuencia detenida, sin seguimiento nuevo.";
            break;
          case "NOT_INTERESTED":
          case "OUT_OF_MARKET":
            action = "exclude";
            recommendation = "No interesada o fuera de mercado — excluida de futuras selecciones automáticas.";
            break;
          default:
            action = "continue_sequence";
            recommendation = "Sin intención clasificada todavía — la secuencia sigue su curso normal.";
        }

        await auditAgentAction({
          agentInstanceId: deps.agentInstanceId,
          action: "next_step.suggested_by_agent",
          entityType: "campaignCompany",
          entityId: cc.id,
          after: { action, recommendation },
        });

        return { action, recommendation };
      },
    },
  ];
}
