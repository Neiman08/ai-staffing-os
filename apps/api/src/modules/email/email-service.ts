import { randomUUID } from "node:crypto";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";
import { logAuditEvent } from "../../core/audit-log";
import { sendGraphMail, type SendGraphMailResult } from "./microsoft-graph";
import { resolveSender, resolveReplyTo, type EmailSenderProfile } from "./sender-profiles";

/**
 * F17/F27: orquestación real de envío de email -- el ÚNICO punto del
 * backend que (a) resuelve el remitente real vía sender-profiles.ts,
 * (b) llama al proveedor real (Microsoft Graph), y (c) registra una fila
 * de EmailMessage + un AuditLog con el resultado REAL, nunca optimista.
 * La fila se crea en PENDING antes de intentar el envío (para que quede
 * evidencia aunque el proceso se caiga a mitad de camino).
 *
 * F27 (endurecimiento de trazabilidad -- hallazgo real: 5 correos reales
 * aparecieron en Sent Items sin ningún EmailMessage/ApprovalRequest/
 * AuditLog, porque llegaron a Graph sin pasar por esta función): un
 * HTTP 202 de Graph al `/send` significa ÚNICAMENTE que la solicitud fue
 * aceptada para procesar -- NUNCA que el mensaje se entregó, ni que ya
 * existe en Sent Items. Esta función nunca vuelve a escribir
 * `status: "SENT"` -- el éxito de Graph ahora se registra como
 * `ACCEPTED_BY_PROVIDER`, un estado explícitamente "aceptado, pendiente
 * de confirmación real". El paso de `ACCEPTED_BY_PROVIDER` a
 * `SENT_CONFIRMED` (o `BOUNCED`/`DELIVERY_UNKNOWN`) es responsabilidad
 * exclusiva del reconciliador (reconciliation.ts), que busca evidencia
 * real en Graph (Sent Items, NDRs) -- nunca de esta función, que solo ve
 * la respuesta HTTP inmediata del /send.
 */

export interface MicrosoftGraphProviderPort {
  sendGraphMail: typeof sendGraphMail;
}
const REAL_GRAPH_PROVIDER: MicrosoftGraphProviderPort = { sendGraphMail };

export interface SendEmailParams {
  senderProfile: EmailSenderProfile;
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  // Vínculos reales opcionales -- ver EmailMessage.
  approvalRequestId?: string | null;
  leadId?: string | null;
  opportunityId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  taskId?: string;
  abortSignal?: AbortSignal;
  // Inyección para tests -- nunca se llama a Microsoft Graph real en un
  // test unitario. Default: el módulo real.
  graphProvider?: MicrosoftGraphProviderPort;
  azureTenantId?: string;
  azureClientId?: string;
  azureClientSecret?: string;
}

export interface SendEmailResult {
  emailMessageId: string;
  correlationId: string;
  // F27: "SENT" ya no lo escribe esta función (queda como valor legado
  // del enum, ver schema.prisma) -- ACCEPTED_BY_PROVIDER es el único
  // estado de éxito posible acá.
  status: "ACCEPTED_BY_PROVIDER" | "FAILED" | "RETRYABLE";
  providerMessageId: string | null;
  conversationId: string | null;
  internetMessageId: string | null;
  errorMessage: string | null;
}

