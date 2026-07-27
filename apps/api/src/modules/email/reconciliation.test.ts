import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { reconcileMailbox, type ReconciliationGraphDeps } from "./reconciliation";
import type { GraphSentItem, GraphPossibleNdr } from "./microsoft-graph";

/**
 * F27 Fase 4/10: el reconciliador nunca llama a Microsoft Graph real --
 * graphDeps siempre mockeado acá, exactamente como email-service.test.ts
 * mockea sendGraphMail. EmailMessage/EmailReconciliationAlert sí se leen/
 * escriben en la base real, como en el resto de pruebas de integración
 * de este módulo.
 */

const TEST_PREFIX = "F27-RECONCILE-TEST";
const createdTenantIds: string[] = [];
const FAKE_AZURE = { tenantId: "fake-tenant", clientId: "fake-client", clientSecret: "fake-secret" };
const MAILBOX = "sales@dreistaff.com";

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  return tenant.id;
}

after(async () => {
  if (createdTenantIds.length) {
    await prisma.emailReconciliationAlert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.emailMessage.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

function fakeGraphDeps(overrides: Partial<ReconciliationGraphDeps> = {}): ReconciliationGraphDeps {
  return {
    listSentItemsSince: async () => [],
    listPossibleNdrsSince: async () => [],
    ...overrides,
  };
}

async function createAcceptedEmailMessage(tenantId: string, overrides: Partial<Parameters<typeof prisma.emailMessage.create>[0]["data"]> = {}) {
  return prisma.emailMessage.create({
    data: {
      tenantId,
      senderProfile: "COMMERCIAL",
      fromEmail: MAILBOX,
      fromName: "DreiStaff Sales",
      toEmail: "prospect@example.com",
      subject: "Test subject",
      provider: "microsoft_graph",
      status: "ACCEPTED_BY_PROVIDER",
      providerMessageId: "graph-immutable-id-1",
      sentAt: new Date(),
      acceptedAt: new Date(),
      correlationId: `corr-${Date.now()}-${Math.random()}`,
      ...overrides,
    },
  });
}

/**
 * F27 Fase 11: fila real como las que dejó el código pre-F27 -- SENT,
 * sin acceptedAt/internetMessageId nunca capturados (esos campos no
 * existían/no se llenaban en ese momento). approvalRequestId nulo a
 * propósito -- las pruebas de este bloque no necesitan un ApprovalRequest
 * real para ejercitar reconcileMailbox.
 */
async function createLegacySentEmailMessage(tenantId: string, overrides: Partial<Parameters<typeof prisma.emailMessage.create>[0]["data"]> = {}) {
  return prisma.emailMessage.create({
    data: {
      tenantId,
      senderProfile: "COMMERCIAL",
      fromEmail: MAILBOX,
      fromName: "DreiStaff Sales",
      toEmail: "legacy-prospect@example.com",
      subject: "Legacy subject",
      provider: "microsoft_graph",
      status: "SENT",
      providerMessageId: "legacy-graph-id-1",
      internetMessageId: null,
      acceptedAt: null,
      sentItemsConfirmedAt: null,
      sentAt: new Date(),
      correlationId: `corr-legacy-${Date.now()}-${Math.random()}`,
      ...overrides,
    },
  });
}

async function createOpenAlert(tenantId: string, overrides: Partial<Parameters<typeof prisma.emailReconciliationAlert.create>[0]["data"]> = {}) {
  return prisma.emailReconciliationAlert.create({
    data: {
      tenantId,
      mailbox: MAILBOX,
      graphMessageId: "legacy-graph-id-1",
      subject: "Legacy subject",
      toRecipients: ["legacy-prospect@example.com"],
      status: "OPEN",
      ...overrides,
    },
  });
}

test("reconcileMailbox: un mensaje real en Sent Items que coincide por providerMessageId pasa ACCEPTED_BY_PROVIDER -> SENT_CONFIRMED", async () => {
  const tenantId = await setupTenant("confirm-by-provider-id");
  const email = await createAcceptedEmailMessage(tenantId);

  const sentItem: GraphSentItem = {
    id: "graph-immutable-id-1",
    subject: "Test subject",
    sentDateTime: new Date().toISOString(),
    internetMessageId: "<real@dreistaff.com>",
    conversationId: "real-conv",
    toRecipients: ["prospect@example.com"],
    from: MAILBOX,
  };

  const summary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps({ listSentItemsSince: async () => [sentItem] }) }),
  );

  assert.equal(summary.confirmedThisRun, 1);
  assert.equal(summary.untrackedAlertsCreated, 0);

  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, "SENT_CONFIRMED");
  assert.ok(row.sentItemsConfirmedAt);
  assert.equal(row.internetMessageId, "<real@dreistaff.com>");
});

