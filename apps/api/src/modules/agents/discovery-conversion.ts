import type { LLMProvider, MissionRestrictions } from "@ai-staffing-os/agents";
import { buildEventEnvelope, buildIdempotencyKey } from "@ai-staffing-os/agents";
import { Prisma } from "@ai-staffing-os/db";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import { publishEventSafe } from "../../core/events/outbox";
import * as leadsService from "../leads/service";
import * as opportunitiesService from "../opportunities/service";
import { decideCompanyConversion, evaluateDraftEligibility, type ConversionEvidence, type ConversionDecision, type DraftEligibility } from "../ceo-intelligence/conversion-policy";
import { evaluateDraftCreationGate, type DraftCreationBlockReason } from "../ceo-intelligence/draft-creation-gate";
import { hasActiveApprovalForCompany } from "../approvals/service";
import {
  generateOutreachDraft,
  classifyHiringSignalLevel,
  resolveDraftLanguage,
  type HiringSignalLevel,
  type DraftRecipientType,
} from "./draft-generation";
import type { UsageAccumulator } from "./usage";

/**
 * F14: convierte UNA Company ya descubierta (con evidencia ya reunida
 * por business-validation/hiring-signals/company-enrichment/contact-
 * enrichment, todo eso sin modificar) en las acciones comerciales que
 * la política determinista (conversion-policy.ts) autorice -- Lead,
 * Opportunity, y opcionalmente un borrador de outreach (ApprovalRequest
 * PENDING, nunca enviado). Reutiliza `leadsService.createLead`/
 * `opportunitiesService.createOpportunity` (mismas funciones que usa el
 * pipeline clásico F1-F4) en vez de escribir Prisma a mano -- mismos
 * campos, misma Activity de creación, un solo lugar que sabe crear un
 * Lead/Opportunity real.
 *
 * Gating de restricciones: Lead nunca está gateado por
 * MissionRestrictions (mismo criterio que el pipeline clásico -- ningún
 * flag de "allowLeadCreation" existe en este sistema). Opportunity
 * requiere allowOpportunityCreation. El borrador requiere
 * allowDraftCreation (F28: antes allowOutreach Y allowMessageSending --
 * "no enviar correos automáticamente" apagaba ambos y terminaba sin
 * ningún Draft pese a que la instrucción pedía Drafts explícitamente),
 * ADEMÁS de la elegibilidad real de canal (evaluateDraftEligibility) --
 * nunca se redacta nada si la instrucción lo prohibió explícitamente,
 * sin importar cuán buena sea la evidencia. El envío real sigue siendo
 * un paso completamente aparte (click humano en Approvals), nunca
 * gateado acá.
 */
export interface ConvertDiscoveredCompanyParams {
  taskId: string;
  company: {
    id: string;
    name: string;
    industryId: string;
    industryName: string;
    city: string | null;
    state: string | null;
    website: string | null;
    /** BusinessTaxonomyEntry.label real de candidate.query.taxonomyKey -- null cuando no hubo trade específico. */
    tradeLabel: string | null;
    // F24 (auditoría de producción): el Draft (no el Lead/Opportunity,
    // que igual sirven para revisión humana) se bloquea cuando la
    // Company fue marcada como posible cliente final -- ver
    // draft-creation-gate.ts.
    isClientOwnerCandidate: boolean;
    opportunityRecommendation: string | null;
  };
  restrictions: MissionRestrictions;
  evidence: ConversionEvidence;
  /** Mejor email organizacional VERIFIED disponible (nunca RISKY/INVALID) -- ver company-enrichment.ts. */
  bestVerifiedOrgEmail: string | null;
  /** Mejor contacto de persona real (PDL) con ranking HIGH/MEDIUM_CONFIDENCE y email real -- nunca inventado. */
  bestRealContact: { contactId: string; firstName: string; lastName: string; email: string | null; title: string | null } | null;
  /** Evidencia real ya reunida por Hiring Signal Intelligence (F7.5) -- nunca recalculada acá. */
  hiringSignal: { evidence: string[]; sourceUrls: string[] };
  /** Títulos reales a ofrecer (matched real de la señal, o de la taxonomía del trade) -- nunca la lista completa de un catálogo. */
  positionsToOffer: string[];
  /** Inyección para tests -- default: proveedor real (OpenAI), construido por el llamador (mission-executor.ts). */
  llmProvider: LLMProvider;
  usage?: UsageAccumulator;
}

export interface ConvertDiscoveredCompanyResult {
  decision: ConversionDecision;
  leadId: string | null;
  opportunityId: string | null;
  opportunityBlockedByRestriction: boolean;
  draftEligibility: DraftEligibility | null;
  draftCreated: boolean;
  draftBlockedByRestriction: boolean;
  /** F24: DEMO_SEED/DUPLICATE_ACTIVE/CLIENT_OWNER_REVIEW -- null si el gate nunca bloqueó nada (no aplica cuando draftBlockedByRestriction ya es true). */
  draftBlockedByGate: DraftCreationBlockReason | null;
  /** Motivo real cuando generateOutreachDraft no pudo producir un borrador válido (evidencia insuficiente/respuesta del LLM inválida dos veces) -- null si nunca se intentó o si sí se generó. Nunca se fuerza un Draft inventado ni se aborta la conversión por esto. */
  draftSkippedReason: string | null;
  approvalRequestId: string | null;
}

