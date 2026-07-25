import { Router } from "express";
import { sendManualEmailInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { env } from "../../core/env";
import { AppError } from "../../core/errors";
import { sendEmail } from "./email-service";
import { investigateDelivery } from "./microsoft-graph";
import { DISPATCHED_EMAIL_STATUSES } from "./send-limits";
import { reconcileMailbox } from "./reconciliation";
import { resolveSender } from "./sender-profiles";
import { getTenancyContext } from "../../core/tenancy/context";

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
 * ============================================================
 * TEMPORAL -- NO ES CÓDIGO DE PRODUCCIÓN PERMANENTE. PENDIENTE DE ELIMINAR.
 * ============================================================
 * Reintroducido de forma puntual y autorizada explícitamente por el
 * usuario para investigar un correo real reportado como "no recibido" --
 * lectura sola sobre un EmailMessage ya persistido, nunca acepta un
 * buzón/messageId de texto libre. Eliminar junto con investigateDelivery
 * en microsoft-graph.ts una vez que Microsoft 365 levante el bloqueo de
 * salida (550 5.7.708), DKIM esté firmando, y una prueba real confirme
 * entrega sin NDR (ver comentario extendido en microsoft-graph.ts).
 */
emailRouter.get("/emails/:id/investigate-delivery", requirePermission("approvals.decide"), async (req, res, next) => {
  try {
    const emailMessage = await scopedDb.emailMessage.findUnique({ where: { id: req.params.id } });
    if (!emailMessage) throw AppError.notFound("EmailMessage no encontrado");
    if (!(DISPATCHED_EMAIL_STATUSES as readonly string[]).includes(emailMessage.status) || !emailMessage.providerMessageId || !emailMessage.sentAt) {
      res.json({ foundInSentItems: false, detail: `EmailMessage status=${emailMessage.status}, sin providerMessageId/sentAt -- nunca se llegó a enviar` });
      return;
    }
    if (!env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_CLIENT_SECRET) {
      throw AppError.badRequest("Microsoft Graph no configurado");
    }
    const result = await investigateDelivery(emailMessage.fromEmail, emailMessage.providerMessageId, emailMessage.sentAt.toISOString(), {
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
 * F27 Fase 4: disparo manual del reconciliador Graph <-> CRM -- mismo
 * permiso sensible que el resto de acciones administrativas
 * (settings.manage). Reconcilia el ÚNICO buzón real que este repo usa
 * para envíos reales (sales@<dominio>, ver sender-profiles.ts) contra el
 * tenant del contexto actual. No hay ejecución periódica automática
 * todavía -- pedido explícito de la Fase 4 (si se agrega más adelante,
 * debe ser configurable, apagada por defecto en tests, y con guarda de
 * liderazgo de proceso).
 */
emailRouter.post("/emails/reconcile", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    if (!env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_CLIENT_SECRET) {
      throw AppError.badRequest("Microsoft Graph no configurado");
    }
    const mailbox = resolveSender("commercial")!.email;
    const summary = await reconcileMailbox(mailbox, { tenantId: env.AZURE_TENANT_ID, clientId: env.AZURE_CLIENT_ID, clientSecret: env.AZURE_CLIENT_SECRET });
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

emailRouter.get("/emails/reconciliation-alerts", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const alerts = await scopedDb.emailReconciliationAlert.findMany({
      where: status ? { status: status as never } : undefined,
      orderBy: { discoveredAt: "desc" },
    });
    res.json(alerts);
  } catch (err) {
    next(err);
  }
});

emailRouter.post("/emails/reconciliation-alerts/:id/acknowledge", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const ctx = getTenancyContext();
    if (!ctx) throw AppError.unauthorized();
    const alert = await scopedDb.emailReconciliationAlert.update({
      where: { id: req.params.id },
      data: { status: "ACKNOWLEDGED", acknowledgedById: ctx.userId, acknowledgedAt: new Date() },
    });
    res.json(alert);
  } catch (err) {
    next(err);
  }
});