test("reconcileMailbox: fallback por destinatario+asunto+ventana temporal confirma cuando providerMessageId no coincide", async () => {
  const tenantId = await setupTenant("confirm-by-fallback");
  const sentAt = new Date();
  const email = await createAcceptedEmailMessage(tenantId, { providerMessageId: "different-id-never-matches", sentAt, acceptedAt: sentAt, toEmail: "fallback@example.com", subject: "Fallback subject" });

  const sentItem: GraphSentItem = {
    id: "graph-id-from-real-search",
    subject: "Fallback subject",
    sentDateTime: new Date(sentAt.getTime() + 60_000).toISOString(),
    internetMessageId: null,
    conversationId: null,
    toRecipients: ["fallback@example.com"],
    from: MAILBOX,
  };

  const summary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps({ listSentItemsSince: async () => [sentItem] }) }),
  );

  assert.equal(summary.confirmedThisRun, 1);
  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, "SENT_CONFIRMED");
});

test("reconcileMailbox: correr dos veces sobre el mismo Sent Item es idempotente -- la segunda corrida solo cuenta 'ya confirmado', nunca reconfirma ni duplica auditoría", async () => {
  const tenantId = await setupTenant("idempotent-confirm");
  const email = await createAcceptedEmailMessage(tenantId);
  const sentItem: GraphSentItem = {
    id: "graph-immutable-id-1",
    subject: "Test subject",
    sentDateTime: new Date().toISOString(),
    internetMessageId: "<real@dreistaff.com>",
    conversationId: "real-conv",
    toRecipients: ["prospect@example.com"],
    from: MAILBOX,
  };
  const deps = fakeGraphDeps({ listSentItemsSince: async () => [sentItem] });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: deps }));
  const secondSummary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: deps }));

  assert.equal(secondSummary.confirmedThisRun, 0);
  assert.equal(secondSummary.alreadyConfirmed, 1);

  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, "SENT_CONFIRMED");
  const confirmedLogs = await prisma.auditLog.count({ where: { tenantId, entityId: email.id, action: "email.sent_confirmed" } });
  assert.equal(confirmedLogs, 1, "nunca se audita la misma confirmación dos veces");
});

test("reconcileMailbox: un NDR real que menciona el destinatario y el asunto original marca BOUNCED", async () => {
  const tenantId = await setupTenant("bounced");
  const email = await createAcceptedEmailMessage(tenantId, { toEmail: "bounced@nowhere.example", subject: "Oferta para tu empresa" });

  const ndr: GraphPossibleNdr = {
    id: "ndr-1",
    subject: "Undeliverable: Oferta para tu empresa",
    receivedDateTime: new Date().toISOString(),
    from: "postmaster@dreistaff.com",
    bodyPreview: "Your message to bounced@nowhere.example couldn't be delivered.",
  };

  const summary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps({ listPossibleNdrsSince: async () => [ndr] }) }),
  );

  assert.equal(summary.bounced, 1);
  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, "BOUNCED");
  assert.ok(row.ndrReceivedAt);
  assert.match(row.ndrDetail ?? "", /couldn't be delivered/);
});

