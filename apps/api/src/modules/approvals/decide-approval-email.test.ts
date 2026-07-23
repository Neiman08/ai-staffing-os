import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { decideApproval, sendApproval } from "./service";
import type { MicrosoftGraphProviderPort } from "../email/email-service";
import type { SendGraphMailResult } from "../email/microsoft-graph";

/**
 * F21 Fase 4 (separación aprobación/envío, pedido explícito del PO):
 * decideApproval(APPROVED) NUNCA debe enviar nada -- solo transiciona a
 * READY_TO_SEND. El envío real es una acción separada (sendApproval),
 * probada acá contra un mock de Microsoft Graph -- nunca la red real.
 * Cubre los mismos 3 shapes reales de proposedAction que F17 ya cubría
 * (discovery-conversion, sales-tools draftOutreach, outreach-tools
 * personalizeMessage), más los casos de idempotencia y de borde nuevos
 * de esta fase.
 */

const TEST_PREFIX = "F21-APPROVAL-SEND-TEST";
const createdTenantIds: string[] = [];
const FAKE_AZURE = { azureTenantId: "fake-tenant", azureClientId: "fake-client", azureClientSecret: "fake-secret" };

async function setupTenant(suffix: string) {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  const industry = await prisma.industry.create({ data: { tenantId: tenant.id, name: "Construction", isGlobal: false } });
  const discoveryDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "discovery" } });
  const agentInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: discoveryDefinition.id, isActive: true } });
  const agentTask = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: agentInstance.id, type: "draft_outreach", status: "AWAITING_APPROVAL", triggeredBy: "AGENT", input: {} },
  });
  return { tenantId: tenant.id, industryId: industry.id, agentTaskId: agentTask.id };
}

after(async () => {
  if (createdTenantIds.length) {
    await prisma.emailMessage.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaignCompany.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaign.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.lead.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.contact.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.industry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

function fakeGraphProvider(sent: SendGraphMailResult = { kind: "sent", providerMessageId: "fake-msg-id", conversationId: "fake-conv-id" }): MicrosoftGraphProviderPort {
  return { sendGraphMail: async () => sent };
}

// ---------- Regla central: APPROVED nunca envía ----------

test("decideApproval(APPROVED) transiciona a READY_TO_SEND -- NUNCA crea un EmailMessage ni llama al proveedor", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("approved-never-sends");
  const company = await prisma.company.create({ data: { tenantId, name: "Acme Electrical", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador de email para Acme Electrical",
        proposedAction: { channel: "EMAIL", companyId: company.id, to: "info@acme-electrical.example", subject: "Posible colaboración", body: "Hola, ..." },
        riskLevel: "MEDIUM",
      },
    });

    const result = await decideApproval(approval.id, { decision: "APPROVED" });
    assert.equal(result.status, "READY_TO_SEND");
    assert.equal(result.emailSendResult, null);
  });

  const count = await prisma.emailMessage.count({ where: { tenantId } });
  assert.equal(count, 0, "decideApproval nunca debe crear un EmailMessage");
});

test("decideApproval(REJECTED) sigue terminando el ciclo ahí mismo -- nunca sendable después", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("rejected");
  const company = await prisma.company.create({ data: { tenantId, name: "Epsilon Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador para Epsilon Co",
        proposedAction: { channel: "EMAIL", companyId: company.id, to: "info@epsilon.example", subject: "s", body: "b" },
        riskLevel: "MEDIUM",
      },
    });

    const result = await decideApproval(approval.id, { decision: "REJECTED" });
    assert.equal(result.status, "REJECTED");

    await assert.rejects(() => sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE }), (err: unknown) => err instanceof AppError && err.status === 400);
  });
  assert.equal(await prisma.emailMessage.count({ where: { tenantId } }), 0);
});

// ---------- sendApproval: los mismos 3 shapes reales, ahora en 2 pasos ----------

test("sendApproval sobre un draft F14/F15 (proposedAction.to ya resuelto) envía real vía Graph desde sales@dreistaff.com, luego de decideApproval", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("f14-shape");
  const company = await prisma.company.create({ data: { tenantId, name: "Acme Electrical 2", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador de email para Acme Electrical 2",
        proposedAction: {
          channel: "EMAIL",
          companyId: company.id,
          leadId: null,
          opportunityId: null,
          contactId: null,
          recipientKind: "organizational",
          to: "info@acme-electrical.example",
          subject: "Posible colaboración",
          body: "Hola, ...",
        },
        riskLevel: "MEDIUM",
      },
    });

    await decideApproval(approval.id, { decision: "APPROVED" });
    const result = await sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });

    assert.equal(result.status, "SENT");
    assert.equal(result.emailSendResult?.status, "SENT");
    assert.equal(result.emailSendResult?.providerMessageId, "fake-msg-id");
    assert.ok(result.sentAt);
    assert.ok(result.sentByLabel);

    const row = await prisma.emailMessage.findFirstOrThrow({ where: { tenantId, approvalRequestId: approval.id } });
    assert.equal(row.toEmail, "info@acme-electrical.example");
    assert.equal(row.fromEmail, "sales@dreistaff.com");
    assert.equal(row.status, "SENT");

    const stored = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(stored.status, "SENT");
    assert.equal(stored.sentById, "test-user");
    assert.ok(stored.sentAt);
  });
});

