import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { sendEmail, type MicrosoftGraphProviderPort } from "./email-service";
import type { SendGraphMailResult } from "./microsoft-graph";

/**
 * F17: prueba de integración real contra la base -- un mock del
 * proveedor de Microsoft Graph (nunca la red real), pero EmailMessage se
 * escribe/lee de la base real, exactamente como en producción. Confirma
 * que el registro nunca miente: PENDING antes del intento, SENT/FAILED/
 * RETRYABLE solo después de una respuesta real del proveedor (mockeado).
 */

const TEST_PREFIX = "F17-EMAIL-TEST";
const createdTenantIds: string[] = [];

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  return tenant.id;
}

after(async () => {
  if (createdTenantIds.length) {
    await prisma.emailMessage.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

function fakeProvider(overrides: Partial<MicrosoftGraphProviderPort> = {}): MicrosoftGraphProviderPort {
  return {
    sendGraphMail: async () => ({ kind: "sent", providerMessageId: "fake-id", conversationId: "fake-conv" }) as SendGraphMailResult,
    ...overrides,
  };
}

const FAKE_AZURE = { azureTenantId: "fake-tenant", azureClientId: "fake-client", azureClientSecret: "fake-secret" };

test("sendEmail: camino feliz -- crea EmailMessage PENDING y lo actualiza a SENT con messageId/conversationId reales del proveedor", async () => {
  const tenantId = await setupTenant("happy-path");
  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    sendEmail({
      senderProfile: "commercial",
      to: "prospect@example.com",
      subject: "Test subject",
      bodyText: "Test body",
      graphProvider: fakeProvider(),
      ...FAKE_AZURE,
    }),
  );

  assert.equal(result.status, "SENT");
  assert.equal(result.providerMessageId, "fake-id");

  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.emailMessageId } });
  assert.equal(row.status, "SENT");
  assert.equal(row.fromEmail, "sales@dreistaff.com");
  assert.equal(row.fromName, "DreiStaff Sales");
  assert.equal(row.toEmail, "prospect@example.com");
  assert.equal(row.senderProfile, "COMMERCIAL");
  assert.equal(row.providerMessageId, "fake-id");
  assert.equal(row.conversationId, "fake-conv");
  assert.ok(row.sentAt);
});

test("sendEmail: el proveedor falla (403 ErrorSendAsDenied) -- EmailMessage queda FAILED con el motivo real, NUNCA se marca SENT", async () => {
  const tenantId = await setupTenant("failed");
  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    sendEmail({
      senderProfile: "commercial",
      to: "prospect@example.com",
      subject: "Test",
      bodyText: "Test",
      graphProvider: fakeProvider({
        sendGraphMail: async () => ({ kind: "failed", reason: "create message: HTTP 403 (ErrorSendAsDenied)", retryable: false, httpStatus: 403, providerStatus: "UNAUTHORIZED" }),
      }),
      ...FAKE_AZURE,
    }),
  );

  assert.equal(result.status, "FAILED");
  assert.match(result.errorMessage ?? "", /ErrorSendAsDenied/);

  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.emailMessageId } });
  assert.equal(row.status, "FAILED");
  assert.match(row.errorMessage ?? "", /ErrorSendAsDenied/);
  assert.equal(row.sentAt, null);
  assert.equal(row.providerMessageId, null);
});

test("sendEmail: error transitorio (429/5xx) -- EmailMessage queda RETRYABLE, nunca FAILED permanente ni SENT", async () => {
  const tenantId = await setupTenant("retryable");
  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    sendEmail({
      senderProfile: "commercial",
      to: "prospect@example.com",
      subject: "Test",
      bodyText: "Test",
      graphProvider: fakeProvider({
        sendGraphMail: async () => ({ kind: "failed", reason: "send message msg-1: HTTP 503", retryable: true, httpStatus: 503, providerStatus: "UNAVAILABLE" }),
      }),
      ...FAKE_AZURE,
    }),
  );

  assert.equal(result.status, "RETRYABLE");
  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.emailMessageId } });
  assert.equal(row.status, "RETRYABLE");
});

test("sendEmail: Microsoft Graph no configurado -- falla honestamente ANTES de intentar, EmailMessage queda FAILED con el motivo real", async () => {
  const tenantId = await setupTenant("not-configured");
  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    sendEmail({
      senderProfile: "commercial",
      to: "prospect@example.com",
      subject: "Test",
      bodyText: "Test",
      graphProvider: fakeProvider(),
      azureTenantId: "",
      azureClientId: "",
      azureClientSecret: "",
    }),
  );

  assert.equal(result.status, "FAILED");
  assert.match(result.errorMessage ?? "", /no configurado/);
  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.emailMessageId } });
  assert.equal(row.status, "FAILED");
});

test("sendEmail: destinatario con formato inválido -- rechazado ANTES de crear cualquier fila ni llamar al proveedor", async () => {
  const tenantId = await setupTenant("invalid-recipient");
  let providerCalled = false;
  await assert.rejects(
    runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
      sendEmail({
        senderProfile: "commercial",
        to: "not-an-email",
        subject: "Test",
        bodyText: "Test",
        graphProvider: fakeProvider({ sendGraphMail: async () => { providerCalled = true; return { kind: "sent", providerMessageId: "x", conversationId: null }; } }),
        ...FAKE_AZURE,
      }),
    ),
  );
  assert.equal(providerCalled, false);
});

test("sendEmail: 'general' sin MAIL_FROM configurado -- FAILED honesto, NUNCA cae a sales@ ni a ningún otro remitente en su lugar", async () => {
  const tenantId = await setupTenant("general-unconfigured");
  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    sendEmail({
      senderProfile: "general",
      to: "someone@example.com",
      subject: "Test",
      bodyText: "Test",
      graphProvider: fakeProvider(),
      ...FAKE_AZURE,
    }),
  );

  assert.equal(result.status, "FAILED");
  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.emailMessageId } });
  assert.notEqual(row.fromEmail, "sales@dreistaff.com");
  assert.equal(row.status, "FAILED");
});

test("sendEmail: guarda los vínculos reales (leadId/opportunityId/companyId/contactId/approvalRequestId) cuando se pasan", async () => {
  const tenantId = await setupTenant("linked");
  const result = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    sendEmail({
      senderProfile: "commercial",
      to: "prospect@example.com",
      subject: "Test",
      bodyText: "Test",
      leadId: "fake-lead-id",
      opportunityId: "fake-opp-id",
      companyId: "fake-company-id",
      contactId: "fake-contact-id",
      approvalRequestId: "fake-approval-id",
      graphProvider: fakeProvider(),
      ...FAKE_AZURE,
    }),
  );

  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.emailMessageId } });
  assert.equal(row.leadId, "fake-lead-id");
  assert.equal(row.opportunityId, "fake-opp-id");
  assert.equal(row.companyId, "fake-company-id");
  assert.equal(row.contactId, "fake-contact-id");
  assert.equal(row.approvalRequestId, "fake-approval-id");
});
