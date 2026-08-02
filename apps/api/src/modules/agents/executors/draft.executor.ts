import { z } from "zod";
import { Prisma } from "@ai-staffing-os/db";
import {
  OpenAIProvider,
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
import { getTaxonomyEntry } from "../../ceo-intelligence/taxonomy";
import { generateOutreachDraft, classifyHiringSignalLevel, resolveDraftLanguage, resolvePositionsToOffer, type DraftRecipientType } from "../draft-generation";
import { UsageAccumulator } from "../usage";
import type { HiringSignalResult } from "../../ceo-intelligence/hiring-signals";

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
  /** Motivo real cuando blockReason="DRAFT_GENERATION_INSUFFICIENT_EVIDENCE" -- nunca se fuerza un Draft inventado (ver draft-generation.ts). */
  draftSkippedReason?: string | null;
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

        const hiringSignal = (company.discoveryMetadata as { hiringSignal?: HiringSignalResult | null } | null)?.hiringSignal ?? null;
        const taxonomyEntry = company.tradeKey ? getTaxonomyEntry(company.tradeKey) : undefined;
        const recipientType: DraftRecipientType = contact ? "person" : "organizational";

        let draft;
        try {
          draft = await generateOutreachDraft({
            llmProvider,
            usage: new UsageAccumulator(),
            input: {
              companyName: company.name,
              city: company.city,
              state: company.state,
              industryName: company.industry.name,
              tradeLabel: taxonomyEntry?.label ?? null,
              services: [],
              hiringSignalLevel: classifyHiringSignalLevel(hiringSignal?.hiringStatus ?? null),
              hiringSignalEvidence: hiringSignal?.evidence ?? [],
              hiringSignalSourceUrls: hiringSignal?.sourceUrls ?? [],
              positionsToOffer: resolvePositionsToOffer(hiringSignal?.targetTitlesMatched ?? [], taxonomyEntry?.jobTitles ?? []),
              recipientType,
              recipientName: contact?.firstName ?? null,
              recipientTitle: contact?.title ?? null,
              companyWebsite: company.website,
              language: resolveDraftLanguage({ hiringSignalEvidence: hiringSignal?.evidence ?? [] }),
              stepLabel: null,
              openOpportunities: [],
              recentActivitySubjects: [],
            },
          });
        } catch (err) {
          return agentFailure(new AgentError("PERMANENT_PROVIDER_ERROR", err instanceof Error ? err.message : "El modelo no devolvió un borrador válido."));
        }

        if (draft.status === "skipped") {
          // Invariante #6 (endurecimiento del motor, hallazgo real
          // MIS-20260802-0002): evidencia insuficiente o el LLM no pudo
          // producir un borrador válido -- nunca se fuerza un Draft
          // inventado. Éxito honesto (agentSuccess, nunca agentFailure):
          // no es un error técnico, es un resultado esperado y rutinario,
          // igual que los demás bloqueos del gate más arriba.
          return agentSuccess({ approvalRequestId: null, blockReason: "DRAFT_GENERATION_INSUFFICIENT_EVIDENCE", draftSkippedReason: draft.reason }, []);
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
          subject: draft.subject,
          body: draft.body,
          draftMetadata: draft.metadata,
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
          payload: { approvalRequestId: approval.id, companyId: company.id, channel: "EMAIL", subjectPreview: draft.subject },
          idempotencyKey: buildIdempotencyKey(context.correlationId, "outreach.draft_created.v1", approval.id),
        });

        return agentSuccess({ approvalRequestId: approval.id, blockReason: null }, [event]);
      } catch (err) {
        return agentFailure(new AgentError(classifyError(err), err instanceof Error ? err.message : String(err), err));
      }
    },
  };
}
