import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../tenancy/context";
import { claimNextTasks, reclaimExpiredLeases } from "./postgres-queue";

/**
 * F25.2 Fase 3: pruebas de integración contra Postgres real (local) de
 * la cola -- claim atómico, prioridad, fairness entre tenants,
 * recuperación de leases vencidos, y el requisito crítico explícito de
 * F25.4 (roadmap): concurrencia real sin overlap ni pérdida.
 */

const TEST_PREFIX = "F25-2-QUEUE";
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
  overrides: Partial<{ type: string; priority: number; status: "QUEUED" | "RETRY_SCHEDULED"; nextAttemptAt: Date | null }> = {},
) {
  return prisma.agentTask.create({
    data: {
      tenantId,
      agentInstanceId,
      type: overrides.type ?? "score_company",
      input: {},
      status: overrides.status ?? "QUEUED",
      triggeredBy: "AGENT",
      priority: overrides.priority ?? 0,
      nextAttemptAt: overrides.nextAttemptAt,
    },
  });
}

test("claimNextTasks reclama tareas QUEUED, setea CLAIMED/lease/claimedBy", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("claim-basic");
  const task = await createTask(tenantId, agentInstanceId);

  const claimed = await claimNextTasks("worker-1", 10, 60_000);
  const mine = claimed.find((t) => t.id === task.id);

  assert.ok(mine, "la tarea recién creada debe salir en el claim");
  assert.equal(mine!.status, "CLAIMED");
  assert.equal(mine!.claimedBy, "worker-1");
  assert.ok(mine!.leaseExpiresAt);
});

test("claimNextTasks respeta prioridad: mayor priority primero dentro del mismo tenant", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("priority");
  const low = await createTask(tenantId, agentInstanceId, { priority: 0 });
  const high = await createTask(tenantId, agentInstanceId, { priority: 10 });

  const claimed = await claimNextTasks("worker-1", 1, 60_000);
  const ours = claimed.filter((t) => t.tenantId === tenantId);

  assert.equal(ours.length, 1);
  assert.equal(ours[0]!.id, high.id, "la tarea de mayor prioridad debe reclamarse antes que la de menor, aunque la de menor sea más vieja");

  // "low" queda QUEUED a propósito (limit=1 la excluyó) -- se limpia acá
  // para no contaminar el ranking cross-tenant de tests posteriores
  // (fairness), que sí depende de qué tenants tienen tareas QUEUED.
  await prisma.agentTask.delete({ where: { id: low.id } });
});

test("claimNextTasks incluye RETRY_SCHEDULED solo cuando nextAttemptAt ya venció", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("retry-window");
  const notYet = await createTask(tenantId, agentInstanceId, { status: "RETRY_SCHEDULED", nextAttemptAt: new Date(Date.now() + 60_000) });
  const ready = await createTask(tenantId, agentInstanceId, { status: "RETRY_SCHEDULED", nextAttemptAt: new Date(Date.now() - 1_000) });

  const claimed = await claimNextTasks("worker-1", 10, 60_000);
  const ids = claimed.map((t) => t.id);

  assert.ok(ids.includes(ready.id));
  assert.ok(!ids.includes(notYet.id), "una tarea cuyo backoff todavía no venció no debe reclamarse");
});

test("claimNextTasks filtra por opts.types cuando se especifica", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("types-filter");
  const scoreTask = await createTask(tenantId, agentInstanceId, { type: "score_company" });
  const draftTask = await createTask(tenantId, agentInstanceId, { type: "draft_outreach" });

  const claimed = await claimNextTasks("worker-1", 10, 60_000, { types: ["score_company"] });
  const ids = claimed.map((t) => t.id);

  assert.ok(ids.includes(scoreTask.id));
  assert.ok(!ids.includes(draftTask.id));

  // draftTask queda QUEUED a propósito (el filtro lo excluyó) -- se
  // limpia para no contaminar el ranking cross-tenant de fairness.
  await prisma.agentTask.delete({ where: { id: draftTask.id } });
});

test("fairness entre tenants: un tenant con muchas tareas no acapara el batch", async () => {
  const busy = await setupTenant("fairness-busy");
  const quiet = await setupTenant("fairness-quiet");

  for (let i = 0; i < 20; i++) await createTask(busy.tenantId, busy.agentInstanceId);
  const quietTask = await createTask(quiet.tenantId, quiet.agentInstanceId);

  const claimed = await claimNextTasks("worker-1", 2, 60_000);
  const claimedTenantIds = claimed.map((t) => t.tenantId);

  assert.ok(claimedTenantIds.includes(quiet.tenantId), "el tenant con una sola tarea debe recibir un turno aunque el otro tenant tenga 20 en cola");
  void quietTask;

  // El resto de las 20 tareas de "busy" queda QUEUED a propósito (para
  // esta prueba) -- se limpia para no distorsionar el ranking
  // cross-tenant de las pruebas de concurrencia que corren después.
  await prisma.agentTask.deleteMany({ where: { tenantId: { in: [busy.tenantId, quiet.tenantId] } } });
});

test("concurrencia: N workers reclamando de la misma tabla -- suma reclamada = M exactamente, sin overlap (5 corridas)", async () => {
  for (let run = 0; run < 5; run++) {
    const { tenantId, agentInstanceId } = await setupTenant(`concurrency-${run}`);
    const M = 15;
    const created = await Promise.all(Array.from({ length: M }, () => createTask(tenantId, agentInstanceId)));
    const createdIds = new Set(created.map((t) => t.id));

    const N = 5;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => claimNextTasks(`worker-${i}`, 4, 60_000, { types: ["score_company"] })));

    const ours = results.flat().filter((t) => t.tenantId === tenantId);
    const oursIds = ours.map((t) => t.id);

    assert.equal(oursIds.length, new Set(oursIds).size, `corrida ${run}: ningún AgentTask reclamado por dos workers a la vez`);
    assert.equal(oursIds.length, M, `corrida ${run}: los M=${M} AgentTask deben reclamarse exactamente una vez entre todos los workers`);
    assert.ok(oursIds.every((id) => createdIds.has(id)));
  }
});

test("reclaimExpiredLeases recupera una tarea con lease vencido y aplica recordTaskFailure (retry por timeout)", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("reclaim");
  const task = await createTask(tenantId, agentInstanceId);
  await runWithTenancyContext({ tenantId, userId: "test", permissions: [] }, () =>
    prisma.agentTask.update({ where: { id: task.id }, data: { status: "RUNNING", claimedAt: new Date(), claimedBy: "dead-worker", leaseExpiresAt: new Date(Date.now() - 1_000) } }),
  );

  const { reclaimedTaskIds } = await reclaimExpiredLeases();
  assert.ok(reclaimedTaskIds.includes(task.id));

  const reloaded = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(reloaded.status, "RETRY_SCHEDULED");
  assert.equal(reloaded.lastErrorCategory, "RETRYABLE_TIMEOUT");
  assert.equal(reloaded.claimedBy, null);
});

test("reclaimExpiredLeases no toca tareas con lease vigente", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("reclaim-active");
  const task = await createTask(tenantId, agentInstanceId);
  await runWithTenancyContext({ tenantId, userId: "test", permissions: [] }, () =>
    prisma.agentTask.update({ where: { id: task.id }, data: { status: "RUNNING", claimedAt: new Date(), claimedBy: "alive-worker", leaseExpiresAt: new Date(Date.now() + 60_000) } }),
  );

  const { reclaimedTaskIds } = await reclaimExpiredLeases();
  assert.ok(!reclaimedTaskIds.includes(task.id));

  const reloaded = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(reloaded.status, "RUNNING");
});
