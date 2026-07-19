import type { MissionRestrictions } from "@ai-staffing-os/agents";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import * as leadsService from "../leads/service";
import * as opportunitiesService from "../opportunities/service";
import { decideCompanyConversion, evaluateDraftEligibility, type ConversionEvidence, type ConversionDecision, type DraftEligibility } from "../ceo-intelligence/conversion-policy";

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
 * allowOutreach Y allowMessageSending, ADEMÁS de la elegibilidad real
 * de canal (evaluateDraftEligibility) -- nunca se redacta ni se envía
 * nada si la instrucción lo prohibió explícitamente, sin importar cuán
 * buena sea la evidencia.
 */
export interface ConvertDiscoveredCompanyParams {
  taskId: string;
  company: { id: string; name: string; industryId: string };
  restrictions: MissionRestrictions;
  evidence: ConversionEvidence;
  /** Mejor email organizacional VERIFIED disponible (nunca RISKY/INVALID) -- ver company-enrichment.ts. */
  bestVerifiedOrgEmail: string | null;
  /** Mejor contacto de persona real (PDL) con ranking HIGH/MEDIUM_CONFIDENCE y email real -- nunca inventado. */
  bestRealContact: { contactId: string; firstName: string; lastName: string; email: string | null } | null;
}

export interface ConvertDiscoveredCompanyResult {
  decision: ConversionDecision;
  leadId: string | null;
  opportunityId: string | null;
  opportunityBlockedByRestriction: boolean;
  draftEligibility: DraftEligibility | null;
  draftCreated: boolean;
  draftBlockedByRestriction: boolean;
  approvalRequestId: string | null;
}

function buildOutreachDraft(companyName: string, contactFirstName: string | null): { subject: string; body: string } {
  // F14: plantilla genérica, sin datos inventados -- nunca asume un
  // dolor/necesidad específica del negocio que no fue confirmada.
  // `contactFirstName` solo se usa si viene de un Contact real (PDL);
  // sin eso, el saludo queda genérico, nunca "Hola [nombre inventado]".
  const greeting = contactFirstName ? `Hola ${contactFirstName},` : "Hola,";
  return {
    subject: `Posible colaboración con ${companyName}`,
    body: `${greeting}\n\nVimos que ${companyName} podría estar buscando personal para sus operaciones. Nos gustaría conversar brevemente para entender sus necesidades actuales de staffing y ver si podemos ayudar.\n\n¿Tendría disponibilidad esta semana para una llamada breve?\n\nSaludos.`,
  };
}

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
        if (!params.restrictions.allowOutreach || !params.restrictions.allowMessageSending) {
          draftBlockedByRestriction = true;
        } else {
          const to = params.bestRealContact?.email ?? params.bestVerifiedOrgEmail!;
          const { subject, body } = buildOutreachDraft(params.company.name, params.bestRealContact?.firstName ?? null);
          const approval = await scopedDb.approvalRequest.create({
            data: {
              tenantId: ctx.tenantId,
              agentTaskId: params.taskId,
              summary: `Borrador de email para ${params.company.name}`,
              proposedAction: {
                channel: "EMAIL",
                companyId: params.company.id,
                leadId,
                opportunityId,
                contactId: params.bestRealContact?.contactId ?? null,
                to,
                subject,
                body,
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
    approvalRequestId,
  };
}