test("reconcileMailbox: un NDR que solo coincide en una señal (asunto sin destinatario, o viceversa) nunca marca BOUNCED", async () => {
  const tenantId = await setupTenant("ndr-weak-match");
  const email = await createAcceptedEmailMessage(tenantId, { toEmail: "safe@example.com", subject: "Asunto real" });

  const ndrOnlySubject: GraphPossibleNdr = {
    id: "ndr-weak-1",
    subject: "Undeliverable: Asunto real",
    receivedDateTime: new Date().toISOString(),
    from: "postmaster@dreistaff.com",
    bodyPreview: "No mentions the recipient address at all.",
  };

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps({ listPossibleNdrsSince: async () => [ndrOnlySubject] }) }),
  );

  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, "ACCEPTED_BY_PROVIDER", "un heurístico débil (una sola señal) nunca debe marcar BOUNCED");
});

test("reconcileMailbox: un mensaje real en Sent Items sin ningún EmailMessage correspondiente crea una EmailReconciliationAlert (envío externo no rastreado)", async () => {
  const tenantId = await setupTenant("untracked-external-send");
  const sentItem: GraphSentItem = {
    id: "untracked-graph-id",
    subject: "Correo enviado fuera del flujo oficial",
    sentDateTime: new Date().toISOString(),
    internetMessageId: "<untracked@dreistaff.com>",
    conversationId: "untracked-conv",
    toRecipients: ["someone-external@example.com"],
    from: MAILBOX,
  };

  const summary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps({ listSentItemsSince: async () => [sentItem] }) }),
  );

  assert.equal(summary.untrackedAlertsCreated, 1);
  const alert = await prisma.emailReconciliationAlert.findFirstOrThrow({ where: { tenantId, graphMessageId: "untracked-graph-id" } });
  assert.equal(alert.status, "OPEN");
  assert.equal(alert.mailbox, MAILBOX);
  assert.deepEqual(alert.toRecipients, ["someone-external@example.com"]);

  // Ningún EmailMessage/ApprovalRequest inventado retroactivamente.
  assert.equal(await prisma.emailMessage.count({ where: { tenantId } }), 0);
});

test("reconcileMailbox: correr dos veces sobre el mismo mensaje no rastreado no duplica la alerta", async () => {
  const tenantId = await setupTenant("untracked-idempotent");
  const sentItem: GraphSentItem = {
    id: "untracked-graph-id-2",
    subject: "Otro correo fuera del flujo",
    sentDateTime: new Date().toISOString(),
    internetMessageId: "<untracked2@dreistaff.com>",
    conversationId: null,
    toRecipients: ["otro-externo@example.com"],
    from: MAILBOX,
  };
  const deps = fakeGraphDeps({ listSentItemsSince: async () => [sentItem] });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: deps }));
  const second = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: deps }));

  assert.equal(second.untrackedAlertsCreated, 0);
  assert.equal(second.untrackedAlertsAlreadyOpen, 1);
  assert.equal(await prisma.emailReconciliationAlert.count({ where: { tenantId, graphMessageId: "untracked-graph-id-2" } }), 1);
});

test("reconcileMailbox: un EmailMessage ACCEPTED_BY_PROVIDER cuyo acceptedAt ya pasó la ventana de espera, sin evidencia real, se marca DELIVERY_UNKNOWN", async () => {
  const tenantId = await setupTenant("delivery-unknown-timeout");
  const staleDate = new Date(Date.now() - 49 * 60 * 60 * 1000); // 49h atrás, > 48h de ventana
  const email = await createAcceptedEmailMessage(tenantId, { acceptedAt: staleDate, sentAt: staleDate, providerMessageId: "stale-id", toEmail: "stale@example.com" });

  const summary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps() }));

  assert.equal(summary.markedDeliveryUnknown, 1);
  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, "DELIVERY_UNKNOWN");
});

test("reconcileMailbox: un EmailMessage ACCEPTED_BY_PROVIDER reciente (dentro de la ventana) nunca se marca DELIVERY_UNKNOWN todavía", async () => {
  const tenantId = await setupTenant("delivery-unknown-not-yet");
  const email = await createAcceptedEmailMessage(tenantId);

  const summary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps() }));

  assert.equal(summary.markedDeliveryUnknown, 0);
  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, "ACCEPTED_BY_PROVIDER");
});

