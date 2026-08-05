import type {
  ApprovalEmailSendResult,
  ApprovalRequestListItem,
  DecideApprovalInput,
  EditApprovalDraftInput,
  PlaceholderWarning,
  RecipientWarning,
} from "@ai-staffing-os/shared";
import { EDITABLE_APPROVAL_STATUSES, findKnownPlaceholders } from "@ai-staffing-os/shared";
import { OpenAIProvider, type LLMProvider, type LLMCompletionResult } from "@ai-staffing-os/agents";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { labelUsers } from "../../core/user-labels";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";
import { sendEmail } from "../email/email-service";
import { checkSendLimits } from "../email/send-limits";
import { assessRecipientTrust } from "../ceo-intelligence/recipient-trust";
import { evaluateApprovalQualityGate, type ApprovalQualityGateInput } from "../ceo-intelligence/approval-quality-gate";
import { getTaxonomyEntry } from "../ceo-intelligence/taxonomy";
import type { HiringSignalResult } from "../ceo-intelligence/hiring-signals";
import {
  generateOutreachDraft,
  classifyHiringSignalLevel,
  resolveDraftLanguage,
  resolvePositionsToOffer,
  type DraftRecipientType,
} from "../agents/draft-generation";

// Mismo patrón exacto que task-executor.ts/draft.executor.ts/
// mission-executor.ts -- nunca lanza al construirse, solo al llamar
// .complete() de verdad.
class MissingApiKeyProvider implements LLMProvider {
  async complete(): Promise<LLMCompletionResult> {
    throw AppError.internal("OPENAI_API_KEY no está configurada -- no se puede regenerar un borrador real.");
  }
}

function buildLLMProvider(): LLMProvider {
  return env.OPENAI_API_KEY ? new OpenAIProvider(env.OPENAI_API_KEY) : new MissingApiKeyProvider();
}

// F24: un ApprovalRequest "activo" todavía puede terminar en un envío
// real -- SENT/FAILED/REJECTED/EXPIRED ya cerraron su ciclo de vida
// (FAILED es reintentable pero desde el MISMO registro, nunca crea uno
// nuevo). Mismo conjunto que el índice único parcial de la migración
// f24_draft_creation_gate -- si se cambia acá, hay que cambiar el SQL
// también.
export const ACTIVE_APPROVAL_STATUSES = ["PENDING", "READY_TO_SEND", "SENDING"] as const;

/**
 * F24 (Fase 2, protección contra duplicados): ¿ya existe un
 * ApprovalRequest activo para esta Company? Chequeo de aplicación --
 * primera línea de defensa, rápida y con buen mensaje de error. La
 * garantía REAL contra condiciones de carrera es el índice único parcial
 * de la migración (ApprovalRequest_tenantId_companyId_active_unique);
 * este chequeo solo evita gastar un request al LLM cuando ya se sabe de
 * antemano que la creación va a fallar.
 */
export async function hasActiveApprovalForCompany(companyId: string): Promise<boolean> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const existing = await scopedDb.approvalRequest.findFirst({
    where: { companyId, status: { in: [...ACTIVE_APPROVAL_STATUSES] } },
    select: { id: true },
  });
  return !!existing;
}

/**
 * F24 Fase 8: variante para el Quality Gate -- un ApprovalRequest PENDING
 * es "activo" por definición (así lo cuenta hasActiveApprovalForCompany),
 * así que decidir SU PROPIA aprobación nunca puede contarse a sí mismo
 * como el duplicado. `excludeApprovalId` siempre es el id del registro
 * que se está evaluando.
 */
export async function hasOtherActiveApprovalForCompany(companyId: string, excludeApprovalId: string): Promise<boolean> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const existing = await scopedDb.approvalRequest.findFirst({
    where: { companyId, id: { not: excludeApprovalId }, status: { in: [...ACTIVE_APPROVAL_STATUSES] } },
    select: { id: true },
  });
  return !!existing;
}

// F24: código único de error Postgres para "unique_violation" -- se usa
// para reconocer, en los 3 call sites de creación de Draft, cuando la
// carrera fue perdida contra el índice único parcial de arriba (el
// chequeo de aplicación de hasActiveApprovalForCompany no alcanzó a
// verla porque otro request ganó entre el check y el create).
export const UNIQUE_VIOLATION_ERROR_CODE = "P2002";

