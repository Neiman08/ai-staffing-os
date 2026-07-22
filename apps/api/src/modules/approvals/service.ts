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
  userLabels: Map<string, string>,
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
    decidedByLabel: approval.decidedById ? (userLabels.get(approval.decidedById) ?? "Unknown user") : null,
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    decisionNote: approval.decisionNote,
    // F21 Fase 4: quién/cuándo ejecutó la acción de ENVÍO real -- distinto
    // de decidedBy/decidedAt (la aprobación humana, nunca el envío).
    sentByLabel: approval.sentById ? (userLabels.get(approval.sentById) ?? "Unknown user") : null,
    sentAt: approval.sentAt?.toISOString() ?? null,
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

  const userIds = new Set<string>();
  for (const a of approvals) {
    if (a.decidedById) userIds.add(a.decidedById);
    if (a.sentById) userIds.add(a.sentById);
  }
  const userLabels = await labelUsers(Array.from(userIds));

  return approvals.map((a) => toListItem(a, userLabels));
}

/**
 * F21 Fase 4 (separación aprobación/envío, pedido explícito del PO):
 * decidir un ApprovalRequest NUNCA envía nada, sin importar la decisión.
 * REJECTED sigue terminando el ciclo de vida ahí mismo (nunca se envía
 * un borrador rechazado). APPROVED transiciona directo a READY_TO_SEND
 * -- "aprobado" y "listo para enviar" son el mismo hecho descrito dos
 * veces (ver comentario en schema.prisma), nunca dos pasos humanos
 * separados -- pero el envío real sigue siendo una acción EXPLÍCITA
 * distinta (sendApproval, más abajo), nunca disparada acá.
 */
export async function decideApproval(id: string, input: DecideApprovalInput): Promise<ApprovalRequestListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const approval = await scopedDb.approvalRequest.findUnique({ where: { id }, include: { agentTask: true } });
  if (!approval) throw AppError.notFound("Approval request not found");
  if (approval.status !== "PENDING") {
    throw AppError.badRequest(`This approval request was already decided (${approval.status})`);
  }

  const resultingStatus = input.decision === "APPROVED" ? "READY_TO_SEND" : "REJECTED";

  const updated = await scopedDb.approvalRequest.update({
    where: { id },
    data: {
      status: resultingStatus,
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
      after: { decision: input.decision, note: input.note, resultingStatus } as never,
    },
  });

  const decidedByLabels = await labelUsers([ctx.userId]);
  return toListItem(updated, decidedByLabels, null);
}

export interface SendApprovalDeps {
  // Inyección para tests -- nunca se llama a Microsoft Graph real en un
  // test unitario/integración. Default: el módulo real (email-service.ts).
  graphProvider?: Parameters<typeof sendEmail>[0]["graphProvider"];
  azureTenantId?: string;
  azureClientId?: string;
  azureClientSecret?: string;
}

/**
 * F21 Fase 4: única función que realmente envía un email -- acción
 * EXPLÍCITA y separada de decideApproval, exige status=READY_TO_SEND o
 * FAILED (reintento real tras un fallo de proveedor). Idempotencia real:
 * la transición a SENDING es un UPDATE condicional en la MISMA
 * operación atómica que la lectura de status (updateMany con el status
 * esperado en el WHERE) -- dos clicks simultáneos del mismo humano (o
 * dos requests concurrentes cualquiera) nunca pueden ambos pasar esa
 * guarda: el segundo encuentra 0 filas afectadas y se rechaza ahí mismo,
 * antes de intentar ningún envío real. Un ApprovalRequest SENT nunca
 * vuelve a pasar esa guarda -- no está en el conjunto de status
 * aceptados.
 */
export async function sendApproval(id: string, deps: SendApprovalDeps = {}): Promise<ApprovalRequestListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.approvalRequest.findUnique({ where: { id }, include: { agentTask: true } });
  if (!existing) throw AppError.notFound("Approval request not found");

  const SENDABLE_STATUSES = ["READY_TO_SEND", "FAILED"] as const;
  if (!(SENDABLE_STATUSES as readonly string[]).includes(existing.status)) {
    throw AppError.badRequest(
      `This approval request cannot be sent from status ${existing.status} -- solo READY_TO_SEND o FAILED (reintento) son enviables.`,
    );
  }

  // Guarda de idempotencia real -- ver comentario de arriba. `count`
  // debe ser exactamente 1 para que ESTE request sea el que gana la
  // carrera; cualquier otro valor (0 = alguien más ya la movió a SENDING/
  // SENT/otro estado entre el findUnique de arriba y acá) aborta sin
  // tocar nada más.
  const claim = await scopedDb.approvalRequest.updateMany({
    where: { id, status: { in: [...SENDABLE_STATUSES] } },
    data: { status: "SENDING" },
  });
  if (claim.count !== 1) {
    throw AppError.badRequest("This approval request is already being sent or was already sent by another request.");
  }

  const draft = await resolveDraftEmail(existing.proposedAction);
  if (!draft) {
    // Vuelve a FAILED (nunca se queda trabada en SENDING) -- caso real:
    // proposedAction sin `to` resoluble (dato viejo/canal no-EMAIL).
    await scopedDb.approvalRequest.update({ where: { id }, data: { status: "FAILED" } });
    throw AppError.badRequest("No se pudo resolver un destinatario de email real para este borrador -- revisar el canal de contacto.");
  }

  let emailSendResult: ApprovalEmailSendResult;
  let finalStatus: "SENT" | "FAILED";
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
      taskId: existing.agentTaskId,
      graphProvider: deps.graphProvider,
      azureTenantId: deps.azureTenantId,
      azureClientId: deps.azureClientId,
      azureClientSecret: deps.azureClientSecret,
    });
    emailSendResult = { status: sent.status, providerMessageId: sent.providerMessageId, errorMessage: sent.errorMessage };
    finalStatus = sent.status === "SENT" ? "SENT" : "FAILED";
  } catch (err) {
    // Error de programación/uso real -- se registra igual como fallo
    // real, nunca deja el ApprovalRequest trabado en SENDING.
    emailSendResult = { status: "FAILED", providerMessageId: null, errorMessage: err instanceof Error ? err.message : "unknown error" };
    finalStatus = "FAILED";
  }

  const updated = await scopedDb.approvalRequest.update({
    where: { id },
    data: {
      status: finalStatus,
      sentById: finalStatus === "SENT" ? ctx.userId : existing.sentById,
      sentAt: finalStatus === "SENT" ? new Date() : existing.sentAt,
    },
    include: { agentTask: true },
  });

  await scopedDb.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorType: "HUMAN",
      actorId: ctx.userId,
      action: "approval.send_attempted",
      entityType: "approvalRequest",
      entityId: id,
      after: { finalStatus, emailSendResult } as never,
    },
  });

  const sentByLabels = await labelUsers([ctx.userId]);
  return toListItem(updated, sentByLabels, emailSendResult);
}
