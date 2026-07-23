import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { buildEventEnvelope } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../tenancy/context";
import { publishEvent, claimUnprocessedEvents, markEventProcessed, markEventFailed } from "./outbox";

/**
 * F25.2 Fase 2: pruebas de integración contra Postgres real (local) del
 * outbox -- persistencia, idempotencia real (constraint de DB, no
 * convención de aplicación), reclamo concurrente-seguro (SKIP LOCKED,
 * mismo mecanismo que ADR-0001 propone para AgentTask en Fase 3) y
 * replay seguro tras una falla.
 */

const TEST_PREFIX = "F25-2-OUTBOX";
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
  return runWithTenancyContext({ tenantId, userId: "system-test", permissions: [] }, fn);
}

function envelope(tenantId: string, overrides: Partial<Parameters<typeof buildEventEnvelope>[0]> = {}) {
  return buildEventEnvelope({
    eventType: "company.discovered.v1",
    tenantId,
    correlationId: "mission_outbox_test",
    causationId: null,
    actorType: "AGENT",
    actorId: "agentinstance_discovery_test",
    entityType: "company",
    entityId: "company_outbox_test",
    payload: { companyId: "company_outbox_test", origin: "API_PROVIDER" },
    idempotencyKey: `outbox-test-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  });
}

test("publishEvent persiste una fila real con las columnas de ADR-0002", async () => {
  const tenantId = await setupTenant("publish");
  const env = envelope(tenantId);

  const { event, wasAlreadyPublished } = await withTenant(tenantId, () => publishEvent(env));

  assert.equal(wasAlreadyPublished, false);
  assert.equal(event.tenantId, tenantId);
  assert.equal(event.type, "company.discovered.v1");
  assert.equal(event.correlationId, "mission_outbox_test");
  assert.equal(event.idempotencyKey, env.idempotencyKey);
  assert.deepEqual(event.payload, env.payload);
  assert.equal(event.processedAt, null);
  assert.equal(event.attempt, 0);
});

test("publishEvent es idempotente: el mismo idempotencyKey nunca crea una segunda fila", async () => {
  const tenantId = await setupTenant("idempotent");
  const key = `outbox-idem-${Date.now()}`;
  const env = envelope(tenantId, { idempotencyKey: key });

  const first = await withTenant(tenantId, () => publishEvent(env));
  const second = await withTenant(tenantId, () => publishEvent(envelope(tenantId, { idempotencyKey: key, entityId: "company_other" })));

  assert.equal(first.wasAlreadyPublished, false);
  assert.equal(second.wasAlreadyPublished, true);
  assert.equal(second.event.id, first.event.id);

  const rows = await prisma.domainEvent.findMany({ where: { idempotencyKey: key } });
  assert.equal(rows.length, 1, "el constraint único de la DB garantiza una sola fila, no una convención de aplicación");
});

test("claimUnprocessedEvents reclama eventos no procesados por antigüedad e incrementa attempt", async () => {
  const tenantId = await setupTenant("claim");
  const first = await withTenant(tenantId, () => publishEvent(envelope(tenantId)));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await withTenant(tenantId, () => publishEvent(envelope(tenantId)));

  const claimed = await claimUnprocessedEvents(100);
  const claimedIds = claimed.map((e) => e.id);

  assert.ok(claimedIds.includes(first.event.id));
  assert.ok(claimedIds.includes(second.event.id));

  const reloaded = await prisma.domainEvent.findUniqueOrThrow({ where: { id: first.event.id } });
  assert.equal(reloaded.attempt, 1);
});

test("claimUnprocessedEvents no reclama eventos ya procesados", async () => {
  const tenantId = await setupTenant("claim-processed");
  const { event } = await withTenant(tenantId, () => publishEvent(envelope(tenantId)));
  await markEventProcessed(event.id);

  const claimed = await claimUnprocessedEvents(1000);
  assert.ok(!claimed.some((e) => e.id === event.id));
});

test("markEventFailed deja el evento reclamable (replay seguro) y clasifica el error", async () => {
  const tenantId = await setupTenant("failed-replay");
  const { event } = await withTenant(tenantId, () => publishEvent(envelope(tenantId)));

  await claimUnprocessedEvents(1000); // primer intento -- se "pierde" (simula un consumer que crashea)
  await markEventFailed(event.id, new Error("503 Service Unavailable (proveedor sintético)"));

  const afterFailure = await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
  assert.equal(afterFailure.processedAt, null, "sigue sin procesar -- el próximo poll lo reclama de nuevo");
  assert.equal(afterFailure.lastErrorCode, "RETRYABLE_PROVIDER");
  assert.ok(afterFailure.lastErrorAt);

  const reclaimed = await claimUnprocessedEvents(1000);
  assert.ok(reclaimed.some((e) => e.id === event.id), "replay real: el evento fallido vuelve a salir en el siguiente poll");

  await markEventProcessed(event.id);
  const done = await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
  assert.ok(done.processedAt, "eventualmente se completa -- el replay no queda atascado para siempre");
});

test("claimUnprocessedEvents respeta el LIMIT exacto (regresión: UPDATE...WHERE id IN (SELECT...LIMIT...FOR UPDATE SKIP LOCKED) ignora el LIMIT cuando la subquery referencia la misma tabla -- el fix real es un CTE)", async () => {
  const tenantId = await setupTenant("limit-respected");
  for (let i = 0; i < 10; i++) {
    await withTenant(tenantId, () => publishEvent(envelope(tenantId, { idempotencyKey: `outbox-limit-${tenantId}-${i}` })));
  }

  const claimed = await claimUnprocessedEvents(4);
  assert.equal(claimed.length, 4, "LIMIT 4 debe reclamar exactamente 4, nunca las 10 disponibles");
});

/**
 * Cubre la garantía REAL que la arquitectura actual promete (ADR-0003:
 * un único Orchestrator in-process, sin lease en DomainEvent -- ver el
 * comentario de claimUnprocessedEvents en outbox.ts). Un loop
 * secuencial claim -> marcar cada evento -> siguiente poll debe
 * procesar cada evento disponible EXACTAMENTE una vez, sin perder
 * ninguno y sin reprocesar ninguno ya marcado. Esto NO prueba
 * seguridad bajo pollers concurrentes reales (esa garantía, con lease,
 * es explícitamente de Fase 3/AgentTask) -- probarlo igual sería
 * afirmar algo que el diseño de hoy no cumple.
 */
test("dispatcher secuencial: un loop claim->marcar procesa cada evento disponible exactamente una vez", async () => {
  const tenantId = await setupTenant("sequential-dispatch");
  const M = 9;
  for (let i = 0; i < M; i++) {
    await withTenant(tenantId, () => publishEvent(envelope(tenantId, { idempotencyKey: `outbox-seq-${tenantId}-${i}` })));
  }

  const processedIds: string[] = [];
  for (let round = 0; round < 20; round++) {
    const claimed = await claimUnprocessedEvents(4);
    const ours = claimed.filter((e) => e.tenantId === tenantId);
    const remaining = await prisma.domainEvent.count({ where: { tenantId, processedAt: null } });
    if (ours.length === 0 && remaining === 0) break;
    for (const event of ours) {
      processedIds.push(event.id);
      await markEventProcessed(event.id);
    }
  }

  assert.equal(processedIds.length, new Set(processedIds).size, "ningún evento se procesó dos veces en el loop secuencial");
  assert.equal(processedIds.length, M, "los M eventos del tenant se procesaron todos");

  const stillUnprocessed = await prisma.domainEvent.count({ where: { tenantId, processedAt: null } });
  assert.equal(stillUnprocessed, 0);
});
