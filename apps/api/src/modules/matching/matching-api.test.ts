// F6.6: tests de runMatchingForJobOrder/getLatestMatchingRun/
// getMatchingHistory — la capa que persiste en AgentTask.output y
// registra Activity/AuditLog. Fixtures sintéticos y desechables
// (MATCHING-F66-TEST-* prefix), siempre con withLlm:false (cero
// llamadas reales a OpenAI — F6.5 ya cubrió esa capa por separado).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { runMatchingForJobOrder, getLatestMatchingRun, getMatchingHistory } from "./service";
import { AppError } from "../../core/errors";

const TENANT_PREFIX = "MATCHING-F66-TEST-TENANT";
const FIXTURE_PREFIX = "MATCHING-F66-TEST-FIXTURE";
const REAL_INDUSTRY = "industry-construction";
const REAL_CATEGORY = "category-forklift-operator";

const createdCompanyIds: string[] = [];
const createdJobOrderIds: string[] = [];
const createdAgentInstanceIds: string[] = [];
const createdAgentTaskIds: string[] = [];
const createdActivityIds: string[] = [];
const createdAuditLogIds: string[] = [];

after(async () => {
  if (createdAuditLogIds.length > 0) await prisma.auditLog.deleteMany({ where: { id: { in: createdAuditLogIds } } });
  if (createdActivityIds.length > 0) await prisma.activity.deleteMany({ where: { id: { in: createdActivityIds } } });
  if (createdAgentTaskIds.length > 0) await prisma.agentTask.deleteMany({ where: { id: { in: createdAgentTaskIds } } });
  if (createdJobOrderIds.length > 0) await prisma.jobOrder.deleteMany({ where: { id: { in: createdJobOrderIds } } });
  if (createdCompanyIds.length > 0) await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  if (createdAgentInstanceIds.length > 0) await prisma.agentInstance.deleteMany({ where: { id: { in: createdAgentInstanceIds } } });
  await prisma.$disconnect();
});

let suffixCounter = 0;
function nextTenant(): string {
  suffixCounter++;
  return `${TENANT_PREFIX}-${suffixCounter}`;
}

async function createFixtureJobOrder(tenantId: string, suffix: string) {
  const company = await prisma.company.create({
    data: { tenantId, name: `${FIXTURE_PREFIX} ${suffix} Co`, industryId: REAL_INDUSTRY, status: "CLIENT", origin: "MANUAL" },
  });
  createdCompanyIds.push(company.id);
  const jobOrder = await prisma.jobOrder.create({
    data: {
      tenantId,
      companyId: company.id,
      categoryId: REAL_CATEGORY,
      title: `${FIXTURE_PREFIX} ${suffix} JobOrder`,
      workersNeeded: 1,
      billRate: 30,
      payRate: 21,
      status: "OPEN",
      startDate: new Date("2026-07-01"),
      endDate: new Date("2026-12-31"),
      requirements: [],
    },
  });
  createdJobOrderIds.push(jobOrder.id);
  return { company, jobOrder };
}

function trackTaskCleanup(tenantId: string) {
  // El AgentInstance de "recruiter" se crea automáticamente por
  // resolveAgentInstance() si no existe? No — requiere que ya exista.
  // Como estos tenants son sintéticos (nunca corrió el seed), hay que
  // crear el AgentInstance real nosotros mismos antes de invocar
  // runMatchingForJobOrder (mismo patrón que F6.5).
  return tenantId;
}

async function ensureRecruiterAgentInstance(tenantId: string) {
  const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "recruiter" }, select: { id: true } });
  const instance = await prisma.agentInstance.create({ data: { tenantId, definitionId: definition.id } });
  createdAgentInstanceIds.push(instance.id);
  return instance;
}