test("reconcileMailbox: nunca toca un EmailMessage de OTRO tenant, ni para confirmar ni para crear alertas", async () => {
  const tenantA = await setupTenant("isolation-a");
  const tenantB = await setupTenant("isolation-b");
  const emailB = await createAcceptedEmailMessage(tenantB, { toEmail: "tenant-b@example.com", subject: "Tenant B subject" });

  const sentItem: GraphSentItem = {
    id: "graph-immutable-id-1", // mismo id, pero el mensaje real de tenantB no debe ser visible desde tenantA
    subject: "Tenant B subject",
    sentDateTime: new Date().toISOString(),
    internetMessageId: null,
    conversationId: null,
    toRecipients: ["tenant-b@example.com"],
    from: MAILBOX,
  };

  const summaryA = await runWithTenancyContext({ tenantId: tenantA, userId: "test-user", permissions: [] }, () =>
    reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps({ listSentItemsSince: async () => [sentItem] }) }),
  );

  // Desde tenantA, este Sent Item real no tiene ningún EmailMessage propio que lo explique -> alerta, nunca confirma el de tenantB.
  assert.equal(summaryA.confirmedThisRun, 0);
  assert.equal(summaryA.untrackedAlertsCreated, 1);

  const rowB = await prisma.emailMessage.findUniqueOrThrow({ where: { id: emailB.id } });
  assert.equal(rowB.status, "ACCEPTED_BY_PROVIDER", "el EmailMessage de otro tenant nunca se modifica");
});

/**
 * F27 Fase 11: reconciliación retroactiva de mensajes legados SENT (ver
 * hallazgo real -- 5 ApprovalRequest reales de 2026-07-24 con
 * EmailMessage.status="SENT", nunca reconciliados porque trackedMessages
 * excluía ese estado del filtro).
 */

test("reconcileMailbox: un EmailMessage legado SENT que aparece en Sent Items migra a SENT_CONFIRMED, completa acceptedAt/internetMessageId/sentItemsConfirmedAt y conserva providerMessageId", async () => {
  const tenantId = await setupTenant("legacy-sent-confirm");
  const legacy = await createLegacySentEmailMessage(tenantId);

  const sentItem: GraphSentItem = {
    id: "legacy-graph-id-1",
    subject: "Legacy subject",
    sentDateTime: "2026-07-24T19:58:50.000Z",
    internetMessageId: "<real-legacy@dreistaff.com>",
    conversationId: "real-legacy-conv",
    toRecipients: ["legacy-prospect@example.com"],
    from: MAILBOX,
  };

  const summary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps({ listSentItemsSince: async () => [sentItem] }) }),
  );

  assert.equal(summary.confirmedThisRun, 1);
  assert.equal(summary.legacySentReconciled, 1);
  assert.equal(summary.details.reconciled.length, 1);
  assert.equal(summary.details.reconciled[0]?.fromStatus, "SENT");

  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.equal(row.status, "SENT_CONFIRMED");
  assert.equal(row.providerMessageId, "legacy-graph-id-1", "providerMessageId se conserva, nunca se pisa");
  assert.equal(row.internetMessageId, "<real-legacy@dreistaff.com>");
  assert.ok(row.sentItemsConfirmedAt);
  assert.ok(row.acceptedAt, "acceptedAt se completa retroactivamente para un legado que nunca lo tuvo");
  assert.equal(row.acceptedAt?.toISOString(), "2026-07-24T19:58:50.000Z", "usa la evidencia real de Graph (sentDateTime), nunca 'ahora'");
});

