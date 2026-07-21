import { Router } from "express";
import { sendManualEmailInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { env } from "../../core/env";
import { AppError } from "../../core/errors";
import { sendEmail } from "./email-service";
import { verifyMessageInSentItems, findMessagesBySubject, resolveMailboxIdentity } from "./microsoft-graph";

/**
 * F17: "correos manuales enviados desde el CRM" -- el único punto donde
 * un humano puede pedir un envío real fuera del flujo de aprobación de
 * un borrador de IA. SIEMPRE sale del perfil COMMERCIAL (sales@<dominio>,
 * ver sender-profiles.ts) -- este endpoint nunca acepta un remitente de
 * texto libre, mismo criterio que decideApproval. Mismo permiso que
 * decidir una aprobación (approvals.decide) -- mismo nivel de confianza
 * real: ambos terminan en un email real saliendo de la cuenta comercial
 * de la empresa.
 */
export const emailRouter = Router();

emailRouter.post("/emails/send-manual", requirePermission("approvals.decide"), async (req, res, next) => {
  try {
    const input = sendManualEmailInputSchema.parse(req.body);
    const result = await sendEmail({
      senderProfile: "commercial",
      to: input.to,
      subject: input.subject,
      bodyText: input.bodyText,
      leadId: input.leadId ?? null,
      opportunityId: input.opportunityId ?? null,
      companyId: input.companyId ?? null,
      contactId: input.contactId ?? null,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * F17 (evidencia real pedida explícitamente: "verifica ... aparición en
 * Elementos enviados"): lectura sola-lectura sobre un EmailMessage ya
 * persistido -- nunca acepta un buzón/messageId de texto libre, siempre
 * usa exactamente lo que este mismo backend ya registró como remitente y
 * providerMessageId reales tras un envío real. No envía ni crea nada.
 */
emailRouter.get("/emails/:id/verify-sent-items", requirePermission("approvals.decide"), async (req, res, next) => {
  try {
    const emailMessage = await scopedDb.emailMessage.findUnique({ where: { id: req.params.id } });
    if (!emailMessage) throw AppError.notFound("EmailMessage no encontrado");
    if (emailMessage.status !== "SENT" || !emailMessage.providerMessageId) {
      res.json({ found: false, detail: `EmailMessage status=${emailMessage.status}, sin providerMessageId -- nunca se llegó a enviar` });
      return;
    }
    if (!env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_CLIENT_SECRET) {
      throw AppError.badRequest("Microsoft Graph no configurado");
    }
    const result = await verifyMessageInSentItems(emailMessage.fromEmail, emailMessage.providerMessageId, {
      tenantId: env.AZURE_TENANT_ID,
      clientId: env.AZURE_CLIENT_ID,
      clientSecret: env.AZURE_CLIENT_SECRET,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * F17 (diagnóstico puntual, sola lectura, pregunta original del pedido:
 * "determina si sales@ es un alias de hello@ o un buzón independiente"):
 * compara el id real del buzón + el id de su carpeta Sent Items para 2
 * direcciones -- si son idénticos, es matemáticamente el mismo buzón.
 * No envía ni crea nada.
 */
emailRouter.get("/emails/diagnostic/mailbox-identity", requirePermission("approvals.decide"), async (req, res, next) => {
  try {
    if (!env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_CLIENT_SECRET) {
      throw AppError.badRequest("Microsoft Graph no configurado");
    }
    const creds = { tenantId: env.AZURE_TENANT_ID, clientId: env.AZURE_CLIENT_ID, clientSecret: env.AZURE_CLIENT_SECRET };
    const [sales, hello] = await Promise.all([resolveMailboxIdentity("sales@dreistaff.com", creds), resolveMailboxIdentity("hello@dreistaff.com", creds)]);
    res.json({ sales, hello, sameMailbox: !!sales.mailboxId && sales.mailboxId === hello.mailboxId });
  } catch (err) {
    next(err);
  }
});

/**
 * F17 (diagnóstico puntual, sola lectura): busca por subject en vez de
 * por id exacto -- la búsqueda por providerMessageId exacto devolvió 404
 * incluso sin filtrar por carpeta, esto confirma si el mensaje existe en
 * el buzón por otra vía. No envía ni crea nada.
 */
emailRouter.get("/emails/diagnostic/find-by-subject", requirePermission("approvals.decide"), async (req, res, next) => {
  try {
    const subject = typeof req.query.subject === "string" ? req.query.subject : "";
    if (!subject) throw AppError.badRequest("subject query param requerido");
    if (!env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_CLIENT_SECRET) {
      throw AppError.badRequest("Microsoft Graph no configurado");
    }
    const result = await findMessagesBySubject("sales@dreistaff.com", subject, {
      tenantId: env.AZURE_TENANT_ID,
      clientId: env.AZURE_CLIENT_ID,
      clientSecret: env.AZURE_CLIENT_SECRET,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
