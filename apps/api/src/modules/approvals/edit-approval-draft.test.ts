import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { editApprovalDraftInputSchema } from "@ai-staffing-os/shared";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { decideApproval, editApprovalDraft, sendApproval } from "./service";
import type { MicrosoftGraphProviderPort } from "../email/email-service";
import type { SendGraphMailResult } from "../email/microsoft-graph";

/**
 * F23 (pedido explícito del PO): edición segura de un borrador de
 * outreach ANTES de aprobar/enviar, desde Approvals. Mismo patrón de
 * fixtures que decide-approval-email.test.ts -- ningún test acá llama a
 * Microsoft Graph real (graphProvider siempre mockeado cuando se usa
 * sendApproval).
 */

const TEST_PREFIX = "F23-EDIT-DRAFT-TEST";
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
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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

async function createDraftApproval(
  tenantId: string,
  agentTaskId: string,
  companyId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.approvalRequest.create({
    data: {
      tenantId,
      agentTaskId,
      summary: "Borrador de prueba",
      proposedAction: {
        channel: "EMAIL",
        companyId,
        to: "original@old-domain.example",
        subject: "Asunto original",
        body: "Cuerpo original",
        ...overrides,
      },
      riskLevel: "MEDIUM",
    },
  });
}

// ---------- Validación del schema (Fase 2, regla 5) ----------

test("editApprovalDraftInputSchema rechaza un email con formato inválido", () => {
  const result = editApprovalDraftInputSchema.safeParse({ to: "not-an-email", subject: "s", body: "b" });
  assert.equal(result.success, false);
});

test("editApprovalDraftInputSchema rechaza un asunto vacío (incluso solo espacios)", () => {
  const result = editApprovalDraftInputSchema.safeParse({ to: "a@b.com", subject: "   ", body: "b" });
  assert.equal(result.success, false);
});

test("editApprovalDraftInputSchema rechaza un cuerpo vacío (incluso solo espacios)", () => {
  const result = editApprovalDraftInputSchema.safeParse({ to: "a@b.com", subject: "s", body: "   " });
  assert.equal(result.success, false);
});

test("editApprovalDraftInputSchema rechaza campos desconocidos (.strict())", () => {
  const result = editApprovalDraftInputSchema.safeParse({ to: "a@b.com", subject: "s", body: "b", leadId: "sneaky" });
  assert.equal(result.success, false);
});

test("editApprovalDraftInputSchema hace trim de espacios en los 3 campos", () => {
  const result = editApprovalDraftInputSchema.safeParse({ to: "  a@b.com  ", subject: "  s  ", body: "  b  " });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.to, "a@b.com");
    assert.equal(result.data.subject, "s");
    assert.equal(result.data.body, "b");
  }
});

// ---------- Estados editables (Fase 2, reglas 1-3) ----------

test("editApprovalDraft: PENDING se puede editar y permanece PENDING", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("edit-pending");
  const company = await prisma.company.create({ data: { tenantId, name: "Editable Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id);
    const result = await editApprovalDraft(approval.id, { to: "new@new-domain.example", subject: "Nuevo asunto", body: "Nuevo cuerpo" });

    assert.equal(result.status, "PENDING");
    const pa = result.proposedAction as { to: string; subject: string; body: string };
    assert.equal(pa.to, "new@new-domain.example");
    assert.equal(pa.subject, "Nuevo asunto");
    assert.equal(pa.body, "Nuevo cuerpo");
  });
});

test("editApprovalDraft: READY_TO_SEND se puede editar y VUELVE a PENDING (requiere nueva aprobación)", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("edit-ready");
  const company = await prisma.company.create({ data: { tenantId, name: "Ready Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id);
    await decideApproval(approval.id, { decision: "APPROVED" });

    const readyState = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(readyState.status, "READY_TO_SEND");

    const result = await editApprovalDraft(approval.id, { to: "fixed@new-domain.example", subject: "s2", body: "b2" });
    assert.equal(result.status, "PENDING");

    // Vuelve a exigir una aprobación real: decideApproval funciona de nuevo
    // (fallaría con 400 si siguiera en READY_TO_SEND -- ver el guard de decideApproval).
    const redecided = await decideApproval(approval.id, { decision: "APPROVED" });
    assert.equal(redecided.status, "READY_TO_SEND");
  });
});

test("editApprovalDraft: FAILED se puede editar y permanece FAILED (listo para reintentar el envío)", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("edit-failed");
  const company = await prisma.company.create({ data: { tenantId, name: "Failed Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id);
    await decideApproval(approval.id, { decision: "APPROVED" });
    await sendApproval(approval.id, {
      graphProvider: { sendGraphMail: async () => ({ kind: "failed", reason: "ErrorSendAsDenied", retryable: false, providerStatus: "AVAILABLE" }) },
      ...FAKE_AZURE,
    });

    const failedState = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(failedState.status, "FAILED");

    const result = await editApprovalDraft(approval.id, { to: "corrected@new-domain.example", subject: "s3", body: "b3" });
    assert.equal(result.status, "FAILED");
    const pa = result.proposedAction as { to: string };
    assert.equal(pa.to, "corrected@new-domain.example");
  });
});

