import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";
import { sendGraphMail, type SendGraphMailResult } from "./microsoft-graph";
import { resolveSender, resolveReplyTo, type EmailSenderProfile } from "./sender-profiles";

/**
 * F17: orquestación real de envío de email -- el ÚNICO punto del
 * backend que (a) resuelve el remitente real vía sender-profiles.ts,
 * (b) llama al proveedor real (Microsoft Graph), y (c) registra una fila
 * de EmailMessage con el resultado REAL, nunca optimista. La fila se
 * crea en PENDING antes de intentar el envío (para que quede evidencia
 * aunque el proceso se caiga a mitad de camino) y se actualiza a SENT
 * solo tras la confirmación real de Graph -- nunca antes.
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
  status: "SENT" | "FAILED" | "RETRYABLE";
  providerMessageId: string | null;
  conversationId: string | null;
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
 * en EmailMessage. Nunca lanza por un fallo del proveedor -- el fallo
 * real queda en el `status`/`errorMessage` devuelto (y persistido), para
 * que el llamador (ej. approvals/service.ts) pueda seguir su propio
 * flujo sin que un email fallido tumbe una decisión de aprobación ya
 * tomada por un humano. Sí lanza AppError si faltan datos imposibles de
 * recuperar (sin tenancy context, destinatario inválido) -- esos son
 * errores de programación/uso, no fallos reales del proveedor.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  if (!isValidEmailAddress(params.to)) {
    throw AppError.badRequest(`sendEmail: destinatario inválido ("${params.to}")`);
  }

  const sender = resolveSender(params.senderProfile);
  const replyTo = resolveReplyTo(params.senderProfile);

  // F17 (pedido explícito: "nunca se hace fallback silencioso a otro
  // remitente"): si el perfil pedido no tiene remitente resuelto (ej.
  // GENERAL sin MAIL_FROM configurado), esto SIEMPRE falla acá -- nunca
  // sigue adelante con otro remitente, y nunca intenta la llamada real a
  // Graph con datos incompletos.
  const emailMessage = await scopedDb.emailMessage.create({
    data: {
      tenantId: ctx.tenantId,
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
    },
  });

  if (!sender) {
    const errorMessage = `Perfil de remitente "${params.senderProfile}" sin configurar (MAIL_FROM ausente o inválido) -- nunca se usa otro remitente en su lugar.`;
    await scopedDb.emailMessage.update({ where: { id: emailMessage.id }, data: { status: "FAILED", errorMessage } });
    return { emailMessageId: emailMessage.id, status: "FAILED", providerMessageId: null, conversationId: null, errorMessage };
  }

  const azureTenantId = params.azureTenantId ?? env.AZURE_TENANT_ID;
  const azureClientId = params.azureClientId ?? env.AZURE_CLIENT_ID;
  const azureClientSecret = params.azureClientSecret ?? env.AZURE_CLIENT_SECRET;
  if (!azureTenantId || !azureClientId || !azureClientSecret) {
    const errorMessage = "Microsoft Graph no configurado (falta AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET).";
    await scopedDb.emailMessage.update({ where: { id: emailMessage.id }, data: { status: "FAILED", errorMessage } });
    return { emailMessageId: emailMessage.id, status: "FAILED", providerMessageId: null, conversationId: null, errorMessage };
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
      abortSignal: params.abortSignal,
    },
    { tenantId: azureTenantId, clientId: azureClientId, clientSecret: azureClientSecret },
  );

  if (result.kind === "sent") {
    await scopedDb.emailMessage.update({
      where: { id: emailMessage.id },
      data: {
        status: "SENT",
        providerMessageId: result.providerMessageId,
        conversationId: result.conversationId,
        sentAt: new Date(),
      },
    });
    return {
      emailMessageId: emailMessage.id,
      status: "SENT",
      providerMessageId: result.providerMessageId,
      conversationId: result.conversationId,
      errorMessage: null,
    };
  }

  const status = result.retryable ? "RETRYABLE" : "FAILED";
  await scopedDb.emailMessage.update({ where: { id: emailMessage.id }, data: { status, errorMessage: result.reason } });
  return { emailMessageId: emailMessage.id, status, providerMessageId: null, conversationId: null, errorMessage: result.reason };
}