function extractBody(proposedAction: unknown): string {
  if (!proposedAction || typeof proposedAction !== "object") return "";
  const pa = proposedAction as Record<string, unknown>;
  return typeof pa.body === "string" ? pa.body : "";
}

function computePlaceholderWarning(proposedAction: unknown): PlaceholderWarning {
  const matches = findKnownPlaceholders(extractBody(proposedAction));
  return { hasPlaceholders: matches.length > 0, matches };
}

function toListItem(
  approval: Awaited<ReturnType<typeof scopedDb.approvalRequest.findMany>>[number] & {
    agentTask: { type: string };
  },
  userLabels: Map<string, string>,
  emailSendResult?: ApprovalEmailSendResult | null,
  recipientWarning?: RecipientWarning,
  isInternalTest?: boolean,
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
    recipientWarning: recipientWarning ?? null,
    placeholderWarning: computePlaceholderWarning(approval.proposedAction),
    // F27 (Internal Acceptance Test): nunca confundir con un lead comercial real.
    isInternalTest: isInternalTest ?? false,
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

  // Shape F14/F15 (discovery-conversion.ts): ya trae `to` resuelto. F24
  // Fase 8: un borrador de shape leadId/campaignCompanyId editado vía
  // editApprovalDraft también termina acá (esa función escribe `to`
  // directo en el JSON) -- `pa.companyId` nunca se seteó originalmente
  // en esos 2 shapes, así que se resuelve el mismo companyId por la
  // MISMA vía que ya usan los otros 2 shapes de abajo, nunca se deja en
  // null solo porque este branch ganó primero. Nunca se re-resuelve `to`
  // (ya es literal, la razón de ser de este branch), solo companyId.
  if (typeof pa.to === "string" && pa.to) {
    let resolvedCompanyId = typeof pa.companyId === "string" ? pa.companyId : null;
    if (!resolvedCompanyId && typeof pa.leadId === "string") {
      const lead = await scopedDb.lead.findUnique({ where: { id: pa.leadId }, select: { companyId: true } });
      resolvedCompanyId = lead?.companyId ?? null;
    }
    if (!resolvedCompanyId && typeof pa.campaignCompanyId === "string") {
      const cc = await scopedDb.campaignCompany.findUnique({ where: { id: pa.campaignCompanyId }, select: { companyId: true } });
      resolvedCompanyId = cc?.companyId ?? null;
    }
    return {
      to: pa.to,
      subject,
      bodyText: body,
      leadId: typeof pa.leadId === "string" ? pa.leadId : null,
      opportunityId: typeof pa.opportunityId === "string" ? pa.opportunityId : null,
      companyId: resolvedCompanyId,
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

/**
 * F23: resuelve la advertencia de destinatario sospechoso (Fase 5) para
 * varios ApprovalRequest de una sola pasada -- nunca N+1 hacia Company
 * (un único findMany batch), nunca bloquea nada, solo informa.
 */
async function computeRecipientWarnings(proposedActions: unknown[]): Promise<RecipientWarning[]> {
  const resolved = await Promise.all(proposedActions.map((pa) => resolveDraftEmail(pa)));

  const companyIds = Array.from(new Set(resolved.map((r) => r?.companyId).filter((id): id is string => !!id)));
  const companies = companyIds.length
    ? await scopedDb.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, website: true } })
    : [];
  const websiteByCompanyId = new Map(companies.map((c) => [c.id, c.website]));

  return resolved.map((r) => {
    if (!r) return null;
    const website = r.companyId ? (websiteByCompanyId.get(r.companyId) ?? null) : null;
    return assessRecipientTrust(r.to, website);
  });
}

/**
 * F27 (Internal Acceptance Test, req. explícito: "la interfaz debe
 * mostrar claramente INTERNAL TEST"): batch real sobre
 * ApprovalRequest.companyId (columna directa, nunca parseando
 * proposedAction) -- un solo findMany, nunca N+1.
 */
async function loadIsInternalTest(companyIds: (string | null)[]): Promise<Map<string, boolean>> {
  const ids = Array.from(new Set(companyIds.filter((id): id is string => !!id)));
  if (ids.length === 0) return new Map();
  const companies = await scopedDb.company.findMany({ where: { id: { in: ids } }, select: { id: true, origin: true } });
  return new Map(companies.map((c) => [c.id, c.origin === "INTERNAL_TEST"]));
}