test("sendApproval de sales-tools (leadId + contactId, sin `to`) resuelve el email del Contact real", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("sales-tools-shape");
  const company = await prisma.company.create({ data: { tenantId, name: "Beta Manufacturing", industryId, status: "LEAD", email: "org@beta-mfg.example" } });
  const contact = await prisma.contact.create({ data: { tenantId, companyId: company.id, firstName: "Jane", lastName: "Doe", email: "jane.doe@beta-mfg.example" } });
  const lead = await prisma.lead.create({ data: { tenantId, companyId: company.id, industryId, status: "NEW" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador de email para Beta Manufacturing",
        proposedAction: { channel: "EMAIL", leadId: lead.id, contactId: contact.id, subject: "Primer contacto", body: "Hola Jane, ..." },
        riskLevel: "MEDIUM",
      },
    });

    await decideApproval(approval.id, { decision: "APPROVED" });
    const result = await sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });

    assert.equal(result.emailSendResult?.status, "SENT");
    const row = await prisma.emailMessage.findFirstOrThrow({ where: { tenantId, approvalRequestId: approval.id } });
    assert.equal(row.toEmail, "jane.doe@beta-mfg.example");
    assert.equal(row.leadId, lead.id);
    assert.equal(row.contactId, contact.id);
  });
});

test("sendApproval del loop clásico de Campaign (campaignCompanyId, sin `to`) resuelve el contacto real", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("classic-shape");
  const company = await prisma.company.create({ data: { tenantId, name: "Delta Electrical", industryId, status: "LEAD", email: "info@delta-electrical.example" } });
  const contact = await prisma.contact.create({ data: { tenantId, companyId: company.id, firstName: "Bob", lastName: "Smith", email: "bob.smith@delta-electrical.example", isPrimary: true } });
  const campaign = await prisma.campaign.create({ data: { tenantId, name: "Test Campaign", industryId } });
  const campaignCompany = await prisma.campaignCompany.create({ data: { tenantId, campaignId: campaign.id, companyId: company.id } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador (paso 1/4) para Delta Electrical",
        proposedAction: { campaignId: campaign.id, campaignCompanyId: campaignCompany.id, sequenceStep: 0, channel: "EMAIL", subject: "Primer contacto", body: "Hola Bob, ..." },
        riskLevel: "MEDIUM",
      },
    });

    await decideApproval(approval.id, { decision: "APPROVED" });
    const result = await sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });

    assert.equal(result.emailSendResult?.status, "SENT");
    const row = await prisma.emailMessage.findFirstOrThrow({ where: { tenantId, approvalRequestId: approval.id } });
    assert.equal(row.toEmail, "bob.smith@delta-electrical.example");
    assert.equal(row.companyId, company.id);
    assert.equal(row.contactId, contact.id);
  });
});

// ---------- Idempotencia y casos de borde ----------

test("idempotencia: llamar sendApproval dos veces sobre el mismo ApprovalRequest solo envía UNA vez -- la segunda se rechaza sin tocar nada", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("idempotency");
  const company = await prisma.company.create({ data: { tenantId, name: "Idempotent Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador para Idempotent Co",
        proposedAction: { channel: "EMAIL", companyId: company.id, to: "info@idempotent.example", subject: "s", body: "b" },
        riskLevel: "MEDIUM",
      },
    });

    await decideApproval(approval.id, { decision: "APPROVED" });
    const first = await sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });
    assert.equal(first.status, "SENT");

    await assert.rejects(
      () => sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE }),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
  });

  const emails = await prisma.emailMessage.count({ where: { tenantId } });
  assert.equal(emails, 1, "un ApprovalRequest SENT nunca puede generar un segundo envío real");
});

