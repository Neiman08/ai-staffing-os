import type { ApprovalEmailSendResult, ApprovalRequestListItem, DecideApprovalInput } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { labelUsers } from "../../core/user-labels";
import { AppError } from "../../core/errors";
import { sendEmail } from "../email/email-service";

function toListItem(
  approval: Awaited<ReturnType<typeof scopedDb.approvalRequest.findMany>>[number] & {
    agentTask: { type: string };
  },
  decidedByLabels: Map<string, string>,
  emailSendResult?: ApprovalEmailSendResult,
): ApprovalRequestListItem {
  return {
    id: approval.id,
    agentTaskId: approval.agentTaskId,
    agentTaskType: approval.agentTask.type,
    summary: approval.summary,
    proposedAction: approval.proposedAction,
    riskLevel: approval.riskLevel,
    status: approval.status,
    decidedByLabel: approval.decidedById ? (decidedByLabels.get(approval.decidedById) ?? "Unknown user") : null,
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    decisionNote: approval.decisionNote,
    createdAt: approval.createdAt.toISOString(),
    emailSendResult,
  };
}

/**
 * F17: los 3 shapes reales de proposedAction que este repo produce hoy
 * (ver auditoría) -- ninguno tiene un contrato unificado, así que esto
 * resuelve destinatario/asunto/cuerpo/vínculos según cuál de los 3
 * campos característicos esté presente. `null` = no es un borrador de
 * email real (canal distinto de EMAIL, o datos insuficientes para
 * resolver un destinatario real) -- NUNCA se inventa un destinatario.
 */
interface ResolvedDraftEmail {
  to: string;
  subject: string;
  bodyText: string;
  leadId: string | null;
  opportunityId: string | null;
  companyId: string | null;
  contactId: string | null;
}

async function resolveDraftEmail(proposedAction: unknown): Promise<ResolvedDraftEmail | null> {
  if (!proposedAction || typeof proposedAction !== "object") return null;
  const pa = proposedAction as Record<string, unknown>;

  // channel ausente (personalizeMessage/discovery-conversion siempre lo
  // setean a "EMAIL") se trata como EMAIL por compatibilidad -- channel
  // explícitamente distinto de EMAIL (ej. "LINKEDIN") nunca intenta enviar.
  if (pa.channel !== undefined && pa.channel !== "EMAIL") return null;

  const subject = typeof pa.subject === "string" ? pa.subject : null;
  const body = typeof pa.body === "string" ? pa.body : null;
  if (!subject || !body) return null;

  // Shape F14/F15 (discovery-conversion.ts): ya trae `to` resuelto.
  if (typeof pa.to === "string" && pa.to) {
    return {
      to: pa.to,
      subject,
      bodyText: body,
      leadId: typeof pa.leadId === "string" ? pa.leadId : null,
      opportunityId: typeof pa.opportunityId === "string" ? pa.opportunityId : null,
      companyId: typeof pa.companyId === "string" ? pa.companyId : null,
      contactId: typeof pa.contactId === "string" ? pa.contactId : null,
    };
  }

  // Shape sales-tools draftOutreach: leadId (+ contactId opcional), sin `to`.
  if (typeof pa.leadId === "string") {
    const lead = await scopedDb.lead.findUnique({ where: { id: pa.leadId }, include: { company: true } });
    if (!lead) return null;
    let to: string | null = null;
    if (typeof pa.contactId === "string") {
      const contact = await scopedDb.contact.findUnique({ where: { id: pa.contactId } });
      to = contact?.email ?? null;
    }
    to = to ?? lead.company?.email ?? null;
    if (!to) return null;
    return {
      to,
      subject,
      bodyText: body,
      leadId: lead.id,
      opportunityId: null,
      companyId: lead.companyId ?? null,
      contactId: typeof pa.contactId === "string" ? pa.contactId : null,
    };
  }

  // Shape outreach-tools personalizeMessage (loop clásico de Campaign): campaignCompanyId, sin `to`.
  if (typeof pa.campaignCompanyId === "string") {
    const cc = await scopedDb.campaignCompany.findUnique({
      where: { id: pa.campaignCompanyId },
      include: { company: { include: { contacts: true } } },
    });
    if (!cc) return null;
    const contact =
      cc.company.contacts.find((c) => c.isPrimary) ?? cc.company.contacts.find((c) => c.decisionRole) ?? cc.company.contacts[0];
    const to = contact?.email ?? cc.company.email ?? null;
    if (!to) return null;
    return {
      to,
      subject,
      bodyText: body,
      leadId: null,
      opportunityId: null,
      companyId: cc.companyId,
      contactId: contact?.id ?? null,
    };
  }

  return null;
}

