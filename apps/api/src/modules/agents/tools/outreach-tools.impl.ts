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
import { resolveBestContactChannel, type ContactChannelType } from "../../ceo-intelligence/contact-channel";

const BUSINESS_NAME = "DreiStaff";
// F21 Fase 3: perfiles reales que un hotel necesita, pedidos explícitamente
// por el PO -- el mensaje de hospitality se enfoca en estos, nunca en
// roles genéricos de otra industria.
const HOSPITALITY_ROLE_FOCUS = [
  "Housekeepers",
  "Room Attendants",
  "Laundry Attendants",
  "Front Desk Agents",
  "Banquet Staff",
  "Kitchen Staff",
  "Maintenance",
  "General Labor",
];
const CONFIRMED_HIRING_STATUSES = new Set(["CONFIRMED_HIRING", "LIKELY_HIRING"]);

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

    // ---- personalizeMessage: hybrid D8. Solo crea ApprovalRequest cuando
    // hay un canal de EMAIL real disponible (F21 Fase 3); si no, crea una
    // tarea comercial con el mejor canal alternativo real y nunca llama al
    // LLM ni gasta un intento de redacción sin destinatario real. ----
    {
      ...personalizeMessageToolStub,
      async execute(input: z.infer<typeof personalizeMessageInputSchema>) {
        const ctx = getTenancyContext();
        if (!ctx) throw AppError.unauthorized();

        const cc = await scopedDb.campaignCompany.findUnique({
          where: { id: input.campaignCompanyId },
          include: {
            company: { include: { industry: true, possibleCategories: true, contacts: true, contactPoints: true } },
          },
        });
        if (!cc) throw AppError.notFound("CampaignCompany not found");

        const sequence = await getSequenceFollowUps(cc.campaignId, cc.companyId);
        const step = sequence[input.step];
        if (!step) {
          throw AppError.badRequest("No existe ese paso de secuencia todavía — corré planSequence primero.");
        }

        const stepLabel = STEP_LABELS[input.step] ?? "seguimiento";
        const company = cc.company;
        const metadata = (company.discoveryMetadata as {
          contactChannel?: { careersPageUrl?: string | null; contactFormUrl?: string | null; linkedinUrl?: string | null };
          hiringSignal?: { hiringStatus?: string | null };
        } | null) ?? null;

        // F21/F22 Fase 2: resuelve el mejor canal disponible ANTES de
        // gastar ningún request al LLM -- nunca se redacta un "borrador
        // de email" para una empresa sin ningún email real.
        const channelResolution = resolveBestContactChannel({
          contacts: company.contacts.map((c) => ({ email: c.email, emailVerificationStatus: c.emailVerificationStatus, linkedinUrl: c.linkedinUrl })),
          contactPoints: company.contactPoints.map((cp) => ({ email: cp.email, verificationStatus: cp.verificationStatus })),
          companyEmail: company.email,
          companyPhone: company.phone,
          careersPageUrl: metadata?.contactChannel?.careersPageUrl ?? null,
          contactFormUrl: metadata?.contactChannel?.contactFormUrl ?? null,
          companyLinkedinUrl: metadata?.contactChannel?.linkedinUrl ?? null,
        });

        if (!channelResolution.isEmailCapable) {
          // F21 Fase 2, regla explícita: "si no existe email, crear una
          // tarea comercial con teléfono, formulario o canal alternativo" —
          // nunca se elimina la Company, nunca se inventa un email para
          // poder seguir. El paso de secuencia queda DONE (ya se procesó),
          // sin ApprovalRequest ni consumo de LLM.
          const channelLabel: Record<ContactChannelType, string> = {
            VERIFIED_PERSON_EMAIL: "email personal verificado",
            VERIFIED_ORG_EMAIL: "email organizacional verificado",
            WEBSITE_ORG_EMAIL: "email organizacional sin verificar",
            CONTACT_FORM: "formulario de contacto",
            CAREERS_PAGE: "página de careers/jobs",
            LINKEDIN: "LinkedIn",
            PHONE: "teléfono principal",
            NONE: "ningún canal",
          };
          const followUp = await followUpsService.createFollowUp({
            entityType: "company",
            entityId: cc.companyId,
            type: channelResolution.channel === "PHONE" ? "CALL" : channelResolution.channel === "LINKEDIN" ? "LINKEDIN" : "CALL",
            dueDate: new Date().toISOString(),
            priority: "MEDIUM",
            notes: `Sin email disponible para ${company.name} — canal alternativo: ${channelLabel[channelResolution.channel]}${channelResolution.value ? ` (${channelResolution.value})` : ""}. ${channelResolution.reason}`,
          });
          await scopedDb.followUp.update({
            where: { id: followUp.id },
            data: { campaignId: cc.campaignId, createdByAgentTaskId: deps.taskId },
          });
          await scopedDb.followUp.update({ where: { id: step.id }, data: { status: "DONE", completedAt: new Date() } });
          await auditAgentAction({
            agentInstanceId: deps.agentInstanceId,
            action: "outreach.alternative_channel_task_created_by_agent",
            entityType: "campaignCompany",
            entityId: cc.id,
            after: { channel: channelResolution.channel, value: channelResolution.value, reason: channelResolution.reason },
          });

          return { draftBody: null, subject: null, channel: channelResolution.channel, alternativeChannelTaskId: followUp.id };
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

        const hiringStatus = metadata?.hiringSignal?.hiringStatus ?? null;
        const hiringConfirmed = hiringStatus != null && CONFIRMED_HIRING_STATUSES.has(hiringStatus);
        const isHospitality = company.industry.name === "Hospitality";

        const prompt = `Redactá el mensaje de "${stepLabel}" (paso ${input.step + 1}/4) de una secuencia comercial por email para ${BUSINESS_NAME}, una agencia de staffing. Es SOLO un borrador — nunca digas que ya fue enviado.

Empresa: ${company.name}
Industria: ${company.industry.name}
Ciudad/estado: ${company.city ?? "—"}, ${company.state ?? "—"}
Tamaño: ${company.estimatedSize ?? "desconocido"}
Señal de contratación: ${hiringStatus ?? "sin evaluar"}${hiringConfirmed ? "" : " (NO confirmada — nunca afirmes que la empresa está contratando)"}
Necesidades posibles: ${company.possibleCategories.map((c) => c.name).join(", ") || "sin datos"}
Oportunidades abiertas: ${openOpportunities.map((o) => o.title).join(", ") || "ninguna"}
Historial reciente: ${recentActivity.map((a) => a.subject).join("; ") || "sin actividad previa"}
${isHospitality ? `Perfiles a enfocar (hospitality): ${HOSPITALITY_ROLE_FOCUS.join(", ")}.` : ""}

Reglas obligatorias:
- Estructura: asunto corto; saludo adecuado; referencia real a la empresa (nombre, ubicación o señal real de arriba — nunca un dato inventado); explicación breve de qué hace ${BUSINESS_NAME} (agencia de staffing); propuesta concreta de personal relevante a la industria; llamada a la acción sencilla (ej. coordinar una llamada breve); firma profesional.
- Nunca afirmes que la empresa está contratando salvo que la señal de arriba esté confirmada (CONFIRMED_HIRING o LIKELY_HIRING). Si no está confirmada, usá lenguaje prudente, por ejemplo (en inglés, tal cual): "We help ${isHospitality ? "hospitality operators" : "operators like you"} maintain reliable staffing coverage during busy periods, turnover or seasonal demand."
- Nunca prometas precios, tarifas ni compromisos.
- Nunca inventes un dato (nombre de contacto, número de empleados, proyecto específico) que no esté en el contexto de arriba.

Responde ÚNICAMENTE con un JSON de la forma {"subject": "<asunto corto>", "body": "<mensaje completo siguiendo la estructura de arriba, en inglés>"}.`;

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
          to: channelResolution.value,
          contactChannelSource: channelResolution.channel,
          subject: parsed.subject,
          body: parsed.body,
        };

        await scopedDb.approvalRequest.create({
          data: {
            tenantId: ctx.tenantId,
            agentTaskId: deps.taskId,
            summary: `Borrador (paso ${input.step + 1}/4, ${stepLabel}) para ${company.name}`,
            proposedAction,
            riskLevel: "MEDIUM",
          },
        });
        // Marca el paso como "preparado" (DONE) — no como "enviado", eso
        // sigue dependiendo de la aprobación humana. Evita que el
        // scheduler (F4 §14) vuelva a redactar el mismo paso en la
        // próxima corrida solo porque el FollowUp sigue con dueDate <= hoy.
        await scopedDb.followUp.update({ where: { id: step.id }, data: { status: "DONE", completedAt: new Date() } });
        await auditAgentAction({
          agentInstanceId: deps.agentInstanceId,
          action: "outreach.message_personalized_by_agent",
          entityType: "campaignCompany",
          entityId: cc.id,
          after: proposedAction,
        });

        return { draftBody: parsed.body, subject: parsed.subject, channel: channelResolution.channel, alternativeChannelTaskId: null };
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
