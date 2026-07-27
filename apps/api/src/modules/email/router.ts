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
import { getEmailProviderHealth } from "./health";
import { getPdlMonthlyBudgetStatus } from "../agents/pdl-budget";
import { getProviderHealth } from "../agents/tools/provider-health";

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
 * tenant del contexto actual. Desde la auditoría de "primera misión
 * real" también corre automáticamente cada 30 min vía
 * email/scheduler.ts (ver ese archivo) -- este endpoint sigue existiendo
 * para forzar una corrida inmediata sin esperar al próximo tick.
 *
 * F27 Fase 11: `?dryRun=true` corre exactamente la misma lógica de
 * matching/clasificación contra Graph real, pero sin escribir nada (ni
 * EmailMessage, ni EmailReconciliationAlert, ni AuditLog) -- para poder
 * mostrar antes de aplicar qué se reconciliaría/resolvería, mismo shape
 * de respuesta que una corrida real (ver ReconciliationSummary.details).
 */
emailRouter.post("/emails/reconcile", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    if (!env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_CLIENT_SECRET) {
      throw AppError.badRequest("Microsoft Graph no configurado");
    }
    const dryRun = req.query.dryRun === "true";
    const mailbox = resolveSender("commercial")!.email;
    const summary = await reconcileMailbox(mailbox, { tenantId: env.AZURE_TENANT_ID, clientId: env.AZURE_CLIENT_ID, clientSecret: env.AZURE_CLIENT_SECRET }, { dryRun });
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

/**
 * F27 Fase 9: un solo panel real para lo que hoy vive repartido entre
 * varios módulos silenciosos (circuit breaker en memoria de
 * provider-health.ts, presupuesto de PDL, caché de Hunter, salud de
 * Graph) -- nunca inventa un número, cada campo viene de una lectura
 * real. El estado de DNS es la única pieza que NO se puede verificar en
 * vivo desde este proceso (requiere `dig` externo) -- se expone como un
 * hecho ya verificado y documentado (ver
 * docs/F27_EMAIL_DNS_REMEDIATION.md), con la fecha de la última
 * verificación real, nunca como "resuelto" mientras no se re-confirme.
 */
emailRouter.get("/emails/provider-status", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const ctx = getTenancyContext();
    if (!ctx) throw AppError.unauthorized();

    const [graphHealth, pdlBudget] = await Promise.all([getEmailProviderHealth(), getPdlMonthlyBudgetStatus(ctx.tenantId)]);
    const pdlCircuit = getProviderHealth("people_data_labs");
    const hunterCircuit = getProviderHealth("hunter_domain_search");

    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const hunterDomainsCachedThisMonth = await scopedDb.hunterDomainSearchCache.count({ where: { queriedAt: { gte: startOfMonth } } });

    res.json({
      microsoftGraph: graphHealth,
      peopleDataLabs: {
        configured: !!env.PEOPLEDATALABS_API_KEY,
        circuitStatus: pdlCircuit?.status ?? "AVAILABLE",
        circuitReason: pdlCircuit?.reason ?? null,
        monthlyCreditBudget: pdlBudget.monthlyCreditBudget,
        creditsUsedThisMonth: pdlBudget.creditsUsedThisMonth,
        remainingThisMonth: pdlBudget.remainingThisMonth,
      },
      hunter: {
        configured: !!env.HUNTER_API_KEY,
        circuitStatus: hunterCircuit?.status ?? "AVAILABLE",
        circuitReason: hunterCircuit?.reason ?? null,
        domainsQueriedOrCachedThisMonth: hunterDomainsCachedThisMonth,
      },
      // F27 Fase 8: verificado por `dig` real el 2026-07-25 -- ver
      // docs/F27_EMAIL_DNS_REMEDIATION.md para el detalle exacto y la
      // remediación. `degraded: true` hasta que un admin corrija SPF/DKIM
      // en GoDaddy/M365 y este valor se actualice en el código junto con
      // una nueva verificación real.
      deliverability: {
        degraded: true,
        spfPass: false,
        dkimPass: false,
        dmarcPolicy: "quarantine",
        lastVerifiedAt: "2026-07-25",
        detail: "SPF le falta include:spf.protection.outlook.com; ambos CNAME de DKIM apuntan a un host que no resuelve -- ver docs/F27_EMAIL_DNS_REMEDIATION.md",
      },
    });
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