export async function listApprovals(status?: string): Promise<ApprovalRequestListItem[]> {
  const approvals = await scopedDb.approvalRequest.findMany({
    where: { status: status as never },
    include: { agentTask: true },
    orderBy: { createdAt: "desc" },
  });

  const decidedByLabels = await labelUsers(approvals.filter((a) => a.decidedById).map((a) => a.decidedById!));

  return approvals.map((a) => toListItem(a, decidedByLabels));
}

export interface DecideApprovalDeps {
  // Inyección para tests -- nunca se llama a Microsoft Graph real en un
  // test unitario/integración. Default: el módulo real (email-service.ts).
  graphProvider?: Parameters<typeof sendEmail>[0]["graphProvider"];
  // Mismo criterio que peopleDataLabsApiKey/hunterApiKey en contact-
  // enrichment.ts -- "" fuerza el camino "no configurado" en un test sin
  // depender de env.AZURE_* real; un valor fake fuerza el camino
  // "configurado" para probar el proveedor mockeado de punta a punta.
  azureTenantId?: string;
  azureClientId?: string;
  azureClientSecret?: string;
}

export async function decideApproval(id: string, input: DecideApprovalInput, deps: DecideApprovalDeps = {}): Promise<ApprovalRequestListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const approval = await scopedDb.approvalRequest.findUnique({ where: { id }, include: { agentTask: true } });
  if (!approval) throw AppError.notFound("Approval request not found");
  if (approval.status !== "PENDING") {
    throw AppError.badRequest(`This approval request was already decided (${approval.status})`);
  }

  const updated = await scopedDb.approvalRequest.update({
    where: { id },
    data: {
      status: input.decision,
      decidedById: ctx.userId,
      decidedAt: new Date(),
      decisionNote: input.note,
    },
    include: { agentTask: true },
  });

  // The task itself ran successfully and produced a draft — its lifecycle
  // ends here regardless of the human's decision. What happened to the
  // *content* is tracked on ApprovalRequest.status, not by leaving the
  // task stuck in AWAITING_APPROVAL forever.
  if (updated.agentTask.status === "AWAITING_APPROVAL") {
    await scopedDb.agentTask.update({ where: { id: updated.agentTaskId }, data: { status: "DONE" } });
  }

  await scopedDb.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorType: "HUMAN",
      actorId: ctx.userId,
      action: "approval.decided",
      entityType: "approvalRequest",
      entityId: id,
      after: { decision: input.decision, note: input.note } as never,
    },
  });

  // F17: el envío real -- SOLO en APPROVED, nunca en REJECTED. Todo
  // outreach comercial (Approval Requests/campañas/secuencias/
  // seguimiento de Leads y Opportunities) sale exclusivamente desde el
  // perfil COMMERCIAL (sales@<dominio>, ver sender-profiles.ts) -- nunca
  // otro remitente, sin importar qué shape tenga proposedAction. Un
  // fallo real del proveedor NUNCA revierte la decisión ya tomada por el
  // humano (eso ya se persistió arriba) -- queda registrado como
  // FAILED/RETRYABLE en EmailMessage, con evidencia, y se refleja en la
  // respuesta para que la UI lo muestre de inmediato.
  let emailSendResult: ApprovalEmailSendResult = null;
  if (input.decision === "APPROVED") {
    const draft = await resolveDraftEmail(updated.proposedAction);
    if (draft) {
      try {
        const sent = await sendEmail({
          senderProfile: "commercial",
          to: draft.to,
          subject: draft.subject,
          bodyText: draft.bodyText,
          approvalRequestId: id,
          leadId: draft.leadId,
          opportunityId: draft.opportunityId,
          companyId: draft.companyId,
          contactId: draft.contactId,
          taskId: updated.agentTaskId,
          graphProvider: deps.graphProvider,
          azureTenantId: deps.azureTenantId,
          azureClientId: deps.azureClientId,
          azureClientSecret: deps.azureClientSecret,
        });
        emailSendResult = { status: sent.status, providerMessageId: sent.providerMessageId, errorMessage: sent.errorMessage };
      } catch (err) {
        // Error de programación/uso real (ej. `to` con formato inválido
        // en datos viejos) -- se registra igual como fallo real, nunca
        // tumba la respuesta de la aprobación ya decidida.
        emailSendResult = { status: "FAILED", providerMessageId: null, errorMessage: err instanceof Error ? err.message : "unknown error" };
      }
    }
  }

  const decidedByLabels = await labelUsers([ctx.userId]);
  return toListItem(updated, decidedByLabels, emailSendResult);
}
