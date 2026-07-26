import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createPilotMission, type PilotMissionInput } from "./mission-producer";
import { listPilotMissions, pausePilotMission, resumePilotMission, cancelPilotMission, isPilotMissionActive } from "./pilot-mission-control";
import type { PipelineFlags } from "../../core/pipeline-flags";

/**
 * F25.2 (activación controlada, Prioridad 8): control de ciclo de vida
 * de una misión piloto -- listar/pausar/reanudar/cancelar, y que
 * isPilotMissionActive() efectivamente bloquee la creación de tareas
 * reactivas nuevas (probado end-to-end en pipeline-handlers.test.ts,
 * acá solo la función en sí + el estado que expone).
 *
 * Inyecta el pipeline habilitado vía el segundo parámetro de
 * createPilotMission (mismo patrón que mission-producer.test.ts /
 * pilot-mission-e2e.test.ts) -- nunca depende de
 * MISSION_TASK_PRODUCTION_ENABLED en el entorno real.
 */

function allFlagsOn(): PipelineFlags {
  return {
    autonomousWorkerEnabled: true,
    missionTaskProductionEnabled: true,
    discoveryAgentEnabled: true,
    contactIntelligenceAgentEnabled: true,
    qualityAgentEnabled: true,
    eventHandlersEnabled: true,
    draftAgentEnabled: true,
    externalActionsEnabled: false,
    autonomousSendingEnabled: false,
  };
}