/**
 * F27 Fase 9: reconstruye emailSendResult para un ApprovalRequest ya
 * enviado (SENT/FAILED con intento real) a partir del ESTADO ACTUAL de su
 * EmailMessage real -- nunca lo que decía en el instante del /send. El
 * reconciliador (reconciliation.ts) puede haber movido esa fila a
 * SENT_CONFIRMED/BOUNCED/DELIVERY_UNKNOWN desde entonces; la UI (Approvals.tsx)
 * debe reflejar SIEMPRE la verdad más reciente, no un snapshot viejo.
 */
async function loadEmailSendResults(approvalIds: string[]): Promise<Map<string, ApprovalEmailSendResult>> {
  if (approvalIds.length === 0) return new Map();
  const rows = await scopedDb.emailMessage.findMany({
    where: { approvalRequestId: { in: approvalIds } },
    orderBy: { createdAt: "desc" },
  });
  const byApproval = new Map<string, ApprovalEmailSendResult>();
  for (const row of rows) {
    if (!row.approvalRequestId || byApproval.has(row.approvalRequestId)) continue; // más reciente primero, nunca pisa con uno viejo
    byApproval.set(row.approvalRequestId, {
      status: row.status as never,
      providerMessageId: row.providerMessageId,
      internetMessageId: row.internetMessageId,
      conversationId: row.conversationId,
      correlationId: row.correlationId,
      errorMessage: row.errorMessage,
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      sentItemsConfirmedAt: row.sentItemsConfirmedAt?.toISOString() ?? null,
      ndrDetail: row.ndrDetail,
    });
  }
  return byApproval;
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
  const recipientWarnings = await computeRecipientWarnings(approvals.map((a) => a.proposedAction));
  const emailSendResults = await loadEmailSendResults(approvals.map((a) => a.id));
  const isInternalTestByCompanyId = await loadIsInternalTest(approvals.map((a) => a.companyId));

  return approvals.map((a, idx) => toListItem(a, userLabels, emailSendResults.get(a.id) ?? null, recipientWarnings[idx], a.companyId ? isInternalTestByCompanyId.get(a.companyId) : false));
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

  // F24 Fase 8 (pedido explícito del PO, "Quality Gate antes de Approval"):
  // reemplaza el chequeo de solo-placeholders de F23 por la validación
  // completa (Company/clasificación/contacto/email/placeholders/
  // duplicados/contenido/metadata) -- solo bloquea APPROVED, RECHAZAR
  // sigue permitido siempre sin condiciones. Corregir el contenido
  // requiere pasar por PATCH /approvals/:id/draft (editApprovalDraft);
  // corregir un duplicado requiere rechazar uno de los dos.
  if (input.decision === "APPROVED") {
    const pa = (approval.proposedAction && typeof approval.proposedAction === "object" ? approval.proposedAction : {}) as Record<string, unknown>;
    const draft = await resolveDraftEmail(approval.proposedAction);
    const companyId = draft?.companyId ?? null;
    const company = companyId
      ? await scopedDb.company.findUnique({ where: { id: companyId }, select: { origin: true, commercialStatus: true, discoveryMetadata: true } })
      : null;
    // Bug real encontrado en auditoría: mismo shape de extracción que
    // outreach-tools.impl.ts/sales-tools.impl.ts usan al crear el
    // borrador -- acá se re-evalúa con el estado ACTUAL de la Company,
    // que puede haber cambiado desde entonces.
    const discoveryMeta = (company?.discoveryMetadata as { isClientOwnerCandidate?: boolean; opportunityRecommendation?: { recommendation?: string } } | null) ?? null;

    // F34 (auditoría arquitectónica transversal, 2026-08-05): estado real
    // de bounce del destinatario -- resuelto acá con el dato MÁS FRESCO
    // posible (un hard bounce puede haberse confirmado DESPUÉS de crear
    // el borrador, ver reconciliation.ts). Busca en Contact primero
    // (email personal), CompanyContactPoint como respaldo (email
    // organizacional) -- ninguno de los dos "inventa" un estado, `to`
    // simplemente no tiene historial cuando ninguno matchea.
    const toEmail = draft?.to?.toLowerCase() ?? null;
    const [bouncedContact, bouncedContactPoint] = toEmail
      ? await Promise.all([
          scopedDb.contact.findFirst({
            where: { email: { equals: toEmail, mode: "insensitive" } },
            select: { bouncedAt: true, lastBounceClassification: true, lastBounceAt: true, doNotContact: true, unsubscribedAt: true },
          }),
          scopedDb.companyContactPoint.findFirst({
            where: { email: toEmail },
            select: { permanentlyInvalidAt: true, lastBounceClassification: true, lastBounceAt: true },
          }),
        ])
      : [null, null];

    const gate = evaluateApprovalQualityGate({
      companyOrigin: company?.origin ?? null,
      companyCommercialStatus: company?.commercialStatus ?? null,
      to: draft?.to ?? null,
      subject: typeof pa.subject === "string" ? pa.subject : null,
      body: typeof pa.body === "string" ? pa.body : null,
      hasOtherActiveDuplicateApproval: companyId ? await hasOtherActiveApprovalForCompany(companyId, id) : false,
      isClientOwnerCandidate: !!discoveryMeta?.isClientOwnerCandidate,
      opportunityRecommendation: discoveryMeta?.opportunityRecommendation?.recommendation ?? null,
      permanentlyInvalidAt: bouncedContact?.bouncedAt ?? bouncedContactPoint?.permanentlyInvalidAt ?? null,
      lastBounceClassification: (bouncedContact?.lastBounceClassification ?? bouncedContactPoint?.lastBounceClassification ?? null) as ApprovalQualityGateInput["lastBounceClassification"],
      lastBounceAt: bouncedContact?.lastBounceAt ?? bouncedContactPoint?.lastBounceAt ?? null,
      doNotContact: bouncedContact?.doNotContact ?? false,
      unsubscribedAt: bouncedContact?.unsubscribedAt ?? null,
    });

    if (!gate.passed) {
      throw AppError.badRequest(
        `Este borrador no pasó el control de calidad -- corrígelo antes de aprobar: ${gate.failures.map((f) => f.reason).join(" | ")}`,
      );
    }
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
  const [recipientWarning] = await computeRecipientWarnings([updated.proposedAction]);
  return toListItem(updated, decidedByLabels, null, recipientWarning);
}

/**
 * F23 (pedido explícito del PO): edición segura de un borrador ANTES de
 * aprobarlo/enviarlo -- nunca envía nada, nunca toca Company/Lead/
 * Opportunity, solo reescribe to/subject/body dentro del mismo JSON de
 * proposedAction. `to` explícito hace que resolveDraftEmail tome el
 * shape F14/F15 de acá en adelante (chequea `pa.to` primero) sin
 * importar cuál era el shape original -- funciona para los 3 shapes
 * reales sin ninguna migración.
 */
export async function editApprovalDraft(id: string, input: EditApprovalDraftInput): Promise<ApprovalRequestListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.approvalRequest.findUnique({ where: { id }, include: { agentTask: true } });
  if (!existing) throw AppError.notFound("Approval request not found");

  if (!(EDITABLE_APPROVAL_STATUSES as readonly string[]).includes(existing.status)) {
    throw AppError.badRequest(
      `Este borrador no se puede editar desde el estado ${existing.status} -- solo PENDING, READY_TO_SEND o FAILED son editables.`,
    );
  }

  const currentPa =
    existing.proposedAction && typeof existing.proposedAction === "object" ? (existing.proposedAction as Record<string, unknown>) : {};
  const previous = {
    to: typeof currentPa.to === "string" ? currentPa.to : null,
    subject: typeof currentPa.subject === "string" ? currentPa.subject : null,
    body: typeof currentPa.body === "string" ? currentPa.body : null,
  };
  const next = { to: input.to, subject: input.subject, body: input.body };
  const changedFields = (Object.keys(next) as Array<keyof typeof next>).filter((field) => previous[field] !== next[field]);

  // Se preserva TODO lo demás del shape original (leadId/campaignCompanyId/
  // channel/recipientKind/contactChannelSource/companyId/...) -- solo se
  // sobreescriben los 3 campos editables.
  const updatedProposedAction = { ...currentPa, ...next };

  const wasReadyToSend = existing.status === "READY_TO_SEND";
  const nextStatus = wasReadyToSend ? "PENDING" : existing.status;

  const updated = await scopedDb.approvalRequest.update({
    where: { id },
    data: { proposedAction: updatedProposedAction, status: nextStatus },
    include: { agentTask: true },
  });

  if (changedFields.length > 0) {
    await scopedDb.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorType: "HUMAN",
        actorId: ctx.userId,
        action: "approval.draft_edited",
        entityType: "approvalRequest",
        entityId: id,
        // Nunca se guardan secretos acá -- to/subject/body de un borrador
        // de outreach comercial, ningún dato sensible/credencial.
        before: Object.fromEntries(changedFields.map((f) => [f, previous[f]])) as never,
        after: {
          ...Object.fromEntries(changedFields.map((f) => [f, next[f]])),
          changedFields,
          revertedToPending: wasReadyToSend,
        } as never,
      },
    });
  }

  const labels = await labelUsers([ctx.userId]);
  const [recipientWarning] = await computeRecipientWarnings([updated.proposedAction]);
  return toListItem(updated, labels, null, recipientWarning);
}

