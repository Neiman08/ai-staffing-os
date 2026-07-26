import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { runInternalAcceptanceTest, type InternalAcceptanceTestDeps } from "./service";

/**
 * F27 (Internal Acceptance Test) -- pruebas de integración reales contra
 * la base real, pero CERO llamadas reales a OpenAI o Microsoft Graph:
 * draftOutreachRunner y sendApprovalDeps.graphProvider siempre mockeados
 * acá, mismo criterio de inyección que el resto del repo (ver
 * email-service.test.ts/contact-enrichment.test.ts). Confirma que la
 * ORQUESTACIÓN real (Company/Lead/Contact -> ApprovalRequest ->
 * editApprovalDraft -> decide -> send -> EmailMessage/AuditLog) es
 * correcta, sin depender de proveedores externos reales.
 */

const TEST_PREFIX = "F27-INTERNAL-ACCEPTANCE-TEST";
const createdTenantIds: string[] = [];

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  await prisma.industry.create({ data: { tenantId: tenant.id, name: "Construction", isGlobal: false } });
  const discoveryDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "discovery" } });
  await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: discoveryDefinition.id, isActive: true } });
  return tenant.id;
}

after(async () => {
  if (createdTenantIds.length) {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.emailMessage.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.lead.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.contact.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.industry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

const ALLOWLISTED_RECIPIENT = "neimangroupllc@gmail.com"; // default de INTERNAL_ACCEPTANCE_TEST_ALLOWED_RECIPIENTS, ver core/env.ts

function fakeDeps(overrides: Partial<InternalAcceptanceTestDeps> = {}): InternalAcceptanceTestDeps {
  return {
    draftOutreachRunner: async ({ leadId, tenantId }) => {
      const agentInstance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId } });
      const agentTask = await prisma.agentTask.create({
        data: { tenantId, agentInstanceId: agentInstance.id, type: "draft_outreach", status: "DONE", triggeredBy: "USER", input: { leadId } },
      });
      const approval = await prisma.approvalRequest.create({
        data: {
          tenantId,
          agentTaskId: agentTask.id,
          summary: "Fake AI draft for internal acceptance test",
          proposedAction: { channel: "EMAIL", leadId, subject: "Fake AI-generated subject", body: "Fake AI-generated body" },
          riskLevel: "MEDIUM",
        },
      });
      return { approvalRequestId: approval.id };
    },
    sendApprovalDeps: {
      graphProvider: {
        sendGraphMail: async () => ({
          kind: "sent",
          providerMessageId: "fake-graph-id",
          conversationId: "fake-conv-id",
          internetMessageId: "<fake@dreistaff.com>",
          httpStatus: 202,
          clientRequestId: "fake-request-id",
        }),
      },
      azureTenantId: "fake-tenant",
      azureClientId: "fake-client",
      azureClientSecret: "fake-secret",
    },
    ...overrides,
  };
}

test("runInternalAcceptanceTest: recorre Company -> Lead -> Contact -> ApprovalRequest -> EmailMessage, con los marcadores INTERNAL_TEST correctos", async () => {
  const tenantId = await setupTenant("happy-path");

  const result = await runWithTenancyContext({ tenantId, userId: "test-admin", permissions: ["internalTests.run"] }, () =>
    runInternalAcceptanceTest({ recipientEmail: ALLOWLISTED_RECIPIENT, acceptanceTest: true, reason: "prueba automatizada" }, fakeDeps()),
  );

  const company = await prisma.company.findUniqueOrThrow({ where: { id: result.companyId } });
  assert.equal(company.origin, "INTERNAL_TEST");

  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: result.leadId } });
  assert.equal(lead.source, "INTERNAL_TEST");

  const contact = await prisma.contact.findUniqueOrThrow({ where: { id: result.contactId } });
  assert.equal(contact.source, "INTERNAL_TEST");
  assert.equal(contact.verificationStatus, "INTERNAL_TEST_VERIFIED");
  assert.equal(contact.email, ALLOWLISTED_RECIPIENT);

  // F27 (req. explícito): siempre se crean ApprovalRequest, EmailMessage y AuditLog.
  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: result.approvalRequestId } });
  assert.equal(approval.status, "SENT");
  assert.ok(result.emailMessageId);
  const emailMessage = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.emailMessageId! } });
  assert.equal(emailMessage.approvalRequestId, result.approvalRequestId);
  assert.equal(emailMessage.toEmail, ALLOWLISTED_RECIPIENT);
  assert.equal(emailMessage.subject, "DreiStaff – Final Production Acceptance Test");

  // F27 (req. explícito: "Graph 202 no se muestra directamente como SENT_CONFIRMED").
  assert.equal(result.emailSendResult?.status, "ACCEPTED_BY_PROVIDER");
  assert.equal(emailMessage.status, "ACCEPTED_BY_PROVIDER");
  assert.notEqual(result.emailSendResult?.status, "SENT_CONFIRMED", "solo el reconciliador puede escribir SENT_CONFIRMED, nunca el send inicial");

  // F27 (req. explícito): AuditLog real, con quién/motivo/destinatario/transiciones.
  const auditActions = (await prisma.auditLog.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } })).map((l) => l.action);
  assert.ok(auditActions.includes("internal_test.initiated"));
  assert.ok(auditActions.includes("internal_test.entities_created"));
  assert.ok(auditActions.includes("internal_test.draft_created"));
  assert.ok(auditActions.includes("internal_test.approved"));
  assert.ok(auditActions.includes("internal_test.send_attempted"));
  assert.ok(auditActions.includes("internal_test.completed"));
  const initiatedLog = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: "internal_test.initiated" } });
  assert.equal(initiatedLog.actorId, "test-admin");
  const after0 = initiatedLog.after as Record<string, unknown>;
  assert.equal(after0.reason, "prueba automatizada");
  assert.equal(after0.recipientEmail, ALLOWLISTED_RECIPIENT);
  assert.equal(after0.isInternalTest, true);
});