function isValidEmailAddress(value: string): boolean {
  // Chequeo deliberadamente simple (mismo criterio que email-trust.ts) --
  // nunca una regex RFC 5322 completa, solo descarta strings obviamente
  // rotos antes de gastar una llamada real a Graph.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Envía un email real vía Microsoft Graph y registra el resultado real
 * en EmailMessage + AuditLog. Nunca lanza por un fallo del proveedor --
 * el fallo real queda en el `status`/`errorMessage` devuelto (y
 * persistido), para que el llamador (ej. approvals/service.ts) pueda
 * seguir su propio flujo sin que un email fallido tumbe una decisión de
 * aprobación ya tomada por un humano. Sí lanza AppError si faltan datos
 * imposibles de recuperar (sin tenancy context, destinatario inválido) --
 * esos son errores de programación/uso, no fallos reales del proveedor.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  if (!isValidEmailAddress(params.to)) {
    throw AppError.badRequest(`sendEmail: destinatario inválido ("${params.to}")`);
  }

  const sender = resolveSender(params.senderProfile);
  const replyTo = resolveReplyTo(params.senderProfile);
  const correlationId = randomUUID();
  const actorType = ctx.actor?.type === "AGENT" ? "AGENT" : "HUMAN";
  const actorId = ctx.actor?.type === "AGENT" ? ctx.actor.agentInstanceId : ctx.userId;

  // F17 (pedido explícito: "nunca se hace fallback silencioso a otro
  // remitente"): si el perfil pedido no tiene remitente resuelto (ej.
  // GENERAL sin MAIL_FROM configurado), esto SIEMPRE falla acá -- nunca
  // sigue adelante con otro remitente, y nunca intenta la llamada real a
  // Graph con datos incompletos.
  const emailMessage = await scopedDb.emailMessage.create({
    data: {
      tenantId: ctx.tenantId,
      correlationId,
      approvalRequestId: params.approvalRequestId ?? null,
      leadId: params.leadId ?? null,
      opportunityId: params.opportunityId ?? null,
      companyId: params.companyId ?? null,
      contactId: params.contactId ?? null,
      senderProfile: params.senderProfile === "commercial" ? "COMMERCIAL" : "GENERAL",
      fromEmail: sender?.email ?? "(sin resolver)",
      fromName: sender?.name ?? "(sin resolver)",
      toEmail: params.to,
      ccEmails: params.cc ?? [],
      bccEmails: params.bcc ?? [],
      replyTo,
      subject: params.subject,
      bodyHtml: params.bodyHtml ?? null,
      bodyText: params.bodyText ?? null,
      provider: "microsoft_graph",
      status: "PENDING",
      actorType,
      actorId,
    },
  });

  // F27 (Fase 3, "antes de llamar a Graph, siempre... cree AuditLog"):
  // se registra la SOLICITUD antes de intentar nada -- si el proceso se
  // cae entre acá y la respuesta de Graph, ya queda evidencia real de
  // que alguien pidió este envío, con qué datos, y cuándo.
  await logAuditEvent({
    action: "email.send_requested",
    entityType: "emailMessage",
    entityId: emailMessage.id,
    after: { correlationId, to: params.to, subject: params.subject, senderProfile: params.senderProfile, approvalRequestId: params.approvalRequestId ?? null },
  });

  if (!sender) {
    const errorMessage = `Perfil de remitente "${params.senderProfile}" sin configurar (MAIL_FROM ausente o inválido) -- nunca se usa otro remitente en su lugar.`;
    await scopedDb.emailMessage.update({ where: { id: emailMessage.id }, data: { status: "FAILED", errorMessage, normalizedError: "SENDER_PROFILE_NOT_CONFIGURED" } });
    await logAuditEvent({ action: "email.send_failed", entityType: "emailMessage", entityId: emailMessage.id, after: { correlationId, reason: errorMessage } });
    return { emailMessageId: emailMessage.id, correlationId, status: "FAILED", providerMessageId: null, conversationId: null, internetMessageId: null, errorMessage };
  }

  const azureTenantId = params.azureTenantId ?? env.AZURE_TENANT_ID;
  const azureClientId = params.azureClientId ?? env.AZURE_CLIENT_ID;
  const azureClientSecret = params.azureClientSecret ?? env.AZURE_CLIENT_SECRET;
  if (!azureTenantId || !azureClientId || !azureClientSecret) {
    const errorMessage = "Microsoft Graph no configurado (falta AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET).";
    await scopedDb.emailMessage.update({ where: { id: emailMessage.id }, data: { status: "FAILED", errorMessage, normalizedError: "GRAPH_NOT_CONFIGURED" } });
    await logAuditEvent({ action: "email.send_failed", entityType: "emailMessage", entityId: emailMessage.id, after: { correlationId, reason: errorMessage } });
    return { emailMessageId: emailMessage.id, correlationId, status: "FAILED", providerMessageId: null, conversationId: null, internetMessageId: null, errorMessage };
  }

  const provider = params.graphProvider ?? REAL_GRAPH_PROVIDER;
  const result: SendGraphMailResult = await provider.sendGraphMail(
    {
      taskId: params.taskId,
      mailbox: sender.email,
      from: sender,
      to: [{ email: params.to }],
      cc: (params.cc ?? []).map((email) => ({ email })),
      bcc: (params.bcc ?? []).map((email) => ({ email })),
      replyTo: replyTo ? [{ email: replyTo }] : undefined,
      subject: params.subject,
      bodyHtml: params.bodyHtml,
      bodyText: params.bodyText,
      auth: { emailMessageId: emailMessage.id, tenantId: ctx.tenantId, correlationId, actorType, actorId },
      abortSignal: params.abortSignal,
    },
    { tenantId: azureTenantId, clientId: azureClientId, clientSecret: azureClientSecret },
  );

  if (result.kind === "sent") {
    await scopedDb.emailMessage.update({
      where: { id: emailMessage.id },
      data: {
        status: "ACCEPTED_BY_PROVIDER",
        providerMessageId: result.providerMessageId,
        conversationId: result.conversationId,
        internetMessageId: result.internetMessageId,
        httpStatusCode: result.httpStatus,
        graphClientRequestId: result.clientRequestId,
        acceptedAt: new Date(),
        // `sentAt` se mantiene por compatibilidad -- código existente
        // (send-limits.ts, reportes) ya lo usa como "cuándo se despachó
        // este envío". Significa lo mismo que siempre significó (momento
        // del intento aceptado por el proveedor), nunca "confirmado
        // entregado" -- esa confirmación real vive en
        // sentItemsConfirmedAt, escrita únicamente por el reconciliador.
        sentAt: new Date(),
      },
    });
    await logAuditEvent({
      action: "email.accepted_by_provider",
      entityType: "emailMessage",
      entityId: emailMessage.id,
      after: { correlationId, providerMessageId: result.providerMessageId, conversationId: result.conversationId, internetMessageId: result.internetMessageId, httpStatus: result.httpStatus },
    });
    return {
      emailMessageId: emailMessage.id,
      correlationId,
      status: "ACCEPTED_BY_PROVIDER",
      providerMessageId: result.providerMessageId,
      conversationId: result.conversationId,
      internetMessageId: result.internetMessageId,
      errorMessage: null,
    };
  }

  const status = result.retryable ? "RETRYABLE" : "FAILED";
  await scopedDb.emailMessage.update({
    where: { id: emailMessage.id },
    data: { status, errorMessage: result.reason, normalizedError: result.reason.split(":")[0]?.trim().slice(0, 100) ?? null, httpStatusCode: result.httpStatus ?? null },
  });
  await logAuditEvent({ action: "email.send_failed", entityType: "emailMessage", entityId: emailMessage.id, after: { correlationId, reason: result.reason, retryable: result.retryable } });
  return { emailMessageId: emailMessage.id, correlationId, status, providerMessageId: null, conversationId: null, internetMessageId: null, errorMessage: result.reason };
}
