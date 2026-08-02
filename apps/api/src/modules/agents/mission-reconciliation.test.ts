import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { recoverStuckMission } from "./mission-orchestrator";

/**
 * Invariantes #2/#3/#12 (endurecimiento del motor, hallazgo real
 * MIS-20260802-0002): reconciliación final ejecutada antes de que una
 * misión pase a estado terminal -- ver reconcileMissionChildTasksBeforeClose
 * en mission-orchestrator.ts, invocada desde failMission/markMissionCancelled/
 * closeMission. Estos tests la ejercitan vía recoverStuckMission
 * (exportada, sin dependencia de LLM -- closeMission sí llama al CEO
 * Agent real para narrar el Executive Report, evitado acá a propósito
 * para que estos tests sean deterministas y baratos).
 */

const TEST_PREFIX = "RECONCILE-TEST";
const createdTenantIds: string[] = [];

async function setupMission(suffix: string): Promise<{ tenantId: string; missionTaskId: string }> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  const discoveryDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "discovery" } });
  const instance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: discoveryDefinition.id, isActive: true } });
  const missionTask = await prisma.agentTask.create({
    data: {
      tenantId: tenant.id,
      agentInstanceId: instance.id,
      type: "daily_revenue_mission",
      input: { businessObjective: { type: "companies_found", target: null, unit: "empresas", rawText: "fixture" } },
      status: "RUNNING",
      triggeredBy: "USER",
    },
  });
  return { tenantId: tenant.id, missionTaskId: missionTask.id };
}

after(async () => {
  if (createdTenantIds.length) {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

test("invariante #2/#12: una tarea huérfana en RUNNING se fuerza a FAILED con motivo real ANTES de que la misión cierre, nunca queda huérfana para siempre (MIS-20260802-0002)", async () => {
  const { tenantId, missionTaskId } = await setupMission("orphan-running");
  const instance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId } });
  const orphanedChild = await prisma.agentTask.create({
    data: {
      tenantId,
      agentInstanceId: instance.id,
      parentTaskId: missionTaskId,
      type: "discover_companies",
      input: {},
      status: "RUNNING",
      triggeredBy: "AGENT",
    },
  });

  await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: [] }, () =>
    recoverStuckMission(missionTaskId, "test: misión atascada"),
  );

  const reconciled = await prisma.agentTask.findUniqueOrThrow({ where: { id: orphanedChild.id } });
  assert.equal(reconciled.status, "FAILED", "nunca puede quedar una tarea huérfana en RUNNING una vez que la misión terminó");
  assert.ok(reconciled.completedAt);
  assert.match(reconciled.errorMessage ?? "", /Reconciliación final/);

  const mission = await prisma.agentTask.findUniqueOrThrow({ where: { id: missionTaskId } });
  assert.equal(mission.status, "FAILED");

  // Evidencia real y auditable del cierre forzado -- nunca silencioso.
  const auditEntry = await prisma.auditLog.findFirst({ where: { tenantId, entityId: orphanedChild.id, action: "mission.child_task_force_closed_by_reconciliation" } });
  assert.ok(auditEntry, "el cierre forzado debe quedar auditado con el motivo real");
});

test("invariante #3/#12: AWAITING_APPROVAL sin ningún ApprovalRequest PENDING real se fuerza a FAILED -- nunca queda esperando una aprobación que no va a llegar", async () => {
  const { tenantId, missionTaskId } = await setupMission("awaiting-no-approval");
  const instance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId } });
  const orphanedChild = await prisma.agentTask.create({
    data: {
      tenantId,
      agentInstanceId: instance.id,
      parentTaskId: missionTaskId,
      type: "personalize_message",
      input: {},
      status: "AWAITING_APPROVAL",
      triggeredBy: "AGENT",
    },
  });
  // A propósito: NUNCA se crea ningún ApprovalRequest real para esta tarea.

  await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: [] }, () =>
    recoverStuckMission(missionTaskId, "test: misión atascada"),
  );

  const reconciled = await prisma.agentTask.findUniqueOrThrow({ where: { id: orphanedChild.id } });
  assert.equal(reconciled.status, "FAILED");
  assert.match(reconciled.errorMessage ?? "", /ApprovalRequest PENDING real/);
});

test("invariante #3: AWAITING_APPROVAL CON un ApprovalRequest PENDING real asociado se preserva tal cual -- nunca se toca una espera legítima", async () => {
  const { tenantId, missionTaskId } = await setupMission("awaiting-with-approval");
  const instance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId } });
  const legitTask = await prisma.agentTask.create({
    data: {
      tenantId,
      agentInstanceId: instance.id,
      parentTaskId: missionTaskId,
      type: "personalize_message",
      input: {},
      status: "AWAITING_APPROVAL",
      triggeredBy: "AGENT",
    },
  });
  await prisma.approvalRequest.create({
    data: {
      tenantId,
      agentTaskId: legitTask.id,
      summary: "Borrador real esperando aprobación humana",
      proposedAction: { channel: "EMAIL", to: "real@example.com", subject: "s", body: "b" },
      riskLevel: "MEDIUM",
      status: "PENDING",
    },
  });

  await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: [] }, () =>
    recoverStuckMission(missionTaskId, "test: misión atascada"),
  );

  const untouched = await prisma.agentTask.findUniqueOrThrow({ where: { id: legitTask.id } });
  assert.equal(untouched.status, "AWAITING_APPROVAL", "una espera de aprobación legítima nunca debe forzarse a FAILED");
  assert.equal(untouched.errorMessage, null);
});

test("reconciliación: una misión sin ninguna tarea huérfana no genera ningún cierre forzado ni AuditLog espurio", async () => {
  const { tenantId, missionTaskId } = await setupMission("clean-mission");
  const instance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId } });
  const doneChild = await prisma.agentTask.create({
    data: {
      tenantId,
      agentInstanceId: instance.id,
      parentTaskId: missionTaskId,
      type: "discover_companies",
      input: {},
      status: "DONE",
      completedAt: new Date(),
      triggeredBy: "AGENT",
    },
  });

  await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: [] }, () =>
    recoverStuckMission(missionTaskId, "test: misión atascada"),
  );

  const untouched = await prisma.agentTask.findUniqueOrThrow({ where: { id: doneChild.id } });
  assert.equal(untouched.status, "DONE");
  const forcedClosures = await prisma.auditLog.count({ where: { tenantId, action: "mission.child_task_force_closed_by_reconciliation" } });
  assert.equal(forcedClosures, 0);
});
