import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { buildEventEnvelope } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../tenancy/context";
import { publishEvent } from "./outbox";
import { EventDispatcher } from "./dispatcher";

/**
 * F25.2 (consolidación): pruebas de integración contra Postgres real
 * del worker de procesamiento de eventos.
 */

const TEST_PREFIX = "F25-2-DISPATCHER";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.domainEvent.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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
  return runWithTenancyContext({ tenantId, userId: "test", permissions: [] }, fn);
}

function envelope(tenantId: string, eventType: string, overrides: Partial<Parameters<typeof buildEventEnvelope>[0]> = {}) {
  return buildEventEnvelope({
    eventType,
    tenantId,
    correlationId: "mission_dispatcher_test",
    causationId: null,
    actorType: "AGENT",
    actorId: "agentinstance_test",
    entityType: "company",
    entityId: "company_dispatcher_test",
    payload: {},
    idempotencyKey: `dispatcher-test-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  });
}

test("runOnce sin handlers registrados marca los eventos como processed (nadie necesita reaccionar todavía)", async () => {
  const tenantId = await setupTenant("no-handlers");
  await withTenant(tenantId, () => publishEvent(envelope(tenantId, "company.discovered.v1")));

  const dispatcher = new EventDispatcher();
  const metrics = await dispatcher.runOnce(100);

  assert.ok(metrics.claimed >= 1);
  assert.ok(metrics.processed >= 1);
  assert.equal(metrics.failed, 0);

  const remaining = await prisma.domainEvent.count({ where: { tenantId, processedAt: null } });
  assert.equal(remaining, 0);
});

test("runOnce despacha únicamente a los handlers registrados para el eventType correcto", async () => {
  const tenantId = await setupTenant("dispatch-correct-type");
  await withTenant(tenantId, () => publishEvent(envelope(tenantId, "company.discovered.v1")));
  await withTenant(tenantId, () => publishEvent(envelope(tenantId, "contact.discovered.v1")));

  const seenByCompanyHandler: string[] = [];
  const seenByContactHandler: string[] = [];
  const dispatcher = new EventDispatcher();
  dispatcher.registerHandler("company.discovered.v1", async (event) => {
    seenByCompanyHandler.push(event.id);
  });
  dispatcher.registerHandler("contact.discovered.v1", async (event) => {
    seenByContactHandler.push(event.id);
  });

  await dispatcher.runOnce(100);

  assert.equal(seenByCompanyHandler.length, 1);
  assert.equal(seenByContactHandler.length, 1);
});

test("runOnce marca failed cuando un handler lanza, y el evento queda reclamable de nuevo (replay)", async () => {
  const tenantId = await setupTenant("handler-throws");
  const { event } = await withTenant(tenantId, () => publishEvent(envelope(tenantId, "company.discovered.v1")));

  const dispatcher = new EventDispatcher();
  dispatcher.registerHandler("company.discovered.v1", async () => {
    throw new Error("503 Service Unavailable (handler sintético)");
  });

  const metrics = await dispatcher.runOnce(100);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.processed, 0);

  const reloaded = await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
  assert.equal(reloaded.processedAt, null, "sigue sin procesar -- replay seguro, el próximo runOnce lo reintenta");
  assert.equal(reloaded.lastErrorCode, "RETRYABLE_PROVIDER");
});

test("runOnce recupera un evento que falló antes: reintentado y marcado processed en la siguiente corrida", async () => {
  const tenantId = await setupTenant("eventual-success");
  const { event } = await withTenant(tenantId, () => publishEvent(envelope(tenantId, "company.discovered.v1")));

  let attempts = 0;
  const dispatcher = new EventDispatcher();
  dispatcher.registerHandler("company.discovered.v1", async (claimedEvent) => {
    if (claimedEvent.id !== event.id) return; // ignora ruido cross-tenant de otros tests (el dispatcher es cross-tenant a propósito)
    attempts += 1;
    if (attempts === 1) throw new Error("falla la primera vez");
  });

  await dispatcher.runOnce(100);
  let reloaded = await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
  assert.equal(reloaded.processedAt, null);

  await dispatcher.runOnce(100);
  reloaded = await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
  assert.ok(reloaded.processedAt, "la segunda corrida procesa el evento exitosamente");
  assert.equal(attempts, 2);
});