test("reconcileMailbox: resuelve automáticamente una EmailReconciliationAlert OPEN cuyo graphMessageId coincide con un EmailMessage legado SENT recién reconciliado (falso positivo)", async () => {
  const tenantId = await setupTenant("legacy-sent-resolves-alert");
  await createLegacySentEmailMessage(tenantId);
  const alert = await createOpenAlert(tenantId);

  const sentItem: GraphSentItem = {
    id: "legacy-graph-id-1",
    subject: "Legacy subject",
    sentDateTime: new Date().toISOString(),
    internetMessageId: "<real-legacy@dreistaff.com>",
    conversationId: null,
    toRecipients: ["legacy-prospect@example.com"],
    from: MAILBOX,
  };

  const summary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps({ listSentItemsSince: async () => [sentItem] }) }),
  );

  assert.equal(summary.alertsResolved, 1);
  assert.equal(summary.details.alertsResolved[0]?.alertId, alert.id);
  assert.equal(summary.details.alertsStillOpen.length, 0);

  const row = await prisma.emailReconciliationAlert.findUniqueOrThrow({ where: { id: alert.id } });
  assert.equal(row.status, "RESOLVED");
  assert.ok(row.resolvedAt);
  const emailRow = await prisma.emailMessage.findFirstOrThrow({ where: { tenantId, providerMessageId: "legacy-graph-id-1" } });
  assert.equal(row.resolvedEmailMessageId, emailRow.id);
});

test("reconcileMailbox: un EmailMessage legado SENT que NO aparece en Sent Items real permanece SENT, sin tocar", async () => {
  const tenantId = await setupTenant("legacy-sent-not-found");
  const legacy = await createLegacySentEmailMessage(tenantId);

  const summary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps({ listSentItemsSince: async () => [] }) }),
  );

  assert.equal(summary.confirmedThisRun, 0);
  assert.equal(summary.legacySentReconciled, 0);

  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.equal(row.status, "SENT", "sin evidencia real en Sent Items, el legado nunca se reinterpreta a ciegas");
  assert.equal(row.acceptedAt, null);
  assert.equal(row.sentItemsConfirmedAt, null);
});

test("reconcileMailbox: correr la reconciliación de un legado SENT dos veces es idempotente -- la segunda corrida no reconfirma, no duplica auditoría y no vuelve a resolver la alerta", async () => {
  const tenantId = await setupTenant("legacy-sent-idempotent");
  await createLegacySentEmailMessage(tenantId);
  const alert = await createOpenAlert(tenantId);

  const sentItem: GraphSentItem = {
    id: "legacy-graph-id-1",
    subject: "Legacy subject",
    sentDateTime: "2026-07-24T19:58:50.000Z",
    internetMessageId: "<real-legacy@dreistaff.com>",
    conversationId: null,
    toRecipients: ["legacy-prospect@example.com"],
    from: MAILBOX,
  };
  const deps = fakeGraphDeps({ listSentItemsSince: async () => [sentItem] });

  const first = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: deps }));
  const second = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: deps }));

  assert.equal(first.confirmedThisRun, 1);
  assert.equal(first.alertsResolved, 1);
  assert.equal(second.confirmedThisRun, 0);
  assert.equal(second.legacySentReconciled, 0);
  assert.equal(second.alreadyConfirmed, 1);
  assert.equal(second.alertsResolved, 0, "la alerta ya resuelta no se vuelve a contar");

  const emailRow = await prisma.emailMessage.findFirstOrThrow({ where: { tenantId, providerMessageId: "legacy-graph-id-1" } });
  assert.equal(emailRow.status, "SENT_CONFIRMED");
  const confirmedLogs = await prisma.auditLog.count({ where: { tenantId, entityId: emailRow.id, action: "email.sent_confirmed" } });
  assert.equal(confirmedLogs, 1);
  const resolvedLogs = await prisma.auditLog.count({ where: { tenantId, entityId: alert.id, action: "email.reconciliation_alert_resolved" } });
  assert.equal(resolvedLogs, 1);

  const alertRow = await prisma.emailReconciliationAlert.findUniqueOrThrow({ where: { id: alert.id } });
  assert.equal(alertRow.status, "RESOLVED");
});

