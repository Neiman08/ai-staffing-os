// F6.2: tests del adapter (loadWorkerAvailabilityContext /
// evaluateWorkerAvailabilityById) contra un fixture SINTÉTICO Y
// DESECHABLE — nunca contra Workers/JobOrders reales. Confirma tenancy
// (un Worker/JobOrder/Assignment de otro tenant no puede influir en el
// resultado) y que el resultado final es válido contra el contrato Zod.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { loadWorkerAvailabilityContext, evaluateWorkerAvailabilityById } from "./availability-loader";
import { workerAvailabilityResultSchema } from "@ai-staffing-os/shared";

const TENANT_ID = "MATCHING-F62-TEST-TENANT";
const OTHER_TENANT_ID = "MATCHING-F62-TEST-OTHER-TENANT";
const FIXTURE_PREFIX = "MATCHING-F62-TEST-FIXTURE";
const REAL_INDUSTRY = "industry-construction";
const REAL_CATEGORY = "category-forklift-operator";

const createdCompanyIds: string[] = [];
const createdCandidateIds: string[] = [];
const createdWorkerIds: string[] = [];
const createdJobOrderIds: string[] = [];
const createdAssignmentIds: string[] = [];

async function createFixture(tenantId: string, suffix: string) {
  const company = await prisma.company.create({
    data: { tenantId, name: `${FIXTURE_PREFIX} ${suffix} Co`, industryId: REAL_INDUSTRY, status: "CLIENT", origin: "MANUAL" },
  });
  createdCompanyIds.push(company.id);

  const candidate = await prisma.candidate.create({
    data: { tenantId, firstName: "Fixture", lastName: suffix, status: "NEW" },
  });
  createdCandidateIds.push(candidate.id);

  const worker = await prisma.worker.create({
    data: { tenantId, candidateId: candidate.id, defaultPayRate: 20, status: "AVAILABLE", complianceStatus: "COMPLIANT" },
  });
  createdWorkerIds.push(worker.id);

  const jobOrder = await prisma.jobOrder.create({
    data: {
      tenantId,
      companyId: company.id,
      categoryId: REAL_CATEGORY,
      title: `${FIXTURE_PREFIX} ${suffix} JobOrder`,
      workersNeeded: 1,
      billRate: 30,
      payRate: 20,
      status: "OPEN",
      startDate: new Date("2026-07-01"),
      endDate: new Date("2026-12-31"),
    },
  });
  createdJobOrderIds.push(jobOrder.id);

  return { company, candidate, worker, jobOrder };
}

after(async () => {
  if (createdAssignmentIds.length > 0) await prisma.assignment.deleteMany({ where: { id: { in: createdAssignmentIds } } });
  if (createdJobOrderIds.length > 0) await prisma.jobOrder.deleteMany({ where: { id: { in: createdJobOrderIds } } });
  if (createdWorkerIds.length > 0) await prisma.worker.deleteMany({ where: { id: { in: createdWorkerIds } } });
  if (createdCandidateIds.length > 0) await prisma.candidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  if (createdCompanyIds.length > 0) await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  await prisma.$disconnect();
});

test("loadWorkerAvailabilityContext carga Worker/JobOrder/Assignments reales del tenant correcto", async () => {
  const { worker, jobOrder } = await createFixture(TENANT_ID, "load-ok");
  const assignment = await prisma.assignment.create({
    data: {
      tenantId: TENANT_ID,
      workerId: worker.id,
      jobOrderId: jobOrder.id,
      payRate: 20,
      billRate: 30,
      status: "ACTIVE",
      startDate: new Date("2025-01-01"),
      endDate: new Date("2025-06-01"),
    },
  });
  createdAssignmentIds.push(assignment.id);

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const context = await loadWorkerAvailabilityContext(worker.id, jobOrder.id);
    assert.ok(context);
    assert.equal(context!.workerId, worker.id);
    assert.equal(context!.workerStatus, "AVAILABLE");
    assert.equal(context!.assignments.length, 1);
    assert.equal(context!.assignments[0]!.id, assignment.id);
    assert.deepEqual(context!.jobOrderStartDate, new Date("2026-07-01"));
    assert.deepEqual(context!.jobOrderEndDate, new Date("2026-12-31"));
  });
});