export interface RegenerateApprovalDraftDeps {
  // Inyección para tests -- nunca se llama a OpenAI real en un test
  // unitario. Default: mismo patrón buildLLMProvider() que task-executor.ts/
  // draft.executor.ts/mission-executor.ts.
  llmProvider?: LLMProvider;
}

/**
 * "Regenerate Draft": re-redacta subject/body de un ApprovalRequest EXISTENTE
 * (ej. un borrador viejo en español, generado antes de este rediseño de
 * idioma/personalización) con la evidencia REAL y actual de la Company --
 * nunca envía nada, nunca cambia el destinatario (`to` se preserva tal
 * cual). Mismas reglas de edición que editApprovalDraft: solo PENDING/
 * READY_TO_SEND/FAILED son regenerables, y un READY_TO_SEND regenerado
 * vuelve a PENDING (exige nueva aprobación humana sobre el contenido nuevo).
 */
export async function regenerateApprovalDraft(id: string, deps: RegenerateApprovalDraftDeps = {}): Promise<ApprovalRequestListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.approvalRequest.findUnique({ where: { id }, include: { agentTask: true } });
  if (!existing) throw AppError.notFound("Approval request not found");
  if (!(EDITABLE_APPROVAL_STATUSES as readonly string[]).includes(existing.status)) {
    throw AppError.badRequest(
      `Este borrador no se puede regenerar desde el estado ${existing.status} -- solo PENDING, READY_TO_SEND o FAILED son editables.`,
    );
  }
  if (!existing.companyId) {
    throw AppError.badRequest("Este borrador no tiene una Company asociada -- no se puede regenerar con evidencia real.");
  }

  const company = await scopedDb.company.findUnique({
    where: { id: existing.companyId },
    include: { industry: true, contacts: true, possibleCategories: true },
  });
  if (!company) throw AppError.notFound("Company not found");

  const currentPa = existing.proposedAction && typeof existing.proposedAction === "object" ? (existing.proposedAction as Record<string, unknown>) : {};
  const to = typeof currentPa.to === "string" ? currentPa.to : null;
  if (!to) throw AppError.badRequest("Este borrador no tiene un destinatario (`to`) real -- no se puede regenerar.");

  const hiringSignal = (company.discoveryMetadata as { hiringSignal?: HiringSignalResult | null } | null)?.hiringSignal ?? null;
  const taxonomyEntry = company.tradeKey ? getTaxonomyEntry(company.tradeKey) : undefined;
  // Nunca se recalcula A QUIÉN se le escribe -- el `to` ya elegido se
  // preserva tal cual; solo se busca el Contact real que corresponde a
  // ESE email (si existe) para saber si el saludo debe ser personal.
  const matchedPersonContact = company.contacts.find((c) => c.email === to);
  const recipientType: DraftRecipientType = matchedPersonContact ? "person" : "organizational";

  const draft = await generateOutreachDraft({
    llmProvider: deps.llmProvider ?? buildLLMProvider(),
    input: {
      companyName: company.name,
      city: company.city,
      state: company.state,
      industryName: company.industry.name,
      tradeLabel: taxonomyEntry?.label ?? null,
      services: company.possibleCategories.map((c) => c.name),
      hiringSignalLevel: classifyHiringSignalLevel(hiringSignal?.hiringStatus ?? null),
      hiringSignalEvidence: hiringSignal?.evidence ?? [],
      hiringSignalSourceUrls: hiringSignal?.sourceUrls ?? [],
      positionsToOffer: resolvePositionsToOffer(hiringSignal?.targetTitlesMatched ?? [], taxonomyEntry?.jobTitles ?? []),
      recipientType,
      recipientName: matchedPersonContact?.firstName ?? null,
      recipientTitle: matchedPersonContact?.title ?? null,
      companyWebsite: company.website,
      language: resolveDraftLanguage({ hiringSignalEvidence: hiringSignal?.evidence ?? [] }),
      stepLabel: null,
      openOpportunities: [],
      recentActivitySubjects: [],
    },
  });

  if (draft.status === "skipped") {
    // Acción manual y sincrónica disparada por un humano -- a diferencia
    // de una misión de fondo (donde esto nunca debe abortar nada, ver
    // draft-generation.ts/discovery-conversion.ts), acá SÍ corresponde
    // devolver un error claro de inmediato: el usuario pidió regenerar
    // ESTE borrador ahora, y no hay evidencia suficiente para hacerlo sin
    // inventar contenido -- nunca se fuerza un Draft inventado.
    throw AppError.badRequest(`No se pudo regenerar el borrador: ${draft.reason}`);
  }

  const previous = { subject: typeof currentPa.subject === "string" ? currentPa.subject : null, body: typeof currentPa.body === "string" ? currentPa.body : null };
  const updatedProposedAction = { ...currentPa, subject: draft.subject, body: draft.body, draftMetadata: draft.metadata };
  const wasReadyToSend = existing.status === "READY_TO_SEND";
  const nextStatus: typeof existing.status = wasReadyToSend ? "PENDING" : existing.status;

  const updated = await scopedDb.approvalRequest.update({
    where: { id },
    data: { proposedAction: updatedProposedAction as never, status: nextStatus },
    include: { agentTask: true },
  });

  await scopedDb.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorType: "HUMAN",
      actorId: ctx.userId,
      action: "approval.draft_regenerated",
      entityType: "approvalRequest",
      entityId: id,
      before: previous as never,
      after: { subject: draft.subject, body: draft.body, draftMetadata: draft.metadata, revertedToPending: wasReadyToSend } as never,
    },
  });

  const labels = await labelUsers([ctx.userId]);
  const [recipientWarning] = await computeRecipientWarnings([updated.proposedAction]);
  return toListItem(updated, labels, null, recipientWarning);
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
    // Bug real encontrado en auditoría: a diferencia del bloqueo de
    // límites justo abajo, este FAILED nunca dejaba rastro en el
    // AuditLog -- un operador real vería un envío fallido sin ninguna
    // explicación forense de por qué.
    await scopedDb.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorType: "HUMAN",
        actorId: ctx.userId,
        action: "approval.send_failed_no_recipient",
        entityType: "approvalRequest",
        entityId: id,
        after: { reason: "No se pudo resolver un destinatario de email real para este borrador -- revisar el canal de contacto." } as never,
      },
    });
    throw AppError.badRequest("No se pudo resolver un destinatario de email real para este borrador -- revisar el canal de contacto.");
  }

  // F26 (primer piloto de outreach real): límite diario + prevención de
  // duplicados -- ANTES de gastar la llamada real a Microsoft Graph,
  // nunca después. Mismo criterio que la guarda de `!draft` de arriba:
  // vuelve a FAILED (reintentable, nunca queda trabada en SENDING) y
  // audita el bloqueo real.
  const limitCheck = await checkSendLimits(draft.to);
  if (!limitCheck.allowed) {
    await scopedDb.approvalRequest.update({ where: { id }, data: { status: "FAILED" } });
    await scopedDb.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorType: "HUMAN",
        actorId: ctx.userId,
        action: "approval.send_blocked_by_limit",
        entityType: "approvalRequest",
        entityId: id,
        after: { reason: limitCheck.reason } as never,
      },
    });
    throw AppError.badRequest(limitCheck.reason ?? "Envío bloqueado por límites de seguridad.");
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
    // F27: ApprovalRequest.status="SENT" sigue significando lo mismo de
    // siempre ("la acción humana de envío se completó del lado del
    // proveedor") -- lo que cambia es que ya NUNCA se confunde con
    // "entregado confirmado". Ese detalle fino vive en EmailMessage
    // (ACCEPTED_BY_PROVIDER -> SENT_CONFIRMED/BOUNCED/DELIVERY_UNKNOWN,
    // ver reconciliation.ts), reflejado acá en emailSendResult.status
    // para que la UI muestre el estado real, no uno optimista.
    emailSendResult = {
      status: sent.status === "ACCEPTED_BY_PROVIDER" ? "ACCEPTED_BY_PROVIDER" : sent.status,
      providerMessageId: sent.providerMessageId,
      internetMessageId: sent.internetMessageId,
      conversationId: sent.conversationId,
      correlationId: sent.correlationId,
      errorMessage: sent.errorMessage,
    };
    finalStatus = sent.status === "ACCEPTED_BY_PROVIDER" ? "SENT" : "FAILED";
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
