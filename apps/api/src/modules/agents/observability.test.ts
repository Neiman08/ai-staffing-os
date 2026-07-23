import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { getMissionTimeline, getOrchestratorHealth } from "./observability";

/**
 * F25.2 Fase 9: pruebas de integración contra Postgres real (local) de
 * observabilidad -- reconstruye la timeline a partir de AgentTask/
 * DomainEvent ya existentes (Fase 1/2), sin ninguna tabla nueva.
 */

const TEST_PREFIX = "F25-2-OBSERVABILITY";
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

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenancyContext({ tenantId, userId: "test", permissions: [] }, fn);
}

test("getMissionTimeline mezcla AgentTask y DomainEvent del mismo correlationId, en orden cronológico", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("timeline");
  const correlationId = `mission_${tenantId}`;

  const task = await withTenant(tenantId, () =>
    prisma.agentTask.create({
      data: { tenantId, agentInstanceId, type: "discover_companies", input: {}, status: "DONE", triggeredBy: "AGENT", correlationId },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const event = await withTenant(tenantId, () =>
    prisma.domainEvent.create({
      data: { tenantId, type: "company.discovered.v1", payload: {}, correlationId, causationId: task.id },
    }),
  );

  const timeline = await withTenant(tenantId, () => getMissionTimeline(correlationId));

  assert.equal(timeline.length, 2);
  assert.equal(timeline[0]!.kind, "task");
  assert.equal(timeline[0]!.id, task.id);
  assert.equal(timeline[1]!.kind, "event");
  assert.equal(timeline[1]!.id, event.id);
  assert.equal(timeline[1]!.causationId, task.id, "la cadena de causalidad se conserva");
});

test("getMissionTimeline nunca mezcla entradas de otro correlationId", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("isolation");
  await withTenant(tenantId, () =>
    prisma.agentTask.create({
      data: { tenantId, agentInstanceId, type: "discover_companies", input: {}, status: "DONE", triggeredBy: "AGENT", correlationId: "mission_other" },
    }),
  );

  const timeline = await withTenant(tenantId, () => getMissionTimeline(`mission_${tenantId}_nonexistent`));
  assert.equal(timeline.length, 0);
});

test("getOrchestratorHealth cuenta tasksByStatus, queueDepth, expiredLeases y unprocessedEvents", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("health");

  await withTenant(tenantId, async () => {
    await prisma.agentTask.create({ data: { tenantId, agentInstanceId, type: "t", input: {}, status: "QUEUED", triggeredBy: "AGENT" } });
    await prisma.agentTask.create({
      data: { tenantId, agentInstanceId, type: "t", input: {}, status: "RUNNING", triggeredBy: "AGENT", claimedAt: new Date(), claimedBy: "w1", leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.domainEvent.create({ data: { tenantId, type: "company.discovered.v1", payload: {} } });
  });

  const health = await getOrchestratorHealth();

  assert.ok(health.tasksByStatus.QUEUED! >= 1);
  assert.ok(health.tasksByStatus.RUNNING! >= 1);
  assert.ok(health.queueDepth >= 1);
  assert.ok(health.expiredLeases >= 1);
  assert.ok(health.unprocessedEvents >= 1);
  assert.ok(health.oldestQueuedTaskAgeMs === null || health.oldestQueuedTaskAgeMs >= 0);
});