// F15 (pedido explícito del PO): "si existe email organizacional
// verificado, genera igualmente la Opportunity y el Draft
// correspondiente indicando que el destinatario será organizacional" --
// nunca se disfraza un email de departamento (info@/hr@/careers@) como
// si fuera una persona real identificada.
export type DraftRecipientKind = "person" | "organizational";

export async function convertDiscoveredCompany(params: ConvertDiscoveredCompanyParams): Promise<ConvertDiscoveredCompanyResult> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const decision = decideCompanyConversion(params.evidence);

  let leadId: string | null = null;
  let opportunityId: string | null = null;
  let opportunityBlockedByRestriction = false;
  let draftEligibility: DraftEligibility | null = null;
  let draftCreated = false;
  let draftBlockedByRestriction = false;
  let draftBlockedByGate: DraftCreationBlockReason | null = null;
  let draftSkippedReason: string | null = null;
  let approvalRequestId: string | null = null;

  if (decision.createLead) {
    const lead = await leadsService.createLead({
      companyId: params.company.id,
      industryId: params.company.industryId,
      source: "external_discovery",
      priority: "MEDIUM",
      status: "NEW",
      aiScoreReason: `[F14:${decision.rule}] ${decision.reason}`,
    });
    leadId = lead.id;
    await scopedDb.lead.update({ where: { id: lead.id }, data: { createdByAgentTaskId: params.taskId } });
    await logAuditEvent({
      action: "lead.created_by_agent",
      entityType: "lead",
      entityId: lead.id,
      after: { companyId: params.company.id, rule: decision.rule, source: "external_discovery" },
    });
  }

  if (decision.createLead && decision.createOpportunity) {
    if (!params.restrictions.allowOpportunityCreation) {
      opportunityBlockedByRestriction = true;
    } else {
      const opportunity = await opportunitiesService.createOpportunity({
        companyId: params.company.id,
        title: `${params.company.name} — descubrimiento externo`,
        stage: "MEETING_SCHEDULED",
        probability: decision.opportunityReviewRequired ? 5 : 15,
      });
      opportunityId = opportunity.id;
      await scopedDb.opportunity.update({
        where: { id: opportunity.id },
        data: { createdByAgentTaskId: params.taskId, reviewRequired: decision.opportunityReviewRequired, conversionRule: decision.rule },
      });
      if (leadId) await scopedDb.lead.update({ where: { id: leadId }, data: { status: "CONVERTED" } });
      await logAuditEvent({
        action: "opportunity.created_by_agent",
        entityType: "opportunity",
        entityId: opportunity.id,
        after: { companyId: params.company.id, rule: decision.rule, reviewRequired: decision.opportunityReviewRequired },
      });

      draftEligibility = evaluateDraftEligibility({
        opportunityCreated: true,
        hasVerifiedOrgEmail: !!params.bestVerifiedOrgEmail,
        hasRealPersonContactWithEmail: !!params.bestRealContact?.email,
      });

      if (draftEligibility.eligible) {
        if (!params.restrictions.allowDraftCreation) {
          draftBlockedByRestriction = true;
        } else {
          const to = params.bestRealContact?.email ?? params.bestVerifiedOrgEmail!;

          // F24 (auditoría de producción, endurecimiento del pipeline):
          // mismo chokepoint que outreach-tools.impl.ts/sales-tools.impl.ts
          // -- el email ya está garantizado acá (evaluateDraftEligibility
          // arriba), así que el gate solo puede bloquear por duplicado
          // activo o client-owner-candidate/MANUAL_REVIEW (DEMO_SEED ya
          // quedó cubierto transitivamente: createLead/createOpportunity,
          // arriba, ya lo hubieran rechazado).
          const gate = evaluateDraftCreationGate({
            companyOrigin: "API_PROVIDER", // ya pasó por createLead/createOpportunity -- DEMO_SEED nunca llega hasta acá
            isClientOwnerCandidate: params.company.isClientOwnerCandidate,
            opportunityRecommendation: params.company.opportunityRecommendation,
            channel: { isEmailCapable: true, channel: "WEBSITE_ORG_EMAIL", reason: "ya resuelto por evaluateDraftEligibility" },
            hasActiveDuplicateApproval: await hasActiveApprovalForCompany(params.company.id),
          });

          if (!gate.allowed) {
            draftBlockedByGate = gate.blockReason;
            if (gate.companyBlockReasonToPersist) {
              await scopedDb.company.update({
                where: { id: params.company.id },
                data: { outreachBlockedReason: gate.companyBlockReasonToPersist, outreachBlockedAt: new Date() },
              });
            }
            await logAuditEvent({
              action: "outreach.draft_blocked_by_gate",
              entityType: "company",
              entityId: params.company.id,
              after: { blockReason: gate.blockReason, reason: gate.reason },
            });
          } else {
            // F15: organizacional cuando no hay Contact real con email --
            // aunque bestRealContact exista sin email, el canal real usado
            // es igual el organizacional (`to` ya cayó al org email arriba).
            const recipientKind: DraftRecipientKind = params.bestRealContact?.email ? "person" : "organizational";
            const recipientType: DraftRecipientType = recipientKind;
            const hiringSignalLevel: HiringSignalLevel = classifyHiringSignalLevel(params.evidence.hiringStatus);
            const draft = await generateOutreachDraft({
              llmProvider: params.llmProvider,
              usage: params.usage,
              input: {
                companyName: params.company.name,
                city: params.company.city,
                state: params.company.state,
                industryName: params.company.industryName,
                tradeLabel: params.company.tradeLabel,
                services: [],
                hiringSignalLevel,
                hiringSignalEvidence: params.hiringSignal.evidence,
                hiringSignalSourceUrls: params.hiringSignal.sourceUrls,
                positionsToOffer: params.positionsToOffer,
                recipientType,
                recipientName: recipientType === "person" ? (params.bestRealContact?.firstName ?? null) : null,
                recipientTitle: recipientType === "person" ? (params.bestRealContact?.title ?? null) : null,
                companyWebsite: params.company.website,
                language: resolveDraftLanguage({ hiringSignalEvidence: params.hiringSignal.evidence }),
                stepLabel: null,
                openOpportunities: [],
                recentActivitySubjects: [],
              },
            });

            if (draft.status === "skipped") {
              // Invariante #6 (endurecimiento del motor, hallazgo real
              // MIS-20260802-0002): evidencia insuficiente o el LLM no
              // pudo producir un borrador válido -- nunca se fuerza un
              // Draft inventado, nunca se aborta la misión por esto. El
              // Lead/Opportunity ya creados arriba se conservan tal cual;
              // solo el Draft queda sin crear, con el motivo real auditado.
              draftSkippedReason = draft.reason;
              await logAuditEvent({
                action: "outreach.draft_skipped_insufficient_evidence",
                entityType: "company",
                entityId: params.company.id,
                after: { reason: draft.reason, attemptsMade: draft.attemptsMade },
              });
            } else {
              try {
                const approval = await scopedDb.approvalRequest.create({
                  data: {
                    tenantId: ctx.tenantId,
                    agentTaskId: params.taskId,
                    companyId: params.company.id,
                    summary: `Borrador de email para ${params.company.name}`,
                    proposedAction: {
                      channel: "EMAIL",
                      companyId: params.company.id,
                      leadId,
                      opportunityId,
                      contactId: params.bestRealContact?.contactId ?? null,
                      recipientKind,
                      to,
                      subject: draft.subject,
                      body: draft.body,
                      draftMetadata: draft.metadata,
                    },
                    riskLevel: "MEDIUM",
                  },
                });
                draftCreated = true;
                approvalRequestId = approval.id;
                await logAuditEvent({
                  action: "outreach.drafted_by_agent",
                  entityType: "approvalRequest",
                  entityId: approval.id,
                  after: { companyId: params.company.id, opportunityId, to },
                });
                // F25.2 (consolidación del outbox): mismo criterio que
                // mission-executor.ts/sales-tools.impl.ts. Nunca lanza.
                await publishEventSafe(
                  buildEventEnvelope({
                    eventType: "outreach.draft_created.v1",
                    tenantId: ctx.tenantId,
                    correlationId: params.taskId,
                    causationId: null,
                    actorType: "AGENT",
                    actorId: ctx.actor?.agentInstanceId ?? "system",
                    entityType: "approval_request",
                    entityId: approval.id,
                    payload: { approvalRequestId: approval.id, companyId: params.company.id, channel: "EMAIL", subjectPreview: draft.subject },
                    idempotencyKey: buildIdempotencyKey(params.taskId, "outreach.draft_created.v1", approval.id),
                  }),
                );
              } catch (err) {
                // F24 (Fase 2): perdió la carrera contra el índice único parcial.
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                  draftBlockedByGate = "DUPLICATE_ACTIVE";
                  await logAuditEvent({
                    action: "outreach.draft_blocked_by_gate",
                    entityType: "company",
                    entityId: params.company.id,
                    after: { blockReason: "DUPLICATE_ACTIVE", reason: "Condición de carrera detectada por el índice único de la base de datos." },
                  });
                } else {
                  throw err;
                }
              }
            }
          }
        }
      }
    }
  }

  await logActivity({
    entityType: "company",
    entityId: params.company.id,
    type: "SYSTEM",
    subject: `F14 conversión: ${decision.rule}${leadId ? " · Lead creado" : ""}${opportunityId ? " · Opportunity creada" : ""}${draftCreated ? " · Borrador generado" : ""}`,
  });

  return {
    decision,
    leadId,
    opportunityId,
    opportunityBlockedByRestriction,
    draftEligibility,
    draftCreated,
    draftBlockedByRestriction,
    draftBlockedByGate,
    draftSkippedReason,
    approvalRequestId,
  };
}
