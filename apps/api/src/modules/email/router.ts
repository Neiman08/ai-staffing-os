import { Router } from "express";
import { sendManualEmailInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import { sendEmail } from "./email-service";

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