test("idempotencia: sendApproval en paralelo (misma carrera) solo deja pasar una de las dos llamadas", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("idempotency-race");
  const company = await prisma.company.create({ data: { tenantId, name: "Race Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador para Race Co",
        proposedAction: { channel: "EMAIL", companyId: company.id, to: "info@race.example", subject: "s", body: "b" },
        riskLevel: "MEDIUM",
      },
    });
    await decideApproval(approval.id, { decision: "APPROVED" });

    const results = await Promise.allSettled([
      sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE }),
      sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "solo UNA de las dos llamadas concurrentes debe ganar la carrera");
    assert.equal(rejected.length, 1);
  });

  assert.equal(await prisma.emailMessage.count({ where: { tenantId } }), 1);
});

test("sendApproval sobre un ApprovalRequest todavía PENDING (nunca decidido) se rechaza -- nunca se salta la aprobación humana", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("pending-cannot-send");
  const company = await prisma.company.create({ data: { tenantId, name: "Pending Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador para Pending Co",
        proposedAction: { channel: "EMAIL", companyId: company.id, to: "info@pending.example", subject: "s", body: "b" },
        riskLevel: "MEDIUM",
      },
    });

    await assert.rejects(() => sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE }), (err: unknown) => err instanceof AppError && err.status === 400);
  });
  assert.equal(await prisma.emailMessage.count({ where: { tenantId } }), 0);
});

test("sin ningún canal real resoluble -- sendApproval falla honestamente (FAILED), nunca inventa un destinatario, reintentable después", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("no-recipient");
  const company = await prisma.company.create({ data: { tenantId, name: "Sin Email Co", industryId, status: "LEAD" } }); // sin email
  const lead = await prisma.lead.create({ data: { tenantId, companyId: company.id, industryId, status: "NEW" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador sin destinatario resoluble",
        proposedAction: { channel: "EMAIL", leadId: lead.id, contactId: null, subject: "s", body: "b" },
        riskLevel: "MEDIUM",
      },
    });

    // F24 Fase 8: decideApproval ahora bloquea ESTE mismo caso más temprano
    // (Quality Gate, check contact_valid) -- se simula acá un registro
    // legacy que de alguna forma ya llegó a READY_TO_SEND (ej. datos de
    // antes de F24), para seguir probando la defensa PROPIA de
    // sendApproval, independiente de la de decideApproval.
    await prisma.approvalRequest.update({ where: { id: approval.id }, data: { status: "READY_TO_SEND" } });
    await assert.rejects(() => sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE }), (err: unknown) => err instanceof AppError && err.status === 400);

    const stored = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(stored.status, "FAILED", "nunca se queda trabado en SENDING");
  });
  assert.equal(await prisma.emailMessage.count({ where: { tenantId } }), 0);
});

// F24 Fase 8: el Quality Gate de decideApproval bloquea el MISMO caso de
// arriba mucho antes -- nunca llega siquiera a READY_TO_SEND.
test("Quality Gate: decideApproval(APPROVED) rechaza un borrador sin destinatario resoluble -- nunca llega a READY_TO_SEND", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("quality-gate-no-recipient");
  const company = await prisma.company.create({ data: { tenantId, name: "Sin Email Co 2", industryId, status: "LEAD" } });
  const lead = await prisma.lead.create({ data: { tenantId, companyId: company.id, industryId, status: "NEW" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador sin destinatario resoluble",
        proposedAction: { channel: "EMAIL", leadId: lead.id, contactId: null, subject: "s", body: "b" },
        riskLevel: "MEDIUM",
      },
    });

    await assert.rejects(
      () => decideApproval(approval.id, { decision: "APPROVED" }),
      (err: unknown) => err instanceof AppError && err.status === 400 && /destinatario/i.test(err.message),
    );

    const stored = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(stored.status, "PENDING", "nunca avanza a READY_TO_SEND sin un destinatario real");
  });
});

test("un fallo real del proveedor deja el ApprovalRequest en FAILED (reintentable), nunca en SENDING para siempre", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("provider-failure");
  const company = await prisma.company.create({ data: { tenantId, name: "Fails Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador para Fails Co",
        proposedAction: { channel: "EMAIL", companyId: company.id, to: "info@fails.example", subject: "s", body: "b" },
        riskLevel: "MEDIUM",
      },
    });
    await decideApproval(approval.id, { decision: "APPROVED" });

    const failingProvider: MicrosoftGraphProviderPort = {
      sendGraphMail: async () => ({ kind: "failed", reason: "403 ErrorSendAsDenied (mock)", retryable: false, httpStatus: 403, providerStatus: "AVAILABLE" }),
    };
    const result = await sendApproval(approval.id, { graphProvider: failingProvider, ...FAKE_AZURE });
    assert.equal(result.status, "FAILED");

    // Reintento real: un segundo sendApproval sobre un FAILED sí debe
    // poder volver a intentarlo (a diferencia de SENT).
    const retry = await sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });
    assert.equal(retry.status, "SENT");
  });
});
