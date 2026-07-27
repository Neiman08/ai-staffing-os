import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { AgentError } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../core/tenancy/context";
import {
  claimTask,
  startTask,
  heartbeatTask,
  recordTaskSuccess,
  recordTaskFailure,
  cancelTask,
  reclaimExpiredLease,
} from "./task-lifecycle";

/**
 * F25.2 Fase 1: pruebas de integración contra Postgres real (local) del
 * ciclo de vida durable de AgentTask -- lease, heartbeat, reintentos con
 * clasificación de error, cancelación, estados terminales (FAILED/
 * BLOCKED/HUMAN_REVIEW/CANCELED/DONE) y correlación. Cada test corre en
 * su propio tenant sintético (mismo patrón que discovery-conversion.
 * integration.test.ts) para no interferir entre corridas concurrentes.
 */

const TEST_PREFIX = "F25-2-LIFECYCLE";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupTenant(suffix: string): Promise<{ tenantId: string; agentInstanceId: string }> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  createdTenantIds.push(tenant.id);
  const discoveryDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "discovery" } });
  const instance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: discoveryDefinition.id, isActive: true } });
  return { tenantId: tenant.id, agentInstanceId: instance.id };
}

async function createTask(
  tenantId: string,
  agentInstanceId: string,
  overrides: Partial<{ status: "QUEUED" | "CLAIMED" | "RUNNING" | "RETRY_SCHEDULED"; maxAttempts: number; correlationId: string; causationId: string }> = {},
) {
  return prisma.agentTask.create({
    data: {
      tenantId,
      agentInstanceId,
      type: "score_company",
      input: {},
      status: overrides.status ?? "QUEUED",
      triggeredBy: "AGENT",
      maxAttempts: overrides.maxAttempts,
      correlationId: overrides.correlationId,
      causationId: overrides.causationId,
    },
  });
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenancyContext({ tenantId, userId: "system-test", permissions: [] }, fn);
}

test("claimTask reclama una tarea QUEUED, setea lease y worker", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("claim-ok");
  const task = await createTask(tenantId, agentInstanceId);

  const claimed = await withTenant(tenantId, () => claimTask(task.id, "worker-1", 60_000));

  assert.equal(claimed.status, "CLAIMED");
  assert.equal(claimed.claimedBy, "worker-1");
  assert.ok(claimed.claimedAt);
  assert.ok(claimed.leaseExpiresAt);
  assert.ok(claimed.leaseExpiresAt!.getTime() > Date.now());
});

test("claimTask rechaza una tarea en un estado no reclamable", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("claim-reject");
  const task = await createTask(tenantId, agentInstanceId);
  await prisma.agentTask.update({ where: { id: task.id }, data: { status: "DONE", completedAt: new Date() } });

  await assert.rejects(() => withTenant(tenantId, () => claimTask(task.id, "worker-1")), /no es reclamable/);
});

test("startTask mueve CLAIMED -> RUNNING solo para el worker dueño del lease", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("start");
  const task = await createTask(tenantId, agentInstanceId);
  await withTenant(tenantId, () => claimTask(task.id, "worker-1"));

  await assert.rejects(() => withTenant(tenantId, () => startTask(task.id, "worker-otro")), /no está reclamada por worker/);

  const started = await withTenant(tenantId, () => startTask(task.id, "worker-1"));
  assert.equal(started.status, "RUNNING");
});

test("heartbeatTask renueva el lease y hace fencing por workerId", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("heartbeat");
  const task = await createTask(tenantId, agentInstanceId);
  const claimed = await withTenant(tenantId, () => claimTask(task.id, "worker-1", 1_000));

  await new Promise((resolve) => setTimeout(resolve, 5));
  const renewed = await withTenant(tenantId, () => heartbeatTask(task.id, "worker-1", 120_000));
  assert.ok(renewed.leaseExpiresAt!.getTime() > claimed.leaseExpiresAt!.getTime());

  await assert.rejects(() => withTenant(tenantId, () => heartbeatTask(task.id, "worker-impostor")), /no tiene un lease activo/);
});

test("recordTaskSuccess completa la tarea y limpia el lease", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("success");
  const task = await createTask(tenantId, agentInstanceId);
  await withTenant(tenantId, () => claimTask(task.id, "worker-1"));
  await withTenant(tenantId, () => startTask(task.id, "worker-1"));

  const done = await withTenant(tenantId, () => recordTaskSuccess(task.id, { ok: true }, { tokensUsed: 42, costUsd: 0.01 }));

  assert.equal(done.status, "DONE");
  assert.equal(done.claimedBy, null);
  assert.equal(done.leaseExpiresAt, null);
  assert.ok(done.completedAt);
  assert.equal(done.tokensUsed, 42);
});