test("run válido: crea un AgentTask real, DONE, con output persistido, Activity y AuditLog registrados", async () => {
  const tenantId = nextTenant();
  trackTaskCleanup(tenantId);
  await ensureRecruiterAgentInstance(tenantId);
  const { jobOrder } = await createFixtureJobOrder(tenantId, "run-ok");

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    const detail = await runMatchingForJobOrder(jobOrder.id, false);
    createdAgentTaskIds.push(detail.id);

    assert.equal(detail.status, "DONE");
    assert.equal(detail.agentKey, "recruiter");
    assert.equal(detail.type, "match_workers_to_job_order");
    assert.ok(detail.output);

    const activities = await prisma.activity.findMany({ where: { tenantId, entityType: "jobOrder", entityId: jobOrder.id } });
    createdActivityIds.push(...activities.map((a) => a.id));
    assert.equal(activities.length, 1);
    assert.match(activities[0]!.subject, /AI Matching run/);

    const auditLogs = await prisma.auditLog.findMany({ where: { tenantId, entityType: "jobOrder", entityId: jobOrder.id } });
    createdAuditLogIds.push(...auditLogs.map((a) => a.id));
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0]!.action, "matching.executed");
    const after = auditLogs[0]!.after as { agentTaskId: string };
    assert.equal(after.agentTaskId, detail.id);
  });
});

test("Job Order inexistente: runMatchingForJobOrder lanza notFound, cero AgentTask creado", async () => {
  const tenantId = nextTenant();
  await ensureRecruiterAgentInstance(tenantId);

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    await assert.rejects(() => runMatchingForJobOrder("does-not-exist", false), /not found/i);
  });

  const tasks = await prisma.agentTask.count({ where: { tenantId } });
  assert.equal(tasks, 0);
});

test("doble ejecución concurrente: la segunda llamada mientras la primera está QUEUED/RUNNING recibe 409", async () => {
  const tenantId = nextTenant();
  await ensureRecruiterAgentInstance(tenantId);
  const { jobOrder } = await createFixtureJobOrder(tenantId, "concurrency");

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    // Simula una corrida "en vuelo": crea directamente un AgentTask en
    // RUNNING para el mismo Job Order (sin pasar por el motor real),
    // igual que quedaría si una ejecución real estuviera en curso.
    const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "recruiter" }, select: { id: true } });
    const instance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId, definitionId: definition.id } });
    const inFlight = await prisma.agentTask.create({
      data: {
        tenantId,
        agentInstanceId: instance.id,
        type: "match_workers_to_job_order",
        input: { jobOrderId: jobOrder.id },
        status: "RUNNING",
        triggeredBy: "USER",
      },
    });
    createdAgentTaskIds.push(inFlight.id);

    await assert.rejects(
      () => runMatchingForJobOrder(jobOrder.id, false),
      (err: unknown) => err instanceof AppError && err.status === 409,
    );
  });
});

test("ninguna Assignment es creada, ningún Worker/JobOrder es mutado por una corrida real", async () => {
  const tenantId = nextTenant();
  await ensureRecruiterAgentInstance(tenantId);
  const { jobOrder } = await createFixtureJobOrder(tenantId, "no-mutation");

  const beforeAssignments = await prisma.assignment.count({ where: { tenantId } });
  const beforeJobOrder = await prisma.jobOrder.findUniqueOrThrow({ where: { id: jobOrder.id } });

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    const detail = await runMatchingForJobOrder(jobOrder.id, false);
    createdAgentTaskIds.push(detail.id);
  });

  const afterAssignments = await prisma.assignment.count({ where: { tenantId } });
  const afterJobOrder = await prisma.jobOrder.findUniqueOrThrow({ where: { id: jobOrder.id } });
  assert.equal(afterAssignments, beforeAssignments);
  assert.equal(afterJobOrder.status, beforeJobOrder.status);
  assert.equal(afterJobOrder.workersFilled, beforeJobOrder.workersFilled);
  assert.equal(afterJobOrder.updatedAt.getTime(), beforeJobOrder.updatedAt.getTime());

  const activities = await prisma.activity.findMany({ where: { tenantId, entityType: "jobOrder", entityId: jobOrder.id } });
  createdActivityIds.push(...activities.map((a) => a.id));
  const auditLogs = await prisma.auditLog.findMany({ where: { tenantId, entityType: "jobOrder", entityId: jobOrder.id } });
  createdAuditLogIds.push(...auditLogs.map((a) => a.id));
});

