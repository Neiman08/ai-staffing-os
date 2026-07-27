import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";

/**
 * F26 (primer piloto de outreach real): dos guardas reales, ambas
 * enforced en `sendApproval` ANTES de llamar a Microsoft Graph -- nunca
 * después, nunca "avisamos pero igual mandamos". Se apoyan exclusivamente
 * en `EmailMessage` (F17, ya existente, ya el registro real de todo
 * envío) -- ninguna tabla/columna nueva.
 *
 * 1. Límite diario configurable (`DAILY_EMAIL_SEND_LIMIT`, default 25):
 *    cuenta EmailMessage realmente despachados (`sentAt` desde la
 *    medianoche UTC de hoy), por tenant.
 * 2. Prevención de duplicados: nunca se envía dos veces al mismo
 *    destinatario (case-insensitive) -- un segundo intento a la misma
 *    dirección, sin importar de qué ApprovalRequest venga, se bloquea.
 *    Deliberadamente estricto para un primer piloto -- ninguna ventana de
 *    "permitir de nuevo después de N días" todavía, eso es una decisión
 *    de negocio que un humano puede relajar más adelante si hace falta.
 *
 * F27: cuenta cualquier estado que signifique "esto realmente salió
 * hacia el proveedor" -- ACCEPTED_BY_PROVIDER/SENT_CONFIRMED/DELIVERED,
 * más el legado SENT de filas anteriores a F27. BOUNCED/FAILED/
 * DELIVERY_UNKNOWN nunca cuentan acá -- un rebote o un fallo real no es
 * "ya le escribimos", y DELIVERY_UNKNOWN es agnóstico (no se sabe si de
 * verdad llegó, pero el intento de Graph sí fue real -- se incluye
 * igual, porque lo que importa para este guardia es "ya se le mandó un
 * request real a Graph", no si se pudo confirmar después).
 */

export const DISPATCHED_EMAIL_STATUSES = ["SENT", "ACCEPTED_BY_PROVIDER", "SENT_CONFIRMED", "DELIVERED", "DELIVERY_UNKNOWN"] as const;
const DISPATCHED_STATUSES = DISPATCHED_EMAIL_STATUSES;

export interface SendLimitCheckResult {
  allowed: boolean;
  reason: string | null;
}

export async function checkSendLimits(toEmail: string): Promise<SendLimitCheckResult> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const startOfTodayUtc = new Date();
  startOfTodayUtc.setUTCHours(0, 0, 0, 0);

  const [sentToday, priorSendToSameRecipient] = await Promise.all([
    scopedDb.emailMessage.count({
      where: { tenantId: ctx.tenantId, status: { in: [...DISPATCHED_STATUSES] }, sentAt: { gte: startOfTodayUtc } },
    }),
    scopedDb.emailMessage.findFirst({
      where: { tenantId: ctx.tenantId, status: { in: [...DISPATCHED_STATUSES] }, toEmail: { equals: toEmail, mode: "insensitive" } },
      orderBy: { sentAt: "desc" },
    }),
  ]);

  if (sentToday >= env.DAILY_EMAIL_SEND_LIMIT) {
    return {
      allowed: false,
      reason: `Límite diario de envíos alcanzado (${sentToday}/${env.DAILY_EMAIL_SEND_LIMIT} -- configurable vía DAILY_EMAIL_SEND_LIMIT). Reintentar mañana o subir el límite explícitamente.`,
    };
  }
  if (priorSendToSameRecipient) {
    return {
      allowed: false,
      reason: `Ya se envió un email real a "${toEmail}" anteriormente (EmailMessage ${priorSendToSameRecipient.id}, ${priorSendToSameRecipient.sentAt?.toISOString() ?? "fecha desconocida"}) -- nunca se envía dos veces al mismo destinatario.`,
    };
  }
  return { allowed: true, reason: null };
}