test("un Worker de otro tenant no puede influir: devuelve null bajo el tenant equivocado", async () => {
  const { worker, jobOrder } = await createFixture(TENANT_ID, "tenant-worker");

  await runWithTenancyContext({ tenantId: OTHER_TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const context = await loadWorkerAvailabilityContext(worker.id, jobOrder.id);
    assert.equal(context, null);
  });
});

test("un Job Order de otro tenant no puede influir: devuelve null bajo el tenant equivocado", async () => {
  const fixtureA = await createFixture(TENANT_ID, "tenant-jo-a");
  const fixtureB = await createFixture(OTHER_TENANT_ID, "tenant-jo-b");

  // Worker real de TENANT_ID, Job Order real de OTHER_TENANT_ID — bajo
  // el contexto de TENANT_ID, el Job Order de OTHER_TENANT_ID no existe.
  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const context = await loadWorkerAvailabilityContext(fixtureA.worker.id, fixtureB.jobOrder.id);
    assert.equal(context, null);
  });
});

test("una Assignment de otro tenant no puede influir en el conteo/resultado, incluso si el Worker y el Job Order son reales en ese otro tenant", async () => {
  const { worker, jobOrder } = await createFixture(TENANT_ID, "tenant-assignment");

  // Assignment creada directamente en OTHER_TENANT_ID (fila real, con el
  // mismo workerId por coincidencia de test) — nunca debe aparecer en el
  // contexto cargado bajo TENANT_ID, porque scopedDb.assignment.findMany
  // ya está acotado por tenant.
  const foreignAssignment = await prisma.assignment.create({
    data: {
      tenantId: OTHER_TENANT_ID,
      workerId: worker.id,
      jobOrderId: jobOrder.id,
      payRate: 20,
      billRate: 30,
      status: "ACTIVE",
      startDate: new Date("2026-08-01"),
      endDate: new Date("2026-09-01"),
    },
  });
  createdAssignmentIds.push(foreignAssignment.id);

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const context = await loadWorkerAvailabilityContext(worker.id, jobOrder.id);
    assert.ok(context);
    assert.equal(context!.assignments.length, 0, "la Assignment de otro tenant no debe aparecer");

    const result = await evaluateWorkerAvailabilityById(worker.id, jobOrder.id);
    assert.ok(result);
    assert.equal(result!.availabilityStatus, "AVAILABLE", "sin la Assignment ajena, el Worker está libre");
  });
});

test("evaluateWorkerAvailabilityById produce un resultado válido contra el contrato Zod, con conflictingAssignmentIds correctos", async () => {
  const { worker, jobOrder } = await createFixture(TENANT_ID, "contract-check");
  const conflicting = await prisma.assignment.create({
    data: {
      tenantId: TENANT_ID,
      workerId: worker.id,
      jobOrderId: jobOrder.id,
      payRate: 20,
      billRate: 30,
      status: "SCHEDULED",
      startDate: new Date("2026-08-01"),
      endDate: new Date("2026-09-01"),
    },
  });
  createdAssignmentIds.push(conflicting.id);

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await evaluateWorkerAvailabilityById(worker.id, jobOrder.id);
    assert.ok(result);
    const parsed = workerAvailabilityResultSchema.safeParse(result);
    assert.equal(parsed.success, true, JSON.stringify(parsed.success === false ? parsed.error.issues : null));
    assert.equal(result!.availabilityStatus, "DATE_CONFLICT");
    assert.deepEqual(result!.conflictingAssignmentIds, [conflicting.id]);
    assert.ok(result!.reason.length > 0);
    assert.deepEqual(result!.warnings, []);
  });
});

test("evaluateWorkerAvailabilityById devuelve null si el Worker no existe (nunca inventa un resultado)", async () => {
  const { jobOrder } = await createFixture(TENANT_ID, "missing-worker");
  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await evaluateWorkerAvailabilityById("does-not-exist", jobOrder.id);
    assert.equal(result, null);
  });
});
