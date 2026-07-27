import { z } from "zod";
import { Prisma } from "@ai-staffing-os/db";
import { DEFAULT_EMAIL_SIGNATURE } from "@ai-staffing-os/shared";
import {
  OpenAIProvider,
  SALES_AGENT_SYSTEM_PROMPT,
  agentSuccess,
  agentFailure,
  classifyError,
  buildEventEnvelope,
  buildIdempotencyKey,
  AgentError,
  type AgentExecutor,
  type AgentExecutionContext,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { env } from "../../../core/env";
import { evaluateDraftCreationGate } from "../../ceo-intelligence/draft-creation-gate";
import { resolveBestContactChannel } from "../../ceo-intelligence/contact-channel";
import { hasActiveApprovalForCompany } from "../../approvals/service";

/**
 * F26 (primer piloto de outreach real): Draft real, un solo disparo --
 * sin Campaign/CampaignCompany ni secuencia de 4 pasos (esos son el
 * modelo de outreach-tools.impl.ts, para campañas manuales). Una misión
 * piloto no crea una Campaign; este executor genera UN borrador para UNA
 * Company/Contact, reusando SIN duplicar los mismos chokepoints reales
 * que ya usan outreach-tools.impl.ts/sales-tools.impl.ts:
 * evaluateDraftCreationGate (DEMO_SEED/duplicado activo/client-owner/sin
 * canal) y resolveBestContactChannel (nunca inventa un email). Reusa
 * también el mismo prompt/firma exactos de sales-tools.impl.ts
 * (SALES_AGENT_SYSTEM_PROMPT/DEFAULT_EMAIL_SIGNATURE) -- ningún llamador
 * de este pipeline puede terminar en un tono/firma distintos según qué
 * camino generó el borrador.
 *
 * Crea un `Lead` mínimo (companyId/industryId/status=NEW) antes del
 * ApprovalRequest -- el resto del CRM (Approvals.tsx "Ver lead",
 * proposedAction.leadId) ya asume que un borrador de outreach viene de
 * un Lead real; nunca se inventa un ApprovalRequest sin uno.
 *
 * SIEMPRE termina en `agentSuccess` -- igual que los 2 call sites viejos,
 * ser bloqueado por el gate (NEEDS_ENRICHMENT/CLIENT_OWNER_REVIEW/
 * DUPLICATE_ACTIVE) es un resultado esperado y rutinario, no una falla
 * técnica. NUNCA aprueba ni envía nada -- el ApprovalRequest queda
 * PENDING, la decisión sigue siendo 100% humana (ver Approvals.tsx).
 */

export const draftTaskInputSchema = z.object({
  companyId: z.string().min(1),
});
export type DraftTaskInput = z.infer<typeof draftTaskInputSchema>;

export interface DraftExecutionOutput {
  approvalRequestId: string | null;
  blockReason: string | null;
}

function tryParseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Mismo patrón exacto que MissingApiKeyProvider (task-executor.ts) --
// nunca lanza al construirse, solo al llamar .complete() de verdad. Así
// registrar este executor con OPENAI_API_KEY ausente no puede tumbar el
// resto del Orchestrator (discover_companies/find_contacts/
// evaluate_draft_quality no dependen de un LLM); la falla queda
// contenida y clasificada dentro de execute(), como cualquier otro error
// real de este executor.
class MissingApiKeyProvider implements LLMProvider {
  async complete(): Promise<never> {
    throw new AgentError("INVALID_INPUT", "OPENAI_API_KEY no está configurada -- no se puede redactar un borrador real.");
  }
}

function buildLLMProvider(): LLMProvider {
  return env.OPENAI_API_KEY ? new OpenAIProvider(env.OPENAI_API_KEY) : new MissingApiKeyProvider();
}

export function createDraftExecutor(llmProvider: LLMProvider = buildLLMProvider()): AgentExecutor<DraftTaskInput, DraftExecutionOutput> {
  return {
    taskType: "draft_outreach",
    stage: "OUTREACH_DRAFTING",
    inputSchema: draftTaskInputSchema,
    execute: async (context: AgentExecutionContext, input: DraftTaskInput) => {
      try {
        const company = await scopedDb.company.findUnique({
          where: { id: input.companyId },
          include: { industry: true, contacts: true, contactPoints: true },
        });
        if (!company) {
          return agentFailure(new AgentError("INVALID_INPUT", `Company ${input.companyId} no existe.`));
        }

        // F26: nunca se elige un Contact que pidió no ser contactado o
        // cuyo email rebotó -- filtro real, ausente en los 2 call sites
        // viejos (deuda preexistente que no se toca acá), aplicado desde
        // el día uno en este camino nuevo.
        const contactableContacts = company.contacts.filter((c) => !c.doNotContact && !c.bouncedAt && !c.unsubscribedAt);

        const channelResolution = resolveBestContactChannel({
          contacts: contactableContacts.map((c) => ({ email: c.email, emailVerificationStatus: c.emailVerificationStatus, linkedinUrl: c.linkedinUrl, verificationStatus: c.verificationStatus })),
          contactPoints: company.contactPoints.map((cp) => ({ email: cp.email, verificationStatus: cp.verificationStatus })),
          companyEmail: company.email,
          companyPhone: company.phone,
          careersPageUrl: null,
          contactFormUrl: null,
          companyLinkedinUrl: null,
        });

        // F26: `opportunityRecommendation` NO se lee de discoveryMetadata
        // acá a propósito -- ese valor es un snapshot que mission-executor.ts
        // calcula durante Discovery, ANTES de que exista ningún Contact
        // real (en el pipeline piloto, find_contacts es una tarea reactiva
        // SEPARADA y posterior). Con cero contactos/email todavía, ese
        // snapshot recomienda casi siempre MANUAL_REVIEW por evidencia
        // insuficiente -- correcto en el momento en que se calculó, pero
        // ya no refleja la realidad una vez que Contact Intelligence sí
        // encontró un contacto real. Recalcularlo acá con evidencia fresca
        // duplicaría recommendOpportunityAction (7 inputs, lógica de
        // scoring completa) fuera de su único caller real
        // (mission-executor.ts) -- se prefiere, en cambio, no evaluar esa
        // condición específica del gate en este camino. isClientOwnerCandidate
        // (la otra causa de CLIENT_OWNER_REVIEW) sigue siendo real y se seguirá
        // respetando siempre.
        const discoveryMeta = (company.discoveryMetadata ?? {}) as { isClientOwnerCandidate?: boolean };
        const gate = evaluateDraftCreationGate({
          companyOrigin: company.origin,
          isClientOwnerCandidate: !!discoveryMeta.isClientOwnerCandidate,
          opportunityRecommendation: null,
          channel: channelResolution,
          hasActiveDuplicateApproval: await hasActiveApprovalForCompany(company.id),
        });

        if (!gate.allowed) {
          if (gate.companyBlockReasonToPersist) {
            await scopedDb.company.update({
              where: { id: company.id },
              data: { outreachBlockedReason: gate.companyBlockReasonToPersist, outreachBlockedAt: new Date() },
            });
          }
          return agentSuccess({ approvalRequestId: null, blockReason: gate.blockReason }, []);
        }

        const contact = contactableContacts.find((c) => c.isPrimary) ?? contactableContacts.find((c) => c.decisionRole) ?? contactableContacts[0] ?? null;

        const prompt = `Redacta un borrador de primer contacto por email para esta empresa. Es SOLO un borrador -- nunca digas que ya fue enviado.

Empresa: ${company.name}
Industria: ${company.industry.name}
Ubicación: ${company.city ?? "—"}, ${company.state ?? "—"}
Contacto: ${contact ? `${contact.firstName} ${contact.lastName}${contact.title ? `, ${contact.title}` : ""}` : "sin contacto identificado todavía -- dirígete a la empresa en general"}

Nunca te presentes como una persona con nombre propio (nunca escribas frases como "Mi nombre es [algo]" o similar) -- escribe en nombre del equipo de DreiStaff, nunca de un individuo sin nombre real. Nunca prometas precios, tarifas ni compromisos. Nunca inventes un dato que no esté en el contexto de arriba. Termina el mensaje EXACTAMENTE con esta firma, sin modificarla ni traducirla, y nunca uses ningún placeholder entre corchetes en ninguna parte del mensaje (ej. "[Tu Nombre]", "[Tu Cargo]"):
${DEFAULT_EMAIL_SIGNATURE}

Responde ÚNICAMENTE con un JSON de la forma {"subject": "<asunto corto>", "body": "<mensaje breve, profesional, terminando con la firma exacta de arriba>"}.`;

        const completion = await llmProvider.complete({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: SALES_AGENT_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        });

        const parsed = tryParseJson(completion.content, z.object({ subject: z.string().min(1), body: z.string().min(1) }));
        if (!parsed) {
          return agentFailure(new AgentError("PERMANENT_PROVIDER_ERROR", "El modelo no devolvió un borrador válido (JSON con subject/body)."));
        }

        const lead = await scopedDb.lead.create({
          data: {
            tenantId: context.tenantId,
            companyId: company.id,
            industryId: company.industryId,
            city: company.city,
            state: company.state,
            status: "NEW",
            source: "pilot-mission",
          },
        });

        const proposedAction = {
          channel: "EMAIL" as const,
          leadId: lead.id,
          companyId: company.id,
          contactId: contact?.id ?? null,
          to: channelResolution.value,
          contactChannelSource: channelResolution.channel,
          subject: parsed.subject,
          body: parsed.body,
        };

        let approval;
        try {
          approval = await scopedDb.approvalRequest.create({
            data: {
              tenantId: context.tenantId,
              agentTaskId: context.taskId,
              companyId: company.id,
              summary: `Borrador de email para ${company.name} (misión piloto)`,
              proposedAction,
              riskLevel: "MEDIUM",
            },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            return agentSuccess({ approvalRequestId: null, blockReason: "DUPLICATE_ACTIVE" }, []);
          }
          throw err;
        }

        const event = buildEventEnvelope({
          eventType: "outreach.draft_created.v1",
          tenantId: context.tenantId,
          correlationId: context.correlationId,
          causationId: context.causationId,
          actorType: "AGENT" as const,
          actorId: context.agentInstanceId,
          entityType: "approval_request",
          entityId: approval.id,
          payload: { approvalRequestId: approval.id, companyId: company.id, channel: "EMAIL", subjectPreview: parsed.subject },
          idempotencyKey: buildIdempotencyKey(context.correlationId, "outreach.draft_created.v1", approval.id),
        });

        return agentSuccess({ approvalRequestId: approval.id, blockReason: null }, [event]);
      } catch (err) {
        return agentFailure(new AgentError(classifyError(err), err instanceof Error ? err.message : String(err), err));
      }
    },
  };
}
