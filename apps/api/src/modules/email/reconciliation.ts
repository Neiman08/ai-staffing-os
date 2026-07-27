import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { logAuditEvent } from "../../core/audit-log";
import { listSentItemsSince as realListSentItemsSince, listPossibleNdrsSince as realListPossibleNdrsSince, type GraphSentItem, type GraphPossibleNdr } from "./microsoft-graph";

/**
 * F27 Fase 4: el reconciliador es la única forma real de que un
 * EmailMessage pase de ACCEPTED_BY_PROVIDER (lo que dijo el /send,
 * inmediato y optimista) a algo respaldado por evidencia real leída de
 * Microsoft Graph -- SENT_CONFIRMED (apareció en Sent Items real),
 * BOUNCED (un NDR real llegó) o DELIVERY_UNKNOWN (venció la ventana sin
 * poder confirmar nada). email-service.ts nunca escribe ninguno de esos
 * 3 estados -- ver comentario en ese archivo.
 *
 * Además detecta el caso real que motivó esta fase completa: un mensaje
 * real en Sent Items sin NINGÚN EmailMessage correspondiente (llegó a
 * Graph sin pasar por sendEmail()) -- se registra como
 * EmailReconciliationAlert, nunca se inventa un ApprovalRequest
 * retroactivo, nunca se modifica/borra el mensaje real de Outlook.
 *
 * Idempotente por diseño: correr esto dos veces sobre la misma ventana
 * nunca duplica nada -- los updates de EmailMessage son por id real
 * (no-op si ya está en el estado final), y EmailReconciliationAlert se
 * crea solo si un findFirst previo no encontró ya una fila para
 * (tenantId, mailbox, graphMessageId) -- respaldado por el índice único
 * real de la tabla como garantía de fondo contra una carrera entre dos
 * corridas concurrentes.
 */

// Ventana de espera antes de que un ACCEPTED_BY_PROVIDER que nunca se
// pudo confirmar (ni en Sent Items ni por NDR) se marque DELIVERY_UNKNOWN
// en vez de quedar indefinidamente "pendiente de confirmación real".
const DELIVERY_UNKNOWN_TIMEOUT_MS = 48 * 60 * 60 * 1000; // 48h
// Margen de tolerancia al comparar EmailMessage.sentAt (cuándo ACEPTAMOS
// el envío) contra GraphSentItem.sentDateTime (cuándo Graph dice que se
// envió) en el fallback por destinatario+asunto -- nunca exacto al
// milisegundo entre dos relojes distintos.
const RECIPIENT_SUBJECT_FALLBACK_WINDOW_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

// Inyección para tests -- nunca se llama a Microsoft Graph real en un
// test unitario/integración (mismo criterio que MicrosoftGraphProviderPort
// en email-service.ts). Default: los módulos reales de microsoft-graph.ts.
export interface ReconciliationGraphDeps {
  listSentItemsSince: typeof realListSentItemsSince;
  listPossibleNdrsSince: typeof realListPossibleNdrsSince;
}
const REAL_GRAPH_DEPS: ReconciliationGraphDeps = { listSentItemsSince: realListSentItemsSince, listPossibleNdrsSince: realListPossibleNdrsSince };

export interface ReconciliationSummary {
  mailbox: string;
  windowSinceIso: string;
  dryRun: boolean;
  sentItemsScanned: number;
  ndrCandidatesScanned: number;
  confirmedThisRun: number;
  alreadyConfirmed: number;
  bounced: number;
  untrackedAlertsCreated: number;
  untrackedAlertsAlreadyOpen: number;
  markedDeliveryUnknown: number;
  // F27 Fase 11 (migración retroactiva de mensajes legados SENT): subset
  // de confirmedThisRun -- cuántos de los confirmados este run venían del
  // estado legado SENT (pre-F27) en vez de ACCEPTED_BY_PROVIDER.
  legacySentReconciled: number;
  // Alertas OPEN que resultaron ser falsos positivos -- Graph sí tenía
  // el mensaje, y ahora un EmailMessage real (incluido uno legado SENT)
  // lo explica.
  alertsResolved: number;
  errors: string[];
  // F27 Fase 11: detalle identificable para el modo diagnóstico/dry-run
  // (nunca solo conteos) -- también se llena en una corrida real, mismo
  // shape en los dos modos.
  details: {
    reconciled: Array<{ emailMessageId: string; providerMessageId: string | null; subject: string; toEmail: string; fromStatus: string }>;
    alertsResolved: Array<{ alertId: string; graphMessageId: string; subject: string | null }>;
    alertsStillOpen: Array<{ alertId: string; graphMessageId: string; subject: string | null }>;
  };
}