test("getLatestMatchingRun: 404 si nunca se corrió, devuelve la última corrida tras ejecutar", async () => {
  const tenantId = nextTenant();
  await ensureRecruiterAgentInstance(tenantId);
  const { jobOrder } = await createFixtureJobOrder(tenantId, "latest");

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    await assert.rejects(() => getLatestMatchingRun(jobOrder.id), /No matching run found/);

    const detail = await runMatchingForJobOrder(jobOrder.id, false);
    createdAgentTaskIds.push(detail.id);

    const latest = await getLatestMatchingRun(jobOrder.id);
    assert.equal(latest.id, detail.id);
  });

  const activities = await prisma.activity.findMany({ where: { tenantId, entityType: "jobOrder", entityId: jobOrder.id } });
  createdActivityIds.push(...activities.map((a) => a.id));
  const auditLogs = await prisma.auditLog.findMany({ where: { tenantId, entityType: "jobOrder", entityId: jobOrder.id } });
  createdAuditLogIds.push(...auditLogs.map((a) => a.id));
});

test("getMatchingHistory: dos corridas para el mismo Job Order son ambas recuperables por separado, orden desc", async () => {
  const tenantId = nextTenant();
  await ensureRecruiterAgentInstance(tenantId);
  const { jobOrder } = await createFixtureJobOrder(tenantId, "history");

  let firstId = "";
  let secondId = "";
  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    const first = await runMatchingForJobOrder(jobOrder.id, false);
    createdAgentTaskIds.push(first.id);
    firstId = first.id;

    const second = await runMatchingForJobOrder(jobOrder.id, false);
    createdAgentTaskIds.push(second.id);
    secondId = second.id;

    const history = await getMatchingHistory(jobOrder.id, {});
    assert.equal(history.items.length, 2);
    assert.equal(history.items[0]!.taskId, secondId, "la corrida más reciente debe aparecer primero");
    assert.equal(history.items[1]!.taskId, firstId);
    assert.equal(history.nextCursor, null);
  });

  const activities = await prisma.activity.findMany({ where: { tenantId, entityType: "jobOrder", entityId: jobOrder.id } });
  createdActivityIds.push(...activities.map((a) => a.id));
  const auditLogs = await prisma.auditLog.findMany({ where: { tenantId, entityType: "jobOrder", entityId: jobOrder.id } });
  createdAuditLogIds.push(...auditLogs.map((a) => a.id));
  void firstId;
  void secondId;
});

test("tenancy: un AgentTask de matching de un tenant nunca es visible desde otro", async () => {
  const tenantA = nextTenant();
  const tenantB = nextTenant();
  await ensureRecruiterAgentInstance(tenantA);
  const { jobOrder } = await createFixtureJobOrder(tenantA, "tenancy-a");

  let taskId = "";
  await runWithTenancyContext({ tenantId: tenantA, userId: "u-test", permissions: [] }, async () => {
    const detail = await runMatchingForJobOrder(jobOrder.id, false);
    createdAgentTaskIds.push(detail.id);
    taskId = detail.id;
  });

  await runWithTenancyContext({ tenantId: tenantB, userId: "u-test", permissions: [] }, async () => {
    // El propio Job Order no existe bajo tenantB -> notFound, ni
    // siquiera llega a buscar el AgentTask.
    await assert.rejects(() => getLatestMatchingRun(jobOrder.id), /not found/i);
  });

  const activities = await prisma.activity.findMany({ where: { tenantId: tenantA, entityType: "jobOrder", entityId: jobOrder.id } });
  createdActivityIds.push(...activities.map((a) => a.id));
  const auditLogs = await prisma.auditLog.findMany({ where: { tenantId: tenantA, entityType: "jobOrder", entityId: jobOrder.id } });
  createdAuditLogIds.push(...auditLogs.map((a) => a.id));
  void taskId;
});
