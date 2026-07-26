import { test, after } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { prisma } from "@ai-staffing-os/db";
import {
  agentSuccess,
  agentFailure,
  AgentError,
  buildEventEnvelope,
  type AgentErrorCategory,
  type AgentExecutor,
  type AgentExecutionContext,
} from "@ai-staffing-os/agents";
import { Orchestrator } from "./orchestrator";

/**
 * F25.2 Fase 4: pruebas de integración contra Postgres real (local) del
 * Orchestrator -- claim real (Fase 3), transición de estado real
 * (Fase 1), outbox real (Fase 2). Los AgentExecutor de estas pruebas son
 * 100% sintéticos (nunca tocan red/LLM/proveedores reales) -- coincide
 * con "no ejecutar acciones externas todavía": el Orchestrator en sí no
 * tiene ningún ejecutor real registrado hasta Fase 6/7/8.
 */

const TEST_PREFIX = "F25-2-ORCH";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.domainEvent.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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

async function createTask(tenantId: string, agentInstanceId: string, type: string, input: unknown = {}) {
  return prisma.agentTask.create({
    data: { tenantId, agentInstanceId, type, input: input as never, status: "QUEUED", triggeredBy: "AGENT", correlationId: `mission_${type}_test` },
  });
}

const echoInputSchema = z.object({ value: z.string() });

function echoExecutor(): AgentExecutor<z.infer<typeof echoInputSchema>, { echoed: string }> {
  return {
    taskType: "echo_test_task",
    stage: "DISCOVERY",
    inputSchema: echoInputSchema,
    execute: async (context: AgentExecutionContext, input) => {
      const event = buildEventEnvelope({
        eventType: "company.discovered.v1",
        tenantId: context.tenantId,
        correlationId: context.correlationId,
        causationId: context.causationId,
        actorType: "AGENT",
        actorId: context.agentInstanceId,
        entityType: "company",
        entityId: "company_orchestrator_test",
        payload: { echoed: input.value },
        idempotencyKey: `orch-test-${context.taskId}`,
      });
      return agentSuccess({ echoed: input.value }, [event]);
    },
  };
}

function alwaysFailExecutor(taskType: string, category: AgentErrorCategory): AgentExecutor {
  return {
    taskType,
    stage: "DISCOVERY",
    inputSchema: z.unknown(),
    execute: async () => agentFailure(new AgentError(category, `falla sintética (${category})`)),
  };
}

test("runOnce sin ejecutores registrados no reclama nada", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("no-executors");
  const task = await createTask(tenantId, agentInstanceId, "echo_test_task", { value: "x" });

  const orchestrator = new Orchestrator();
  const metrics = await orchestrator.runOnce("worker-1", 10);

  assert.equal(metrics.claimed, 0);
  const reloaded = await prisma.agentTask.findFirstOrThrow({ where: { tenantId } });
  assert.equal(reloaded.status, "QUEUED", "sin ejecutor registrado, la tarea ni se toca");

  // Queda QUEUED a propósito (para esta prueba) -- se limpia para no
  // contaminar el claim cross-tenant de tests posteriores que SÍ
  // registran un executor real para "echo_test_task".
  await prisma.agentTask.delete({ where: { id: task.id } });
});

test("runOnce ejecuta un AgentExecutor exitoso: completa la tarea y publica sus eventos", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("success");
  const task = await createTask(tenantId, agentInstanceId, "echo_test_task", { value: "hola" });

  const orchestrator = new Orchestrator();
  orchestrator.registerExecutor(echoExecutor());
  const metrics = await orchestrator.runOnce("worker-1", 10);

  assert.equal(metrics.claimed, 1);
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.eventsPublished, 1);

  const updated = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(updated.status, "DONE");
  assert.deepEqual(updated.output, { echoed: "hola" });

  const events = await prisma.domainEvent.findMany({ where: { tenantId } });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "company.discovered.v1");
});

test("runOnce no reclama tareas de tipos sin executor registrado", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("unregistered-type");
  await createTask(tenantId, agentInstanceId, "some_other_task", {});

  const orchestrator = new Orchestrator();
  orchestrator.registerExecutor(echoExecutor());
  const metrics = await orchestrator.runOnce("worker-1", 10);

  assert.equal(metrics.claimed, 0);
  const task = await prisma.agentTask.findFirstOrThrow({ where: { tenantId } });
  assert.equal(task.status, "QUEUED");
});