test("reconcileMailbox: una alerta real sin ningún EmailMessage correspondiente (envío externo genuino) permanece OPEN, nunca se toca", async () => {
  const tenantId = await setupTenant("genuine-external-alert-untouched");
  await createLegacySentEmailMessage(tenantId); // ruido: otro EmailMessage legado en el mismo tenant, no debe interferir
  await createOpenAlert(tenantId); // alerta real del legado -- ESTA sí debe resolverse
  const genuineAlert = await createOpenAlert(tenantId, {
    graphMessageId: "genuinely-external-graph-id",
    subject: "Correo de prueba enviado por fuera del CRM",
    toRecipients: ["someone-external@example.com"],
  });

  // El único Sent Item real de esta corrida es el legado (se reconcilia),
  // el mensaje genuinamente externo NUNCA aparece en Graph en esta
  // ventana -- exactamente el caso real de los 6 huérfanos genuinos.
  const sentItem: GraphSentItem = {
    id: "legacy-graph-id-1",
    subject: "Legacy subject",
    sentDateTime: new Date().toISOString(),
    internetMessageId: null,
    conversationId: null,
    toRecipients: ["legacy-prospect@example.com"],
    from: MAILBOX,
  };

  const summary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    reconcileMailbox(MAILBOX, FAKE_AZURE, { graphDeps: fakeGraphDeps({ listSentItemsSince: async () => [sentItem] }) }),
  );

  assert.equal(summary.alertsResolved, 1, "solo se resuelve la del legado, nunca la genuina");
  assert.equal(summary.details.alertsStillOpen.length, 1);
  assert.equal(summary.details.alertsStillOpen[0]?.alertId, genuineAlert.id);

  const row = await prisma.emailReconciliationAlert.findUniqueOrThrow({ where: { id: genuineAlert.id } });
  assert.equal(row.status, "OPEN");
  assert.equal(row.resolvedAt, null);
});

test("reconcileMailbox: dryRun no escribe nada en la base pero reporta el mismo detalle que una corrida real (reconciled/alertsResolved/alertsStillOpen)", async () => {
  const tenantId = await setupTenant("legacy-sent-dry-run");
  const legacy = await createLegacySentEmailMessage(tenantId);
  const alert = await createOpenAlert(tenantId);
  const genuineAlert = await createOpenAlert(tenantId, { graphMessageId: "genuine-dry-run-alert", subject: "Externo genuino", toRecipients: ["externo@example.com"] });

  const sentItem: GraphSentItem = {
    id: "legacy-graph-id-1",
    subject: "Legacy subject",
    sentDateTime: "2026-07-24T19:58:50.000Z",
    internetMessageId: "<real-legacy@dreistaff.com>",
    conversationId: null,
    toRecipients: ["legacy-prospect@example.com"],
    from: MAILBOX,
  };

  const summary = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    reconcileMailbox(MAILBOX, FAKE_AZURE, { dryRun: true, graphDeps: fakeGraphDeps({ listSentItemsSince: async () => [sentItem] }) }),
  );

  assert.equal(summary.dryRun, true);
  assert.equal(summary.confirmedThisRun, 1);
  assert.equal(summary.legacySentReconciled, 1);
  assert.equal(summary.alertsResolved, 1);
  assert.equal(summary.details.alertsResolved[0]?.alertId, alert.id);
  assert.equal(summary.details.alertsStillOpen.length, 1);
  assert.equal(summary.details.alertsStillOpen[0]?.alertId, genuineAlert.id);

  // Nada se escribió de verdad.
  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.equal(row.status, "SENT", "dryRun nunca escribe -- el estado real no cambia");
  assert.equal(row.sentItemsConfirmedAt, null);
  const alertRow = await prisma.emailReconciliationAlert.findUniqueOrThrow({ where: { id: alert.id } });
  assert.equal(alertRow.status, "OPEN", "dryRun nunca resuelve de verdad");
  const auditCount = await prisma.auditLog.count({ where: { tenantId } });
  assert.equal(auditCount, 0, "dryRun nunca audita nada");
});