test("recordTaskFailure con error retryable programa un reintento con backoff y attempt++", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("retry");
  const task = await createTask(tenantId, agentInstanceId, { maxAttempts: 3 });
  await withTenant(tenantId, () => claimTask(task.id, "worker-1"));

  const { task: updated, category, retryScheduled } = await withTenant(tenantId, () =>
    recordTaskFailure(task.id, new AgentError("RETRYABLE_PROVIDER", "503 Service Unavailable")),
  );

  assert.equal(category, "RETRYABLE_PROVIDER");
  assert.equal(retryScheduled, true);
  assert.equal(updated.status, "RETRY_SCHEDULED");
  assert.equal(updated.attempt, 1);
  assert.equal(updated.lastErrorCategory, "RETRYABLE_PROVIDER");
  assert.ok(updated.nextAttemptAt);
  assert.ok(updated.nextAttemptAt!.getTime() > Date.now(), "el backoff debe programar el reintento en el futuro");
  assert.equal(updated.claimedBy, null, "el lease se libera al programar el reintento");
});

test("recordTaskFailure retryable que agota maxAttempts termina en FAILED (estado muerto), nunca reintento infinito", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("exhausted");
  const task = await createTask(tenantId, agentInstanceId, { maxAttempts: 1 });
  await withTenant(tenantId, () => claimTask(task.id, "worker-1"));

  const { task: updated, retryScheduled } = await withTenant(tenantId, () =>
    recordTaskFailure(task.id, new AgentError("RETRYABLE_NETWORK", "ECONNRESET")),
  );

  assert.equal(retryScheduled, false);
  assert.equal(updated.status, "FAILED");
  assert.equal(updated.nextAttemptAt, null);
});

test("recordTaskFailure con POLICY_BLOCKED termina en BLOCKED y nunca reintenta", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("blocked");
  const task = await createTask(tenantId, agentInstanceId, { maxAttempts: 5 });
  await withTenant(tenantId, () => claimTask(task.id, "worker-1"));

  const { task: updated, retryScheduled } = await withTenant(tenantId, () =>
    recordTaskFailure(task.id, new AgentError("POLICY_BLOCKED", "PolicyEnvelope prohíbe SEND_EMAIL")),
  );

  assert.equal(retryScheduled, false);
  assert.equal(updated.status, "BLOCKED");
  assert.equal(updated.attempt, 0, "una falla no-retryable nunca incrementa attempt");
});

test("recordTaskFailure con HUMAN_ACTION_REQUIRED termina en HUMAN_REVIEW", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("human-review");
  const task = await createTask(tenantId, agentInstanceId);
  await withTenant(tenantId, () => claimTask(task.id, "worker-1"));

  const { task: updated } = await withTenant(tenantId, () =>
    recordTaskFailure(task.id, new AgentError("HUMAN_ACTION_REQUIRED", "Ambiguo: requiere decisión humana")),
  );

  assert.equal(updated.status, "HUMAN_REVIEW");
});

test("cancelTask cancela una tarea no-terminal; una tarea terminal no puede cancelarse ni reclamarse de nuevo", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("cancel");
  const task = await createTask(tenantId, agentInstanceId);
  await withTenant(tenantId, () => claimTask(task.id, "worker-1"));

  const canceled = await withTenant(tenantId, () => cancelTask(task.id, "user-123", "Misión padre cancelada"));
  assert.equal(canceled.status, "CANCELED");
  assert.equal(canceled.canceledBy, "user-123");
  assert.ok(canceled.canceledAt);

  await assert.rejects(() => withTenant(tenantId, () => cancelTask(task.id, "user-123")), /ya está en un estado terminal/);
  await assert.rejects(() => withTenant(tenantId, () => claimTask(task.id, "worker-2")), /no es reclamable/);
});

test("reclaimExpiredLease recupera una tarea con lease vencido (worker muerto) y programa reintento", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("reclaim");
  const task = await createTask(tenantId, agentInstanceId, { maxAttempts: 3 });
  await withTenant(tenantId, () => claimTask(task.id, "worker-1", 1));
  await withTenant(tenantId, () => startTask(task.id, "worker-1"));

  await new Promise((resolve) => setTimeout(resolve, 10));

  const { task: reclaimed, retryScheduled } = await withTenant(tenantId, () => reclaimExpiredLease(task.id));
  assert.equal(retryScheduled, true);
  assert.equal(reclaimed.status, "RETRY_SCHEDULED");
  assert.equal(reclaimed.lastErrorCategory, "RETRYABLE_TIMEOUT");
});

test("reclaimExpiredLease rechaza una tarea cuyo lease todavía está vigente", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("reclaim-reject");
  const task = await createTask(tenantId, agentInstanceId);
  await withTenant(tenantId, () => claimTask(task.id, "worker-1", 120_000));

  await assert.rejects(() => withTenant(tenantId, () => reclaimExpiredLease(task.id)), /todavía tiene un lease vigente/);
});

test("correlationId y causationId se persisten en la creación de la tarea (trazabilidad de misión)", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("correlation");
  const task = await createTask(tenantId, agentInstanceId, { correlationId: "mission_abc", causationId: "event_xyz" });

  assert.equal(task.correlationId, "mission_abc");
  assert.equal(task.causationId, "event_xyz");
});