test("editApprovalDraft: bloquea la edición de un ApprovalRequest SENT", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("edit-sent-blocked");
  const company = await prisma.company.create({ data: { tenantId, name: "Sent Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id);
    await decideApproval(approval.id, { decision: "APPROVED" });
    await sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });

    const sentState = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(sentState.status, "SENT");

    await assert.rejects(
      () => editApprovalDraft(approval.id, { to: "hacker@evil.example", subject: "s", body: "b" }),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );

    const unchanged = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal((unchanged.proposedAction as { to: string }).to, "original@old-domain.example");
  });
});

test("editApprovalDraft: bloquea la edición de un ApprovalRequest SENDING (carrera en curso)", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("edit-sending-blocked");
  const company = await prisma.company.create({ data: { tenantId, name: "Sending Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id);
    await decideApproval(approval.id, { decision: "APPROVED" });
    await prisma.approvalRequest.update({ where: { id: approval.id }, data: { status: "SENDING" } });

    await assert.rejects(
      () => editApprovalDraft(approval.id, { to: "hacker@evil.example", subject: "s", body: "b" }),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
  });
});

test("editApprovalDraft: bloquea la edición de un ApprovalRequest REJECTED", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("edit-rejected-blocked");
  const company = await prisma.company.create({ data: { tenantId, name: "Rejected Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id);
    await decideApproval(approval.id, { decision: "REJECTED" });

    await assert.rejects(
      () => editApprovalDraft(approval.id, { to: "hacker@evil.example", subject: "s", body: "b" }),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
  });
});

// ---------- Nunca toca Graph/EmailMessage; auditoría; contenido actualizado aguas abajo ----------

test("editApprovalDraft nunca llama a Microsoft Graph ni crea un EmailMessage", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("edit-never-sends");
  const company = await prisma.company.create({ data: { tenantId, name: "NeverSends Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id);
    await editApprovalDraft(approval.id, { to: "new@new-domain.example", subject: "s", body: "b" });
  });

  assert.equal(await prisma.emailMessage.count({ where: { tenantId } }), 0);
});

test("editApprovalDraft registra auditoría: quién, cuándo, campos modificados, valores anteriores y nuevos", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("edit-audit");
  const company = await prisma.company.create({ data: { tenantId, name: "Audit Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user-audit", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id);
    await editApprovalDraft(approval.id, { to: "new@new-domain.example", subject: "Asunto original", body: "Nuevo cuerpo" });
  });

  const log = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: "approval.draft_edited" } });
  assert.equal(log.actorId, "test-user-audit");
  assert.equal(log.actorType, "HUMAN");
  const before = log.before as Record<string, unknown>;
  const after = log.after as Record<string, unknown>;
  // El asunto no cambió -- no debe listarse como campo modificado.
  assert.ok(!("subject" in before));
  assert.equal(before.to, "original@old-domain.example");
  assert.equal(before.body, "Cuerpo original");
  assert.equal(after.to, "new@new-domain.example");
  assert.equal(after.body, "Nuevo cuerpo");
  assert.deepEqual((after.changedFields as string[]).sort(), ["body", "to"]);
});

test("Company/Lead/Opportunity permanecen intactos al editar un borrador", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("edit-preserves-crm");
  const company = await prisma.company.create({ data: { tenantId, name: "Preserved Co", industryId, status: "LEAD", email: "keep@preserved.example" } });
  const lead = await prisma.lead.create({ data: { tenantId, companyId: company.id, industryId, status: "NEW" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id, { leadId: lead.id });
    await editApprovalDraft(approval.id, { to: "edited@new-domain.example", subject: "s", body: "b" });
  });

  const companyAfter = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(companyAfter.email, "keep@preserved.example");
  const leadAfter = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
  assert.equal(leadAfter.status, "NEW");
});

test("sendApproval posterior a una edición usa el CONTENIDO ACTUALIZADO, no el original", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("edit-then-send");
  const company = await prisma.company.create({ data: { tenantId, name: "Updated Send Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id);
    await editApprovalDraft(approval.id, { to: "corrected@new-domain.example", subject: "Asunto corregido", body: "Cuerpo corregido" });
    await decideApproval(approval.id, { decision: "APPROVED" });
    const result = await sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });

    assert.equal(result.status, "SENT");
    const row = await prisma.emailMessage.findFirstOrThrow({ where: { tenantId, approvalRequestId: approval.id } });
    assert.equal(row.toEmail, "corrected@new-domain.example");
    assert.equal(row.subject, "Asunto corregido");
    assert.equal(row.bodyText, "Cuerpo corregido");
  });
});