const TEST_PREFIX = "F25-2-MISSION-CONTROL";
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
    region: { state: "IL", cities: ["Chicago"] },
    companyLimit: 1,
    autonomyLevel: 1,
    dryRun: false,
    idempotencyKey: `pilot-control-test-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

test("listPilotMissions: devuelve las misiones del tenant, más reciente primero, con controlState=ACTIVE por defecto", async () => {
  const tenantId = await setupTenant("list");
  const mission = await withTenant(tenantId, () => createPilotMission(baseInput(), allFlagsOn()));

  const missions = await withTenant(tenantId, () => listPilotMissions());
  assert.equal(missions.length, 1);
  assert.equal(missions[0]!.missionTaskId, mission.missionTaskId);
  assert.equal(missions[0]!.controlState, "ACTIVE");
  assert.equal(missions[0]!.status, "QUEUED");
});

test("pausePilotMission / resumePilotMission: cambian controlState real, isPilotMissionActive lo refleja", async () => {
  const tenantId = await setupTenant("pause-resume");
  const mission = await withTenant(tenantId, () => createPilotMission(baseInput(), allFlagsOn()));

  assert.equal(await withTenant(tenantId, () => isPilotMissionActive(mission.correlationId)), true);

  const paused = await withTenant(tenantId, () => pausePilotMission(mission.missionTaskId));
  assert.equal(paused.controlState, "PAUSED");
  assert.equal(await withTenant(tenantId, () => isPilotMissionActive(mission.correlationId)), false);

  const resumed = await withTenant(tenantId, () => resumePilotMission(mission.missionTaskId));
  assert.equal(resumed.controlState, "ACTIVE");
  assert.equal(await withTenant(tenantId, () => isPilotMissionActive(mission.correlationId)), true);

  // Bug real encontrado en auditoría: pause/resume nunca quedaban en el
  // AuditLog real (a diferencia de cancel) -- solo cancelPilotMission lo
  // hacía.
  const pausedAudit = await prisma.auditLog.findFirst({ where: { entityId: mission.missionTaskId, action: "mission.pilot_paused" } });
  const resumedAudit = await prisma.auditLog.findFirst({ where: { entityId: mission.missionTaskId, action: "mission.pilot_resumed" } });
  assert.ok(pausedAudit, "pausePilotMission debe dejar un AuditLog real");
  assert.ok(resumedAudit, "resumePilotMission debe dejar un AuditLog real");
});

test("cancelPilotMission: marca CANCELED el AgentTask raíz QUEUED, controlState=CANCELED, isPilotMissionActive=false", async () => {
  const tenantId = await setupTenant("cancel");
  const mission = await withTenant(tenantId, () => createPilotMission(baseInput(), allFlagsOn()));

  const canceled = await withTenant(tenantId, () => cancelPilotMission(mission.missionTaskId));
  assert.equal(canceled.controlState, "CANCELED");

  const task = await prisma.agentTask.findUniqueOrThrow({ where: { id: mission.missionTaskId } });
  assert.equal(task.status, "CANCELED", "el AgentTask raíz, todavía QUEUED, se cancela de verdad");
  assert.ok(task.canceledAt);

  assert.equal(await withTenant(tenantId, () => isPilotMissionActive(mission.correlationId)), false);
});

test("cancelPilotMission: cancela también las tareas hijas no-terminales de la misma correlationId", async () => {
  const tenantId = await setupTenant("cancel-children");
  const mission = await withTenant(tenantId, () => createPilotMission(baseInput(), allFlagsOn()));

  const contactIntelDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "contact_intelligence" } });
  const contactIntelInstance = await prisma.agentInstance.create({ data: { tenantId, definitionId: contactIntelDefinition.id, isActive: true } });
  const childTask = await prisma.agentTask.create({
    data: {
      tenantId,
      agentInstanceId: contactIntelInstance.id,
      type: "find_contacts",
      status: "QUEUED",
      triggeredBy: "EVENT",
      correlationId: mission.correlationId,
      input: {},
    },
  });

  await withTenant(tenantId, () => cancelPilotMission(mission.missionTaskId));

  const refreshedChild = await prisma.agentTask.findUniqueOrThrow({ where: { id: childTask.id } });
  assert.equal(refreshedChild.status, "CANCELED", "una tarea hija QUEUED de la misma misión también se cancela");
});

test("pausePilotMission / resumePilotMission: una misión ya cancelada rechaza ambas acciones -- 409", async () => {
  const tenantId = await setupTenant("cancel-then-pause");
  const mission = await withTenant(tenantId, () => createPilotMission(baseInput(), allFlagsOn()));
  await withTenant(tenantId, () => cancelPilotMission(mission.missionTaskId));

  await assert.rejects(withTenant(tenantId, () => pausePilotMission(mission.missionTaskId)), /ya está cancelada/);
  await assert.rejects(withTenant(tenantId, () => resumePilotMission(mission.missionTaskId)), /ya está cancelada/);
});

test("isPilotMissionActive: correlationId sin AgentTask raíz (no es una misión piloto controlada) nunca bloquea", async () => {
  const tenantId = await setupTenant("no-root");
  assert.equal(await withTenant(tenantId, () => isPilotMissionActive("correlation-sin-mision")), true);
  assert.equal(await withTenant(tenantId, () => isPilotMissionActive(null)), true);
});

test("Seguridad (Prioridad 9): un tenant nunca puede pausar/reanudar/cancelar la misión piloto de otro tenant", async () => {
  const tenantA = await setupTenant("isolation-owner");
  const tenantB = await setupTenant("isolation-attacker");
  const mission = await withTenant(tenantA, () => createPilotMission(baseInput(), allFlagsOn()));

  await assert.rejects(withTenant(tenantB, () => pausePilotMission(mission.missionTaskId)), /Misión piloto no encontrada/);
  await assert.rejects(withTenant(tenantB, () => resumePilotMission(mission.missionTaskId)), /Misión piloto no encontrada/);
  await assert.rejects(withTenant(tenantB, () => cancelPilotMission(mission.missionTaskId)), /Misión piloto no encontrada/);

  // La misión de A sigue intacta -- tenantB nunca la tocó de verdad.
  const untouched = await withTenant(tenantA, () => listPilotMissions());
  assert.equal(untouched[0]!.controlState, "ACTIVE");
});

test("Seguridad (Prioridad 9): listPilotMissions de un tenant nunca incluye misiones de otro tenant", async () => {
  const tenantA = await setupTenant("list-isolation-a");
  const tenantB = await setupTenant("list-isolation-b");
  await withTenant(tenantA, () => createPilotMission(baseInput(), allFlagsOn()));
  await withTenant(tenantB, () => createPilotMission(baseInput(), allFlagsOn()));

  const missionsA = await withTenant(tenantA, () => listPilotMissions());
  const missionsB = await withTenant(tenantB, () => listPilotMissions());
  assert.equal(missionsA.length, 1);
  assert.equal(missionsB.length, 1);
  assert.notEqual(missionsA[0]!.missionTaskId, missionsB[0]!.missionTaskId);
});