test("runOnce con falla retryable programa reintento, sin publicar eventos", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("retryable");
  const task = await createTask(tenantId, agentInstanceId, "flaky_task", {});

  const orchestrator = new Orchestrator();
  orchestrator.registerExecutor(alwaysFailExecutor("flaky_task", "RETRYABLE_PROVIDER"));
  const metrics = await orchestrator.runOnce("worker-1", 10);

  assert.equal(metrics.retried, 1);
  assert.equal(metrics.eventsPublished, 0);

  const updated = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(updated.status, "RETRY_SCHEDULED");
});

test("runOnce con falla POLICY_BLOCKED marca la tarea BLOCKED", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("blocked");
  const task = await createTask(tenantId, agentInstanceId, "policy_task", {});

  const orchestrator = new Orchestrator();
  orchestrator.registerExecutor(alwaysFailExecutor("policy_task", "POLICY_BLOCKED"));
  const metrics = await orchestrator.runOnce("worker-1", 10);

  assert.equal(metrics.blocked, 1);
  const updated = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(updated.status, "BLOCKED");
});

test("runOnce con falla HUMAN_ACTION_REQUIRED marca la tarea HUMAN_REVIEW", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("human-review");
  const task = await createTask(tenantId, agentInstanceId, "ambiguous_task", {});

  const orchestrator = new Orchestrator();
  orchestrator.registerExecutor(alwaysFailExecutor("ambiguous_task", "HUMAN_ACTION_REQUIRED"));
  const metrics = await orchestrator.runOnce("worker-1", 10);

  assert.equal(metrics.humanReview, 1);
  const updated = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(updated.status, "HUMAN_REVIEW");
});

test("runOnce renueva el lease (heartbeat) mientras un executor real sigue en vuelo más allá del lease original", async () => {
  // Bug real encontrado en auditoría: heartbeatTask (Fase 1) nunca se
  // llamaba desde ningún camino de producción. Con un lease corto (200ms)
  // y un executor que tarda 500ms, sin heartbeat el lease habría
  // expirado ~300ms antes de que execute() termine -- acá se verifica en
  // vivo, a mitad de la ejecución, que leaseExpiresAt sigue en el futuro.
  const { tenantId, agentInstanceId } = await setupTenant("heartbeat");
  const task = await createTask(tenantId, agentInstanceId, "slow_task", {});
  const leaseMs = 200;

  // Objeto holder, no una variable local -- TS no puede probar que el
  // closure de `execute` corrió antes de las lecturas de abajo, así que
  // narrowing sobre una `let` capturada colapsaría el tipo a `null`
  // incorrectamente; una propiedad de objeto no sufre ese narrowing.
  const midFlight: { leaseExpiresAt: Date | null; checkTime: number } = { leaseExpiresAt: null, checkTime: 0 };
  const orchestrator = new Orchestrator();
  orchestrator.registerExecutor({
    taskType: "slow_task",
    stage: "DISCOVERY",
    inputSchema: z.unknown(),
    execute: async () => {
      await new Promise((r) => setTimeout(r, 350));
      const reloaded = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
      midFlight.leaseExpiresAt = reloaded.leaseExpiresAt;
      midFlight.checkTime = Date.now(); // capturado en el mismo instante -- nunca comparar contra un Date.now() evaluado después
      await new Promise((r) => setTimeout(r, 200));
      return agentSuccess({ ok: true });
    },
  });

  const metrics = await orchestrator.runOnce("worker-1", 10, leaseMs);

  assert.equal(metrics.completed, 1, "el heartbeat nunca debe impedir que la tarea complete normalmente");
  if (!midFlight.leaseExpiresAt) throw new Error("el lease debía seguir activo (no nulo) 350ms después de un lease de 200ms");
  assert.ok(
    midFlight.leaseExpiresAt.getTime() > midFlight.checkTime,
    "heartbeatTask debe haber renovado leaseExpiresAt más allá del lease original, medido en el instante en que se leyó",
  );

  const updated = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(updated.status, "DONE");
});

test("runOnce con input que no cumple el schema del executor falla sin invocar execute()", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("bad-input");
  const task = await createTask(tenantId, agentInstanceId, "echo_test_task", { value: 123 }); // debería ser string

  let executeCalled = false;
  const orchestrator = new Orchestrator();
  orchestrator.registerExecutor({
    ...echoExecutor(),
    execute: async (ctx, input) => {
      executeCalled = true;
      return agentSuccess({ echoed: String((input as { value: string }).value) });
    },
  });
  const metrics = await orchestrator.runOnce("worker-1", 10);

  assert.equal(executeCalled, false, "un input inválido nunca debe llegar a execute()");
  assert.equal(metrics.failed, 1);
  const updated = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(updated.status, "FAILED");
});