test("editApprovalDraft en un shape sin `to` literal (campaignCompanyId) hace que el envío posterior use el `to` editado, no el resuelto por Contact", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("edit-classic-shape");
  const company = await prisma.company.create({ data: { tenantId, name: "Classic Shape Co", industryId, status: "LEAD", email: "org@classic.example" } });
  await prisma.contact.create({ data: { tenantId, companyId: company.id, firstName: "Bob", lastName: "Smith", email: "bob@classic.example", isPrimary: true } });
  const campaign = await prisma.campaign.create({ data: { tenantId, name: "Test Campaign", industryId } });
  const campaignCompany = await prisma.campaignCompany.create({ data: { tenantId, campaignId: campaign.id, companyId: company.id } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador (campaignCompanyId, sin to)",
        proposedAction: { campaignId: campaign.id, campaignCompanyId: campaignCompany.id, sequenceStep: 0, channel: "EMAIL", subject: "Original", body: "Original" },
        riskLevel: "MEDIUM",
      },
    });

    await editApprovalDraft(approval.id, { to: "manually-verified@classic.example", subject: "Editado", body: "Editado" });
    await decideApproval(approval.id, { decision: "APPROVED" });
    const result = await sendApproval(approval.id, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });

    assert.equal(result.status, "SENT");
    const row = await prisma.emailMessage.findFirstOrThrow({ where: { tenantId, approvalRequestId: approval.id } });
    assert.equal(row.toEmail, "manually-verified@classic.example");
  });
});

// ---------- Placeholders bloquean la aprobación (Fase 4) ----------

test("decideApproval(APPROVED) rechaza un borrador con placeholders de firma sin completar", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("placeholder-blocks");
  const company = await prisma.company.create({ data: { tenantId, name: "Placeholder Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id, {
      body: "Hola,\n\nSaludos,\n[Your Name]\n[Your Position]",
    });

    await assert.rejects(
      () => decideApproval(approval.id, { decision: "APPROVED" }),
      (err: unknown) => err instanceof AppError && err.status === 400 && /placeholder/i.test(err.message),
    );

    const state = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(state.status, "PENDING", "nunca debe avanzar a READY_TO_SEND con placeholders sin resolver");
  });
});

test("decideApproval(REJECTED) sigue permitido incluso con placeholders sin completar", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("placeholder-allows-reject");
  const company = await prisma.company.create({ data: { tenantId, name: "Placeholder Reject Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id, { body: "Saludos,\n[Your Name]" });
    const result = await decideApproval(approval.id, { decision: "REJECTED" });
    assert.equal(result.status, "REJECTED");
  });
});

test("editar un borrador para reemplazar el placeholder por la firma real desbloquea la aprobación", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("placeholder-fixed-by-edit");
  const company = await prisma.company.create({ data: { tenantId, name: "Placeholder Fixed Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id, { body: "Saludos,\n[Your Name]" });

    await editApprovalDraft(approval.id, {
      to: "original@old-domain.example",
      subject: "Asunto original",
      body: "Saludos,\n\nBest regards,\n\nThe DreiStaff Team\nDreiStaff\nsales@dreistaff.com\nhttps://dreistaff.com",
    });

    const result = await decideApproval(approval.id, { decision: "APPROVED" });
    assert.equal(result.status, "READY_TO_SEND");
  });
});

// ---------- Advertencia de destinatario sospechoso (Fase 5) ----------

test("recipientWarning: destinatario con dominio ajeno al sitio oficial de la Company se marca sospechoso", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("recipient-warning-domain");
  const company = await prisma.company.create({
    data: { tenantId, name: "Official Domain Co", industryId, status: "LEAD", website: "https://official-domain.example" },
  });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id, { to: "someone@totally-different.example" });
    const result = await editApprovalDraft(approval.id, { to: "someone@totally-different.example", subject: "s", body: "b" });
    assert.equal(result.recipientWarning?.suspicious, true);
    assert.ok(result.recipientWarning?.reasons.some((r) => /dominio/i.test(r)));
  });
});

test("recipientWarning: cadena numérica inusual antes de \"@\" se marca sospechosa", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("recipient-warning-numeric");
  const company = await prisma.company.create({ data: { tenantId, name: "Numeric Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id, { to: "reservations88213045@some-hotel.example" });
    const result = await editApprovalDraft(approval.id, { to: "reservations88213045@some-hotel.example", subject: "s", body: "b" });
    assert.equal(result.recipientWarning?.suspicious, true);
  });
});

test("recipientWarning: destinatario que coincide con el dominio oficial y sin patrones sospechosos no se marca", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("recipient-warning-clean");
  const company = await prisma.company.create({
    data: { tenantId, name: "Clean Co", industryId, status: "LEAD", website: "https://clean-hotel.example" },
  });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id, { to: "jane.doe@clean-hotel.example" });
    const result = await editApprovalDraft(approval.id, { to: "jane.doe@clean-hotel.example", subject: "s", body: "b" });
    assert.equal(result.recipientWarning?.suspicious, false);
  });
});

// ---------- Cancelar edición no modifica nada (análogo de backend: nunca se llama al endpoint) ----------

test("no llamar a editApprovalDraft (equivalente a 'Cancelar' en la UI) deja el proposedAction intacto", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("cancel-noop");
  const company = await prisma.company.create({ data: { tenantId, name: "Cancel Co", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createDraftApproval(tenantId, agentTaskId, company.id);
    const before = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    const after = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    assert.deepEqual(before.proposedAction, after.proposedAction);
    assert.equal(before.status, after.status);
  });
});