function matchesRecipientAndSubjectWindow(
  candidate: { toEmail: string; subject: string; sentAt: Date | null },
  item: GraphSentItem,
): boolean {
  if (!item.sentDateTime) return false;
  const itemTime = new Date(item.sentDateTime).getTime();
  if (!candidate.sentAt || Number.isNaN(itemTime)) return false;
  const withinWindow = Math.abs(itemTime - candidate.sentAt.getTime()) <= RECIPIENT_SUBJECT_FALLBACK_WINDOW_MS;
  if (!withinWindow) return false;
  const sameSubject = (item.subject ?? "").trim() === candidate.subject.trim();
  const sameRecipient = item.toRecipients.some((r) => r.toLowerCase() === candidate.toEmail.toLowerCase());
  return sameSubject && sameRecipient;
}

/**
 * Reconcilia UN buzón contra el tenant del contexto actual. `sinceIso`
 * por defecto cubre los últimos 7 días -- suficiente para cualquier
 * envío real reciente sin pedirle a Graph una ventana ilimitada en cada
 * corrida.
 */
export async function reconcileMailbox(
  mailbox: string,
  creds: GraphCredentials,
  options?: { sinceIso?: string; graphDeps?: ReconciliationGraphDeps; dryRun?: boolean },
): Promise<ReconciliationSummary> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const sinceIso = options?.sinceIso ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  const graphDeps = options?.graphDeps ?? REAL_GRAPH_DEPS;
  const dryRun = options?.dryRun ?? false;
  const errors: string[] = [];

  const summary: ReconciliationSummary = {
    mailbox,
    windowSinceIso: sinceIso,
    dryRun,
    sentItemsScanned: 0,
    ndrCandidatesScanned: 0,
    confirmedThisRun: 0,
    alreadyConfirmed: 0,
    bounced: 0,
    untrackedAlertsCreated: 0,
    untrackedAlertsAlreadyOpen: 0,
    markedDeliveryUnknown: 0,
    legacySentReconciled: 0,
    alertsResolved: 0,
    errors,
    details: { reconciled: [], alertsResolved: [], alertsStillOpen: [] },
  };

  // Universo local: todo EmailMessage de este tenant, en este buzón, que
  // todavía puede ganar evidencia real (ACCEPTED_BY_PROVIDER; el legado
  // SENT de antes de F27 -- ver comentario del enum en schema.prisma,
  // preservado tal cual pero ahora SÍ reconciliable retroactivamente
  // contra Graph; o ya SENT_CONFIRMED/BOUNCED/DELIVERY_UNKNOWN pero
  // dentro de la ventana -- para poder reconocerlos como "ya
  // confirmado" en vez de tratarlos como untracked por error).
  const trackedMessages = await scopedDb.emailMessage.findMany({
    where: {
      tenantId: ctx.tenantId,
      fromEmail: mailbox,
      provider: "microsoft_graph",
      sentAt: { gte: new Date(sinceIso) },
      status: { in: ["ACCEPTED_BY_PROVIDER", "SENT", "SENT_CONFIRMED", "BOUNCED", "DELIVERY_UNKNOWN"] },
    },
  });

  const byProviderMessageId = new Map(trackedMessages.filter((m) => m.providerMessageId).map((m) => [m.providerMessageId as string, m]));
  const byInternetMessageId = new Map(trackedMessages.filter((m) => m.internetMessageId).map((m) => [m.internetMessageId as string, m]));
  const matchedMessageIds = new Set<string>();

  // ---------- 1) Sent Items reales -> confirmar / detectar untracked ----------
  const sentItems = await graphDeps.listSentItemsSince(mailbox, sinceIso, creds);
  if ("error" in sentItems) {
    errors.push(`listSentItemsSince: ${sentItems.error}`);
  } else {
    summary.sentItemsScanned = sentItems.length;

    for (const item of sentItems) {
      let match = byProviderMessageId.get(item.id) ?? (item.internetMessageId ? byInternetMessageId.get(item.internetMessageId) : undefined);

      if (!match) {
        match = trackedMessages.find((m) => !matchedMessageIds.has(m.id) && matchesRecipientAndSubjectWindow({ toEmail: m.toEmail, subject: m.subject, sentAt: m.sentAt }, item));
      }

      if (!match) {
        // Ningún EmailMessage de este tenant explica este mensaje real
        // -- alerta real de envío externo no rastreado. findFirst+create
        // (nunca upsert con clave compuesta -- el extension de tenancy
        // solo soporta lookups por campo simple, ver prisma-extension.ts)
        // más el índice único real de la tabla como garantía de fondo
        // contra una carrera entre dos corridas concurrentes.
        const existing = await scopedDb.emailReconciliationAlert.findFirst({ where: { mailbox, graphMessageId: item.id } });
        if (existing) {
          summary.untrackedAlertsAlreadyOpen += 1;
          continue;
        }
        if (dryRun) {
          summary.untrackedAlertsCreated += 1;
          continue;
        }
        try {
          await scopedDb.emailReconciliationAlert.create({
            data: {
              tenantId: ctx.tenantId,
              mailbox,
              graphMessageId: item.id,
              internetMessageId: item.internetMessageId,
              subject: item.subject,
              toRecipients: item.toRecipients,
              sentDateTime: item.sentDateTime ? new Date(item.sentDateTime) : null,
              status: "OPEN",
              evidence: { from: item.from, conversationId: item.conversationId } as never,
            },
          });
          summary.untrackedAlertsCreated += 1;
        } catch (err) {
          // P2002 real (carrera perdida contra el índice único) -- ya
          // quedó registrada por la otra corrida, nunca se trata como error.
          if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
            summary.untrackedAlertsAlreadyOpen += 1;
          } else {
            throw err;
          }
        }
        continue;
      }

      matchedMessageIds.add(match.id);

      // F27 Fase 11: un match real acá SIEMPRE explica el graphMessageId,
      // sin importar en qué status ya estaba el EmailMessage -- si había
      // una alerta OPEN para este mismo graphMessageId (el caso real:
      // mensajes legados SENT que el reconciliador nunca pudo ver antes
      // de incluir "SENT" arriba, y que por eso se habían registrado
      // también como untracked), es un falso positivo y se resuelve acá,
      // una sola vez, sin importar cuál de las ramas de abajo aplique.
      const openAlert = await scopedDb.emailReconciliationAlert.findFirst({ where: { mailbox, graphMessageId: item.id, status: "OPEN" } });
      if (openAlert) {
        if (!dryRun) {
          await scopedDb.emailReconciliationAlert.update({
            where: { id: openAlert.id },
            data: { status: "RESOLVED", resolvedAt: new Date(), resolvedEmailMessageId: match.id },
          });
          await logAuditEvent({
            action: "email.reconciliation_alert_resolved",
            entityType: "emailReconciliationAlert",
            entityId: openAlert.id,
            after: { emailMessageId: match.id, graphMessageId: item.id, reason: "el EmailMessage real (incluido un legado SENT) ya explica este mensaje de Graph" },
          });
        }
        summary.alertsResolved += 1;
        summary.details.alertsResolved.push({ alertId: openAlert.id, graphMessageId: item.id, subject: openAlert.subject });
      }

      if (match.status === "SENT_CONFIRMED") {
        summary.alreadyConfirmed += 1;
        if (!dryRun) await scopedDb.emailMessage.update({ where: { id: match.id }, data: { lastCheckedAt: new Date() } });
        continue;
      }
      if (match.status !== "ACCEPTED_BY_PROVIDER" && match.status !== "SENT") {
        // BOUNCED/DELIVERY_UNKNOWN ya tienen un desenlace real distinto
        // -- verlo también en Sent Items no lo contradice (un mensaje
        // puede rebotar Y quedar en Sent Items), pero esta fase nunca
        // pisa un desenlace ya determinado por evidencia más fuerte.
        continue;
      }

      // F27 Fase 11: SENT es el estado legado (pre-F27, ver comentario
      // del enum) -- nunca tuvo acceptedAt real, así que se completa acá
      // con la evidencia real más cercana disponible (item.sentDateTime,
      // el propio Graph) en vez de "ahora", que sería un timestamp
      // inventado para un evento que ya pasó. providerMessageId se
      // conserva tal cual -- este update nunca lo toca.
      const isLegacySent = match.status === "SENT";
      const resolvedAcceptedAt = match.acceptedAt ?? (item.sentDateTime ? new Date(item.sentDateTime) : new Date());

      if (!dryRun) {
        await scopedDb.emailMessage.update({
          where: { id: match.id },
          data: {
            status: "SENT_CONFIRMED",
            sentItemsConfirmedAt: new Date(),
            lastCheckedAt: new Date(),
            acceptedAt: resolvedAcceptedAt,
            internetMessageId: match.internetMessageId ?? item.internetMessageId,
            conversationId: match.conversationId ?? item.conversationId,
          },
        });
        await logAuditEvent({
          action: "email.sent_confirmed",
          entityType: "emailMessage",
          entityId: match.id,
          after: { graphMessageId: item.id, internetMessageId: item.internetMessageId, sentDateTime: item.sentDateTime, migratedFromLegacySent: isLegacySent },
        });
      }
      summary.confirmedThisRun += 1;
      if (isLegacySent) summary.legacySentReconciled += 1;
      summary.details.reconciled.push({
        emailMessageId: match.id,
        providerMessageId: match.providerMessageId,
        subject: match.subject,
        toEmail: match.toEmail,
        fromStatus: match.status,
      });
    }
  }

  // Alertas OPEN de este buzón que ningún match de este run explicó --
  // se calcula a partir de `details.alertsResolved` (no de una relectura
  // de la DB) para que el reporte sea idéntico en dry-run y en real.
  const resolvedAlertIds = new Set(summary.details.alertsResolved.map((a) => a.alertId));
  const openAlertsNow = await scopedDb.emailReconciliationAlert.findMany({ where: { tenantId: ctx.tenantId, mailbox, status: "OPEN" } });
  summary.details.alertsStillOpen = openAlertsNow
    .filter((a) => !resolvedAlertIds.has(a.id))
    .map((a) => ({ alertId: a.id, graphMessageId: a.graphMessageId, subject: a.subject }));

  // ---------- 2) NDRs reales -> BOUNCED ----------
  const ndrCandidates = await graphDeps.listPossibleNdrsSince(mailbox, sinceIso, creds);
  if ("error" in ndrCandidates) {
    errors.push(`listPossibleNdrsSince: ${ndrCandidates.error}`);
  } else {
    summary.ndrCandidatesScanned = ndrCandidates.length;
    const stillPending = trackedMessages.filter((m) => m.status === "ACCEPTED_BY_PROVIDER" || m.status === "SENT_CONFIRMED");

    for (const ndr of ndrCandidates) {
      const bounced = matchNdrToMessage(ndr, stillPending);
      if (!bounced) continue;
      if (!dryRun) {
        await scopedDb.emailMessage.update({
          where: { id: bounced.id },
          data: { status: "BOUNCED", ndrReceivedAt: ndr.receivedDateTime ? new Date(ndr.receivedDateTime) : new Date(), ndrDetail: (ndr.bodyPreview ?? ndr.subject).slice(0, 1000), lastCheckedAt: new Date() },
        });
        await logAuditEvent({
          action: "email.bounced",
          entityType: "emailMessage",
          entityId: bounced.id,
          after: { ndrSubject: ndr.subject, ndrFrom: ndr.from, ndrReceivedDateTime: ndr.receivedDateTime },
        });
      }
      summary.bounced += 1;
    }
  }

  // ---------- 3) Timeout real -> DELIVERY_UNKNOWN ----------
  const timeoutCutoff = new Date(Date.now() - DELIVERY_UNKNOWN_TIMEOUT_MS);
  const staleAccepted = await scopedDb.emailMessage.findMany({
    where: { tenantId: ctx.tenantId, fromEmail: mailbox, provider: "microsoft_graph", status: "ACCEPTED_BY_PROVIDER", acceptedAt: { lte: timeoutCutoff } },
  });
  for (const stale of staleAccepted) {
    if (!dryRun) {
      await scopedDb.emailMessage.update({ where: { id: stale.id }, data: { status: "DELIVERY_UNKNOWN", lastCheckedAt: new Date() } });
      await logAuditEvent({
        action: "email.delivery_unknown",
        entityType: "emailMessage",
        entityId: stale.id,
        after: { reason: `sin confirmación real ${DELIVERY_UNKNOWN_TIMEOUT_MS / (60 * 60 * 1000)}h después de acceptedAt`, acceptedAt: stale.acceptedAt },
      });
    }
    summary.markedDeliveryUnknown += 1;
  }

  return summary;
}

/**
 * Heurístico deliberadamente conservador: solo relaciona un NDR con un
 * EmailMessage real cuando el asunto del NDR contiene el asunto
 * original (Exchange antepone "Undeliverable: ") Y el cuerpo/preview del
 * NDR menciona la dirección real del destinatario original -- nunca
 * marca BOUNCED por una coincidencia parcial de una sola señal.
 */
function matchNdrToMessage(ndr: GraphPossibleNdr, candidates: Array<{ id: string; toEmail: string; subject: string }>): { id: string } | null {
  const ndrSubject = ndr.subject.toLowerCase();
  const ndrText = `${ndr.subject} ${ndr.bodyPreview ?? ""}`.toLowerCase();
  for (const candidate of candidates) {
    const subjectMatches = candidate.subject.trim().length > 0 && ndrSubject.includes(candidate.subject.trim().toLowerCase());
    const recipientMentioned = ndrText.includes(candidate.toEmail.toLowerCase());
    if (subjectMatches && recipientMentioned) return { id: candidate.id };
  }
  return null;
}
