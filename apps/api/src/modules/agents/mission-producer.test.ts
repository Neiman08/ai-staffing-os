import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createPilotMission, type PilotMissionInput } from "./mission-producer";

/**
 * F25.2 (activación controlada, Prioridad 1): pruebas de integración
 * contra Postgres real (local) del productor de misiones piloto --
 * nunca llama a Discovery real (solo CREA el AgentTask, no lo ejecuta
 * -- eso es responsabilidad del Orchestrator, ver Prioridad 6 para el
 * flujo completo).
 */

const TEST_PREFIX = "F25-2-MISSION-PRODUCER";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  createdTenantIds.push(tenant.id);
  // El productor busca el AgentInstance "discovery" del tenant --
  // seed.ts ya siembra las 18 AgentDefinition reales, pero un tenant
  // NUEVO no tiene AgentInstance propias todavía.
  const discoveryDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "discovery" } });
  await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: discoveryDefinition.id, isActive: true } });
  return tenant.id;
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, fn);
}

function baseInput(overrides: Partial<PilotMissionInput> = {}): PilotMissionInput {
  return {
    name: "Pilot Electrical Contractors Illinois",
    industry: "CONSTRUCTION",
    trade: "electrical contractors",
    region: { state: "IL", cities: ["Chicago", "Aurora", "Joliet"] },
    companyLimit: 25,
    autonomyLevel: 1,
    dryRun: false,
    idempotencyKey: `pilot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

test("rechaza autonomyLevel distinto de 1 (defensa en profundidad, más allá del schema Zod del router)", async () => {
  const tenantId = await setupTenant("autonomy-level");
  const input = { ...baseInput(), autonomyLevel: 2 } as unknown as PilotMissionInput;

  await assert.rejects(() => withTenant(tenantId, () => createPilotMission(input)), /autonomyLevel=1/);
});

test("rechaza un estado no soportado", async () => {
  const tenantId = await setupTenant("state");
  const input = baseInput({ region: { state: "ZZ", cities: ["Nowhere"] }, idempotencyKey: `pilot-state-${Date.now()}` });

  await assert.rejects(() => withTenant(tenantId, () => createPilotMission(input)), /no soportado/);
});

test("rechaza un trade que no matchea ninguna entrada real de la taxonomía -- nunca inventa un plan", async () => {
  const tenantId = await setupTenant("unknown-trade");
  const input = baseInput({ trade: "asdfqwertyunrecognizedtrade12345", idempotencyKey: `pilot-unknown-${Date.now()}` });

  await assert.rejects(() => withTenant(tenantId, () => createPilotMission(input)), /no matcheó ninguna entrada real/);
});

test("dryRun=true nunca crea un AgentTask -- solo devuelve el plan", async () => {
  const tenantId = await setupTenant("dry-run");
  const input = baseInput({ dryRun: true, idempotencyKey: `pilot-dryrun-${Date.now()}` });

  const result = await withTenant(tenantId, () => createPilotMission(input));

  assert.equal(result.dryRun, true);
  assert.equal(result.status, "DRY_RUN");
  assert.ok(result.plan);
  assert.ok(result.plan!.searchQueries.length > 0);
  assert.equal(result.plan!.stopConditions.maxCompanies, 25);

  const count = await prisma.agentTask.count({ where: { tenantId } });
  assert.equal(count, 0, "dryRun nunca escribe un AgentTask real");
});

test("crea un AgentTask real (discover_companies, QUEUED) con correlationId/idempotencyKey/plan válidos", async () => {
  const tenantId = await setupTenant("real-create");
  const idempotencyKey = `pilot-real-${Date.now()}`;
  const input = baseInput({ idempotencyKey });

  const result = await withTenant(tenantId, () => createPilotMission(input));

  assert.equal(result.alreadyExisted, false);
  assert.equal(result.dryRun, false);
  assert.ok(result.missionTaskId);
  assert.equal(result.correlationId, `mission_${idempotencyKey}`);

  const task = await prisma.agentTask.findUniqueOrThrow({ where: { id: result.missionTaskId } });
  assert.equal(task.type, "discover_companies");
  assert.equal(task.status, "QUEUED");
  assert.equal(task.tenantId, tenantId);
  assert.equal(task.idempotencyKey, idempotencyKey);
  assert.equal(task.correlationId, `mission_${idempotencyKey}`);
  assert.equal(task.triggeredBy, "USER");

  const taskInput = task.input as { missionTaskId: string; plan: { stopConditions: { maxCompanies: number } }; pilotMeta: { companyLimit: number } };
  assert.equal(taskInput.missionTaskId, task.id, "el self-reference se completa en el segundo write");
  assert.equal(taskInput.plan.stopConditions.maxCompanies, 25);
  assert.equal(taskInput.pilotMeta.companyLimit, 25);
});

test("idempotencia real: la misma idempotencyKey nunca crea una segunda tarea", async () => {
  const tenantId = await setupTenant("idempotent");
  const idempotencyKey = `pilot-idem-${Date.now()}`;
  const input = baseInput({ idempotencyKey });

  const first = await withTenant(tenantId, () => createPilotMission(input));
  const second = await withTenant(tenantId, () => createPilotMission(baseInput({ idempotencyKey, name: "Solicitud repetida (nombre distinto, misma idempotencyKey)" })));

  assert.equal(first.alreadyExisted, false);
  assert.equal(second.alreadyExisted, true);
  assert.equal(second.missionTaskId, first.missionTaskId);

  const count = await prisma.agentTask.count({ where: { idempotencyKey } });
  assert.equal(count, 1, "el índice único de la DB garantiza una sola fila, no una convención de aplicación");
});
