import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { decideApproval } from "./service";
import type { MicrosoftGraphProviderPort } from "../email/email-service";
import type { SendGraphMailResult } from "../email/microsoft-graph";

/**
 * F17: prueba de integración real de extremo a extremo -- aprobar un
 * ApprovalRequest real (para cada uno de los 3 shapes reales de
 * proposedAction que este repo produce hoy, ver la auditoría en
 * approvals/service.ts) debe resolver un destinatario real y enviar vía
 * Microsoft Graph (mockeado acá, nunca la red real), siempre desde
 * sales@dreistaff.com. Base de datos real, contra un mock de Microsoft
 * Graph -- exactamente el mock de integración pedido explícitamente.
 */

const TEST_PREFIX = "F17-APPROVAL-EMAIL-TEST";
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

// ---------- Shape 1: discovery-conversion.ts (F14/F15) -- ya trae `to` ----------

test("aprobar un draft F14/F15 (proposedAction.to ya resuelto) envía real vía Graph desde sales@dreistaff.com", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("f14-shape");
  const company = await prisma.company.create({ data: { tenantId, name: "Acme Electrical", industryId, status: "LEAD" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador de email para Acme Electrical",
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

    const provider = fakeGraphProvider();
    const result = await decideApproval(approval.id, { decision: "APPROVED" }, { graphProvider: provider, ...FAKE_AZURE });

    assert.equal(result.emailSendResult?.status, "SENT");
    assert.equal(result.emailSendResult?.providerMessageId, "fake-msg-id");

    const row = await prisma.emailMessage.findFirstOrThrow({ where: { tenantId, approvalRequestId: approval.id } });
    assert.equal(row.toEmail, "info@acme-electrical.example");
    assert.equal(row.fromEmail, "sales@dreistaff.com");
    assert.equal(row.fromName, "DreiStaff Sales");
    assert.equal(row.companyId, company.id);
    assert.equal(row.status, "SENT");
  });
});

// ---------- Shape 2: sales-tools draftOutreach -- leadId (+ contactId opcional), sin `to` ----------

test("aprobar un draft de sales-tools (leadId + contactId, sin `to`) resuelve el email del Contact real y envía desde sales@dreistaff.com", async () => {
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

    const result = await decideApproval(approval.id, { decision: "APPROVED" }, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });

    assert.equal(result.emailSendResult?.status, "SENT");
    const row = await prisma.emailMessage.findFirstOrThrow({ where: { tenantId, approvalRequestId: approval.id } });
    // Debe preferir el email del Contact real -- nunca el email
    // organizacional cuando ya hay una persona real identificada.
    assert.equal(row.toEmail, "jane.doe@beta-mfg.example");
    assert.equal(row.fromEmail, "sales@dreistaff.com");
    assert.equal(row.leadId, lead.id);
    assert.equal(row.contactId, contact.id);
    assert.equal(row.companyId, company.id);
  });
});

test("aprobar un draft de sales-tools sin contactId (solo leadId) cae al email organizacional de la Company -- nunca inventa una persona", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("sales-tools-no-contact");
  const company = await prisma.company.create({ data: { tenantId, name: "Gamma Logistics", industryId, status: "LEAD", email: "hello@gamma-logistics.example" } });
  const lead = await prisma.lead.create({ data: { tenantId, companyId: company.id, industryId, status: "NEW" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador de email para Gamma Logistics",
        proposedAction: { channel: "EMAIL", leadId: lead.id, contactId: null, subject: "Primer contacto", body: "Hola, ..." },
        riskLevel: "MEDIUM",
      },
    });

    const result = await decideApproval(approval.id, { decision: "APPROVED" }, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });
    assert.equal(result.emailSendResult?.status, "SENT");
    const row = await prisma.emailMessage.findFirstOrThrow({ where: { tenantId, approvalRequestId: approval.id } });
    assert.equal(row.toEmail, "hello@gamma-logistics.example");
  });
});

// ---------- Shape 3: outreach-tools personalizeMessage (loop clásico) -- campaignCompanyId, sin `to` ----------

test("aprobar un draft del loop clásico de Campaign (campaignCompanyId, sin `to`) resuelve el contacto real vía CampaignCompany->Company->Contacts y envía desde sales@dreistaff.com", async () => {
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

    const result = await decideApproval(approval.id, { decision: "APPROVED" }, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });
    assert.equal(result.emailSendResult?.status, "SENT");
    const row = await prisma.emailMessage.findFirstOrThrow({ where: { tenantId, approvalRequestId: approval.id } });
    assert.equal(row.toEmail, "bob.smith@delta-electrical.example");
    assert.equal(row.companyId, company.id);
    assert.equal(row.contactId, contact.id);
  });
});

// ---------- Casos de borde reales ----------

test("REJECTED nunca intenta enviar nada -- emailSendResult queda null, ningún EmailMessage se crea", async () => {
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

    const result = await decideApproval(approval.id, { decision: "REJECTED" }, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });
    assert.equal(result.emailSendResult, null);
    const count = await prisma.emailMessage.count({ where: { tenantId, approvalRequestId: approval.id } });
    assert.equal(count, 0);
  });
});

test("channel LINKEDIN nunca intenta enviar por email -- emailSendResult queda null", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("linkedin-channel");
  const company = await prisma.company.create({ data: { tenantId, name: "Zeta Co", industryId, status: "LEAD" } });
  const lead = await prisma.lead.create({ data: { tenantId, companyId: company.id, industryId, status: "NEW" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador de LinkedIn",
        proposedAction: { channel: "LINKEDIN", leadId: lead.id, contactId: null, body: "Hola" },
        riskLevel: "MEDIUM",
      },
    });

    const result = await decideApproval(approval.id, { decision: "APPROVED" }, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });
    assert.equal(result.emailSendResult, null);
  });
});

test("sin ningún canal real resoluble (sin Contact, sin email organizacional) -- FAILED honesto, con evidencia, nunca inventa un destinatario", async () => {
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

    const result = await decideApproval(approval.id, { decision: "APPROVED" }, { graphProvider: fakeGraphProvider(), ...FAKE_AZURE });
    // resolveDraftEmail devuelve null (sin destinatario real) -> nunca se
    // intenta el envío, nunca se inventa un email -- emailSendResult
    // queda null (no "FAILED", porque ni siquiera se intentó: no hay
    // NADA que reintentar, es un dato faltante, no un fallo del proveedor).
    assert.equal(result.emailSendResult, null);
    const count = await prisma.emailMessage.count({ where: { tenantId, approvalRequestId: approval.id } });
    assert.equal(count, 0);
  });
});
