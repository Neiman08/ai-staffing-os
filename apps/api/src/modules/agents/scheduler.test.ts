// F12.5: watchdog de misiones atascadas (runMissionCloseSweep) --
// tenant/AgentInstance/User propios y aislados (nunca tenant-titan, para
// no interferir con el guard real de "una misión activa por día" de
// otros tests corriendo en paralelo).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runMissionCloseSweep } from "./scheduler";

let tenantId: string;
let agentInstanceId: string;

before(async () => {
  const tenant = await prisma.tenant.create({ data: { name: "F12.5 Scheduler Test Tenant", slug: "f12-5-scheduler-test" } });
  tenantId = tenant.id;
  // getOperatorUserId (scheduler.ts) busca role.name EXACTAMENTE "CEO" o
  // "Admin" -- no un rol que solo lo contenga.
  const role = await prisma.role.create({ data: { tenantId, name: "CEO" } });
  await prisma.user.create({
    data: { tenantId, roleId: role.id, email: "f12-5-ceo@example.com", firstName: "F12.5", lastName: "CEO" },
  });
  const definition = await prisma.agentDefinition.upsert({
    where: { key: "ceo" },
    update: {},
    create: { key: "ceo", name: "CEO Agent", description: "test" },
  });
  const instance = await prisma.agentInstance.create({ data: { tenantId, definitionId: definition.id } });
  agentInstanceId = instance.id;
});

after(async () => {
  await prisma.agentTask.deleteMany({ where: { tenantId } });
  await prisma.agentInstance.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { tenantId } });
  await prisma.role.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
});

async function createMissionTask(output: unknown, createdAt: Date) {
  return prisma.agentTask.create({
    data: {
      tenantId,
      agentInstanceId,
      type: "daily_revenue_mission",
      input: { rawInstruction: "test" },
      status: "RUNNING",
      triggeredBy: "USER",
      createdAt,
      output: output as never,
    },
  });
}

test("F12.5 (regresión real): una misión con output=null (nunca llegó a escribir NADA -- el bug real de F12.3) se recupera igual que una con missionState=RUNNING stale", async () => {
  const stuckNullOutput = await createMissionTask(null, new Date(Date.now() - 20 * 60_000));
  const result = await runMissionCloseSweep(tenantId);
  assert.equal(result.recovered, 1);

  const after = await prisma.agentTask.findUniqueOrThrow({ where: { id: stuckNullOutput.id } });
  assert.equal(after.status, "FAILED");
  assert.match(after.errorMessage ?? "", /Watchdog/);
});

test("una misión con missionState=RUNNING y progressUpdatedAt viejo se recupera", async () => {
  const stale = await createMissionTask(
    { missionState: "RUNNING", progressUpdatedAt: new Date(Date.now() - 20 * 60_000).toISOString() },
    new Date(Date.now() - 20 * 60_000),
  );
  const result = await runMissionCloseSweep(tenantId);
  assert.equal(result.recovered, 1);
  const after = await prisma.agentTask.findUniqueOrThrow({ where: { id: stale.id } });
  assert.equal(after.status, "FAILED");
});

test("una misión con missionState=RUNNING y progressUpdatedAt reciente NO se recupera (todavía trabajando de verdad)", async () => {
  const active = await createMissionTask(
    { missionState: "RUNNING", progressUpdatedAt: new Date().toISOString() },
    new Date(),
  );
  const result = await runMissionCloseSweep(tenantId);
  assert.equal(result.recovered, 0);
  const after = await prisma.agentTask.findUniqueOrThrow({ where: { id: active.id } });
  assert.equal(after.status, "RUNNING");
});

test("una misión PAUSED_BY_USER con output viejo NUNCA se trata como atascada (pausa legítima, no bug)", async () => {
  // createdAt = ahora (nunca "ayer", sin importar la hora real de la
  // corrida) -- lo único que debe importar acá es progressUpdatedAt viejo.
  const paused = await createMissionTask(
    { missionState: "PAUSED_BY_USER", progressUpdatedAt: new Date(Date.now() - 20 * 60_000).toISOString() },
    new Date(),
  );
  const result = await runMissionCloseSweep(tenantId);
  assert.equal(result.recovered, 0);
  const after = await prisma.agentTask.findUniqueOrThrow({ where: { id: paused.id } });
  assert.equal(after.status, "RUNNING");
});
