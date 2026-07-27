import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { checkSendLimits } from "./send-limits";

/**
 * F26 (primer piloto de outreach real): checkSendLimits contra Postgres
 * real -- ambas guardas (límite diario, duplicado de destinatario) se
 * apoyan en filas reales de EmailMessage, nunca en un contador en
 * memoria (que no sobreviviría un restart ni sería real entre réplicas).
 */

const TEST_PREFIX = "F26-SEND-LIMITS";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.emailMessage.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  createdTenantIds.push(tenant.id);
  return tenant.id;
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, fn);
}

async function createSentEmail(tenantId: string, toEmail: string, sentAt: Date) {
  await prisma.emailMessage.create({
    data: {
      tenantId,
      senderProfile: "COMMERCIAL",
      fromEmail: "sales@dreistaff.com",
      fromName: "DreiStaff Sales",
      toEmail,
      subject: "s",
      bodyText: "b",
      provider: "microsoft_graph",
      status: "SENT",
      providerMessageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
      sentAt,
    },
  });
}

test("checkSendLimits: permite el envío cuando no hay envíos previos hoy ni al mismo destinatario", async () => {
  const tenantId = await setupTenant("allowed");
  const result = await withTenant(tenantId, () => checkSendLimits("nuevo@example.com"));
  assert.equal(result.allowed, true);
  assert.equal(result.reason, null);
});

test("checkSendLimits: bloquea un segundo envío real al mismo destinatario (prevención de duplicados)", async () => {
  const tenantId = await setupTenant("dedup");
  await createSentEmail(tenantId, "repetido@example.com", new Date());

  const result = await withTenant(tenantId, () => checkSendLimits("repetido@example.com"));
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /ya se envió/i);

  // Case-insensitive -- nunca se permite por una diferencia de mayúsculas.
  const resultUpper = await withTenant(tenantId, () => checkSendLimits("REPETIDO@example.com"));
  assert.equal(resultUpper.allowed, false);
});

test("checkSendLimits: un envío FAILED anterior (nunca SENT) al mismo destinatario no bloquea un reintento real", async () => {
  const tenantId = await setupTenant("failed-not-blocking");
  await prisma.emailMessage.create({
    data: {
      tenantId,
      senderProfile: "COMMERCIAL",
      fromEmail: "sales@dreistaff.com",
      fromName: "DreiStaff Sales",
      toEmail: "reintentar@example.com",
      subject: "s",
      bodyText: "b",
      provider: "microsoft_graph",
      status: "FAILED",
      errorMessage: "mock failure",
    },
  });

  const result = await withTenant(tenantId, () => checkSendLimits("reintentar@example.com"));
  assert.equal(result.allowed, true);
});

test("checkSendLimits: bloquea al alcanzar el límite diario configurado (DAILY_EMAIL_SEND_LIMIT)", async () => {
  const tenantId = await setupTenant("daily-limit");
  const { env } = await import("../../core/env");
  const limit = env.DAILY_EMAIL_SEND_LIMIT;

  const now = new Date();
  for (let i = 0; i < limit; i++) {
    await createSentEmail(tenantId, `destinatario-${i}@example.com`, now);
  }

  const result = await withTenant(tenantId, () => checkSendLimits("uno-mas@example.com"));
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /límite diario/i);
});

test("checkSendLimits: un envío SENT de AYER no cuenta contra el límite de HOY", async () => {
  const tenantId = await setupTenant("daily-limit-reset");
  const { env } = await import("../../core/env");
  const limit = env.DAILY_EMAIL_SEND_LIMIT;

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  for (let i = 0; i < limit; i++) {
    await createSentEmail(tenantId, `ayer-${i}@example.com`, yesterday);
  }

  const result = await withTenant(tenantId, () => checkSendLimits("hoy@example.com"));
  assert.equal(result.allowed, true, "el contador diario se reinicia a medianoche UTC");
});

test("checkSendLimits: aislamiento multi-tenant -- los envíos de un tenant nunca cuentan contra el límite/dedup de otro", async () => {
  const tenantA = await setupTenant("isolation-a");
  const tenantB = await setupTenant("isolation-b");
  await createSentEmail(tenantA, "compartido@example.com", new Date());

  const resultB = await withTenant(tenantB, () => checkSendLimits("compartido@example.com"));
  assert.equal(resultB.allowed, true, "tenant B nunca ve el envío de tenant A como un duplicado propio");
});