test("runInternalAcceptanceTest: un destinatario fuera de la allowlist se rechaza ANTES de crear nada -- ni Company ni AuditLog", async () => {
  const tenantId = await setupTenant("not-allowlisted");

  await assert.rejects(() =>
    runWithTenancyContext({ tenantId, userId: "test-admin", permissions: ["internalTests.run"] }, () =>
      runInternalAcceptanceTest({ recipientEmail: "someone-else@example.com", acceptanceTest: true, reason: "test" }, fakeDeps()),
    ),
  );

  assert.equal(await prisma.company.count({ where: { tenantId } }), 0);
  assert.equal(await prisma.auditLog.count({ where: { tenantId } }), 0);
});

test("runInternalAcceptanceTest: un fallo real de draftOutreach detiene todo de inmediato -- nunca reintenta, nunca llega a Approve & Send", async () => {
  const tenantId = await setupTenant("draft-fails");

  await assert.rejects(
    () =>
      runWithTenancyContext({ tenantId, userId: "test-admin", permissions: ["internalTests.run"] }, () =>
        runInternalAcceptanceTest(
          { recipientEmail: ALLOWLISTED_RECIPIENT, acceptanceTest: true, reason: "test" },
          fakeDeps({ draftOutreachRunner: async () => ({ failed: true, reason: "LLM real no disponible (simulado)" }) }),
        ),
      ),
    /LLM real no disponible/,
  );

  assert.equal(await prisma.approvalRequest.count({ where: { tenantId } }), 0);
  assert.equal(await prisma.emailMessage.count({ where: { tenantId } }), 0);
  const auditActions = (await prisma.auditLog.findMany({ where: { tenantId } })).map((l) => l.action);
  assert.ok(auditActions.includes("internal_test.draft_failed"));
  assert.ok(!auditActions.includes("internal_test.approved"), "un fallo en el borrador nunca debe llegar a Approve & Send");
});

test("el contacto/Company de prueba interna nunca cuentan como target de campaña comercial (mismo filtro real que excluye DEMO_SEED)", async () => {
  const tenantId = await setupTenant("never-in-campaigns");

  const result = await runWithTenancyContext({ tenantId, userId: "test-admin", permissions: ["internalTests.run"] }, () =>
    runInternalAcceptanceTest({ recipientEmail: ALLOWLISTED_RECIPIENT, acceptanceTest: true, reason: "test" }, fakeDeps()),
  );

  // Mismo predicado real que campaign-tools.impl.ts/crm/service.ts/public/service.ts usan para excluir datos no comerciales.
  const eligibleForCampaigns = await prisma.company.findMany({ where: { tenantId, origin: { notIn: ["DEMO_SEED", "INTERNAL_TEST"] } } });
  assert.ok(!eligibleForCampaigns.some((c) => c.id === result.companyId), "una Company INTERNAL_TEST nunca debe pasar el filtro real de elegibilidad de campaña");
});

test("PDL/Hunter nunca se tocan durante la prueba interna -- ningún crédito real se consume", async () => {
  const tenantId = await setupTenant("no-pdl-hunter-usage");
  const before1 = await prisma.hunterDomainSearchCache.count({ where: { tenantId } });

  await runWithTenancyContext({ tenantId, userId: "test-admin", permissions: ["internalTests.run"] }, () =>
    runInternalAcceptanceTest({ recipientEmail: ALLOWLISTED_RECIPIENT, acceptanceTest: true, reason: "test" }, fakeDeps()),
  );

  const after1 = await prisma.hunterDomainSearchCache.count({ where: { tenantId } });
  assert.equal(after1, before1, "la prueba interna nunca debe generar actividad de Hunter -- el flujo nunca llama a contact-enrichment.ts");
  // find_contacts es el único tipo de AgentTask que puede gastar créditos reales de PDL (ver pdl-budget.ts) -- nunca debe existir uno acá.
  assert.equal(await prisma.agentTask.count({ where: { tenantId, type: "find_contacts" } }), 0);
});
