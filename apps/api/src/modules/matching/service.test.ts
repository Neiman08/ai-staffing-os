// F6.4: cobertura determinista de integración para
// runDeterministicMatching() — fixtures sintéticos y desechables,
// nunca datos reales/seed permanente. Cubre exactamente los casos
// pedidos (worker ideal, no disponible por fechas, BLOCKED, PENDING,
// documentos faltantes, pay rate incompatible, categoría incompatible,
// experiencia insuficiente, ASSIGNED sin conflicto, AVAILABLE con
// conflicto, Job Order sin endDate, Assignment sin endDate) más
// tenancy/aislamiento/limpieza/contratos/orden estable/determinismo.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { runDeterministicMatching } from "./service";
import { matchRunResultSchema } from "@ai-staffing-os/shared";

const TENANT_ID = "MATCHING-F64-TEST-TENANT";
const OTHER_TENANT_ID = "MATCHING-F64-TEST-OTHER-TENANT";
const FIXTURE_PREFIX = "MATCHING-F64-TEST-FIXTURE";
const REAL_INDUSTRY = "industry-construction";
const REAL_CATEGORY = "category-forklift-operator";
const OTHER_CATEGORY = "category-warehouse-worker";
const REAL_DOC_FORKLIFT = "forklift_cert";
const REAL_DOC_DRUG_TEST = "drug_test";

const createdCompanyIds: string[] = [];
const createdCandidateIds: string[] = [];
const createdWorkerIds: string[] = [];
const createdJobOrderIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdDocumentIds: string[] = [];

after(async () => {
  if (createdDocumentIds.length > 0) await prisma.document.deleteMany({ where: { id: { in: createdDocumentIds } } });
  if (createdAssignmentIds.length > 0) await prisma.assignment.deleteMany({ where: { id: { in: createdAssignmentIds } } });
  if (createdJobOrderIds.length > 0) await prisma.jobOrder.deleteMany({ where: { id: { in: createdJobOrderIds } } });
  if (createdWorkerIds.length > 0) await prisma.worker.deleteMany({ where: { id: { in: createdWorkerIds } } });
  if (createdCandidateIds.length > 0) await prisma.candidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  if (createdCompanyIds.length > 0) await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  await prisma.$disconnect();
});

async function createCompany(tenantId: string, suffix: string) {
  const company = await prisma.company.create({
    data: { tenantId, name: `${FIXTURE_PREFIX} ${suffix} Co`, industryId: REAL_INDUSTRY, status: "CLIENT", origin: "MANUAL" },
  });
  createdCompanyIds.push(company.id);
  return company;
}

async function createJobOrder(
  tenantId: string,
  companyId: string,
  suffix: string,
  overrides: Partial<{ categoryId: string; payRate: number; endDate: Date | null; city: string; state: string; requirements: string[] }> = {},
) {
  const jobOrder = await prisma.jobOrder.create({
    data: {
      tenantId,
      companyId,
      categoryId: overrides.categoryId ?? REAL_CATEGORY,
      title: `${FIXTURE_PREFIX} ${suffix} JobOrder`,
      workersNeeded: 3,
      billRate: 30,
      payRate: overrides.payRate ?? 21,
      status: "OPEN",
      startDate: new Date("2026-07-01"),
      endDate: overrides.endDate === undefined ? new Date("2026-12-31") : overrides.endDate,
      location: { city: overrides.city ?? "Chicago", state: overrides.state ?? "IL" },
      requirements: overrides.requirements ?? [REAL_DOC_FORKLIFT, REAL_DOC_DRUG_TEST],
    },
  });
  createdJobOrderIds.push(jobOrder.id);
  return jobOrder;
}

async function createWorker(
  tenantId: string,
  suffix: string,
  overrides: Partial<{
    workerStatus: string;
    complianceStatus: string;
    defaultPayRate: number;
    categoryId: string;
    yearsExperience: number | null;
    city: string | null;
    state: string | null;
    languages: string[];
    updatedAt: Date;
  }> = {},
) {
  const candidate = await prisma.candidate.create({
    data: {
      tenantId,
      firstName: "Fixture",
      lastName: suffix,
      status: "PLACED",
      yearsExperience: overrides.yearsExperience === undefined ? 10 : overrides.yearsExperience,
      city: overrides.city === undefined ? "Chicago" : overrides.city,
      state: overrides.state === undefined ? "IL" : overrides.state,
      languages: overrides.languages ?? ["en", "es"],
      categories: { connect: [{ id: overrides.categoryId ?? REAL_CATEGORY }] },
    },
  });
  createdCandidateIds.push(candidate.id);
  if (overrides.updatedAt) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { updatedAt: overrides.updatedAt } });
  }

  const worker = await prisma.worker.create({
    data: {
      tenantId,
      candidateId: candidate.id,
      defaultPayRate: overrides.defaultPayRate ?? 21,
      status: (overrides.workerStatus ?? "AVAILABLE") as never,
      complianceStatus: (overrides.complianceStatus ?? "COMPLIANT") as never,
    },
  });
  createdWorkerIds.push(worker.id);
  return { candidate, worker };
}

async function createDocument(tenantId: string, workerId: string, documentTypeKey: string, status: string) {
  const documentType = await prisma.documentType.findFirstOrThrow({ where: { key: documentTypeKey } });
  const document = await prisma.document.create({
    data: { tenantId, workerId, documentTypeId: documentType.id, status: status as never },
  });
  createdDocumentIds.push(document.id);
  return document;
}

async function createAssignment(
  tenantId: string,
  workerId: string,
  jobOrderId: string,
  overrides: Partial<{ status: string; startDate: Date; endDate: Date | null }> = {},
) {
  const assignment = await prisma.assignment.create({
    data: {
      tenantId,
      workerId,
      jobOrderId,
      payRate: 21,
      billRate: 30,
      status: (overrides.status ?? "ACTIVE") as never,
      startDate: overrides.startDate ?? new Date("2026-07-01"),
      endDate: overrides.endDate === undefined ? null : overrides.endDate,
    },
  });
  createdAssignmentIds.push(assignment.id);
  return assignment;
}

test("worker ideal (todo compatible) es ELIGIBLE con score alto y aparece en eligibleWorkers", async () => {
  const company = await createCompany(TENANT_ID, "ideal");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "ideal");
  const { worker } = await createWorker(TENANT_ID, "Ideal");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_FORKLIFT, "VERIFIED");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_DRUG_TEST, "VERIFIED");

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.eligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match, "el worker ideal debe estar en eligibleWorkers");
    assert.equal(match!.eligibility, "ELIGIBLE");
    assert.ok(match!.deterministicScore > 80, `esperaba score alto, obtuvo ${match!.deterministicScore}`);
    assert.deepEqual(match!.disqualifiers, []);
  });
});

test("worker no disponible por fechas (AVAILABLE con Assignment SCHEDULED solapada) es INELIGIBLE con disqualifier date_overlap", async () => {
  const company = await createCompany(TENANT_ID, "conflict");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "conflict");
  const { worker } = await createWorker(TENANT_ID, "DateConflict");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_FORKLIFT, "VERIFIED");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_DRUG_TEST, "VERIFIED");
  await createAssignment(TENANT_ID, worker.id, jobOrder.id, { status: "SCHEDULED", startDate: new Date("2026-08-01"), endDate: new Date("2026-09-01") });

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.ineligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match, "debe estar en ineligibleWorkers");
    assert.equal(match!.eligibility, "INELIGIBLE");
    assert.ok(match!.disqualifiers.includes("date_overlap"));
    assert.equal(match!.availabilityStatus, "DATE_CONFLICT");
  });
});

test("worker BLOCKED por compliance es INELIGIBLE con disqualifier compliance_not_cleared", async () => {
  const company = await createCompany(TENANT_ID, "blocked");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "blocked");
  const { worker } = await createWorker(TENANT_ID, "Blocked", { complianceStatus: "BLOCKED" });

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.ineligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match);
    assert.ok(match!.disqualifiers.includes("compliance_not_cleared"));
  });
});

test("worker PENDING por compliance es INELIGIBLE con disqualifier compliance_not_cleared", async () => {
  const company = await createCompany(TENANT_ID, "pending");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "pending");
  const { worker } = await createWorker(TENANT_ID, "Pending", { complianceStatus: "PENDING" });

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.ineligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match);
    assert.ok(match!.disqualifiers.includes("compliance_not_cleared"));
  });
});

test("documentos requeridos faltantes: ELIGIBLE pero con requiredDocumentsMissing poblado y score reducido", async () => {
  const company = await createCompany(TENANT_ID, "missing-docs");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "missing-docs");
  const { worker } = await createWorker(TENANT_ID, "MissingDocs");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_FORKLIFT, "VERIFIED");
  // drug_test deliberadamente no se crea — falta.

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.eligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match, "documentos faltantes no es un disqualifier duro — sigue elegible");
    assert.deepEqual(match!.requiredDocumentsMissing, [REAL_DOC_DRUG_TEST]);
  });
});

test("pay rate incompatible: ELIGIBLE pero con factor de pay rate bajo", async () => {
  const company = await createCompany(TENANT_ID, "payrate");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "payrate", { payRate: 21 });
  const { worker } = await createWorker(TENANT_ID, "PayRate", { defaultPayRate: 60 });
  await createDocument(TENANT_ID, worker.id, REAL_DOC_FORKLIFT, "VERIFIED");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_DRUG_TEST, "VERIFIED");

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.eligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match);
    assert.ok(match!.factors.payRate.score < match!.factors.payRate.maxWeight * 0.3);
  });
});

test("categoría incompatible: INELIGIBLE con disqualifier category_mismatch", async () => {
  const company = await createCompany(TENANT_ID, "category");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "category", { categoryId: REAL_CATEGORY });
  const { worker } = await createWorker(TENANT_ID, "Category", { categoryId: OTHER_CATEGORY });

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.ineligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match);
    assert.ok(match!.disqualifiers.includes("category_mismatch"));
  });
});

test("experiencia insuficiente: ELIGIBLE pero con factor de experiencia bajo", async () => {
  const company = await createCompany(TENANT_ID, "experience");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "experience");
  const { worker } = await createWorker(TENANT_ID, "Experience", { yearsExperience: 0 });
  await createDocument(TENANT_ID, worker.id, REAL_DOC_FORKLIFT, "VERIFIED");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_DRUG_TEST, "VERIFIED");

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.eligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match);
    assert.equal(match!.factors.experience.score, 0);
  });
});

test("worker ASSIGNED pero sin conflicto de fechas: ELIGIBLE", async () => {
  const company = await createCompany(TENANT_ID, "assigned-ok");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "assigned-ok");
  const { worker } = await createWorker(TENANT_ID, "AssignedOk", { workerStatus: "ASSIGNED" });
  await createDocument(TENANT_ID, worker.id, REAL_DOC_FORKLIFT, "VERIFIED");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_DRUG_TEST, "VERIFIED");
  // Otra Assignment, en un rango que NO se solapa con el Job Order (2026-07-01..2026-12-31).
  await createAssignment(TENANT_ID, worker.id, jobOrder.id, { status: "ACTIVE", startDate: new Date("2025-01-01"), endDate: new Date("2025-06-01") });

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.eligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match, "ASSIGNED sin conflicto real de fechas debe ser elegible");
  });
});

test("worker AVAILABLE con conflicto de fechas: INELIGIBLE (AVAILABLE no es garantía de elegibilidad)", async () => {
  const company = await createCompany(TENANT_ID, "available-conflict");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "available-conflict");
  const { worker } = await createWorker(TENANT_ID, "AvailableConflict", { workerStatus: "AVAILABLE" });
  await createAssignment(TENANT_ID, worker.id, jobOrder.id, { status: "SCHEDULED", startDate: new Date("2026-07-15"), endDate: new Date("2026-08-15") });

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.ineligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match);
    assert.ok(match!.disqualifiers.includes("date_overlap"));
  });
});

test("Job Order sin endDate: una Assignment que termina antes del startDate del Job Order NO bloquea", async () => {
  const company = await createCompany(TENANT_ID, "jo-open");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "jo-open", { endDate: null });
  const { worker } = await createWorker(TENANT_ID, "JoOpenNoConflict");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_FORKLIFT, "VERIFIED");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_DRUG_TEST, "VERIFIED");
  await createAssignment(TENANT_ID, worker.id, jobOrder.id, { status: "ACTIVE", startDate: new Date("2026-01-01"), endDate: new Date("2026-06-01") });

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.eligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match, "una Assignment que ya terminó antes del startDate del Job Order abierto no debe bloquear");
    assert.equal(result.inputSnapshot.endDate, null);
  });
});

test("Job Order sin endDate: una Assignment sin endDate SIEMPRE bloquea (regla conservadora)", async () => {
  const company = await createCompany(TENANT_ID, "jo-open-conflict");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "jo-open-conflict", { endDate: null });
  const { worker } = await createWorker(TENANT_ID, "JoOpenConflict");
  await createAssignment(TENANT_ID, worker.id, jobOrder.id, { status: "ACTIVE", startDate: new Date("2020-01-01"), endDate: null });

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.ineligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match, "ambos rangos abiertos siempre se consideran solapados (regla conservadora documentada en F6.2)");
    assert.ok(match!.disqualifiers.includes("date_overlap"));
  });
});

test("Assignment sin endDate contra un Job Order con endDate definido: bloquea solo si el Job Order no termina antes de que empiece la Assignment", async () => {
  const company = await createCompany(TENANT_ID, "assignment-open");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "assignment-open", { endDate: new Date("2026-05-01") });
  const { worker } = await createWorker(TENANT_ID, "AssignmentOpenNoConflict");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_FORKLIFT, "VERIFIED");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_DRUG_TEST, "VERIFIED");
  // La Assignment (abierta) empieza DESPUÉS de que el Job Order ya terminó -> no debe bloquear.
  await createAssignment(TENANT_ID, worker.id, jobOrder.id, { status: "ACTIVE", startDate: new Date("2026-06-01"), endDate: null });

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const match = result.eligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match, "el Job Order termina antes de que empiece la Assignment abierta — no debe bloquear");
  });
});

test("tenancy: un Worker/Assignment de otro tenant nunca aparece en el resultado", async () => {
  const company = await createCompany(TENANT_ID, "tenancy-a");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "tenancy-a");
  const { worker: ownWorker } = await createWorker(TENANT_ID, "TenancyOwn");
  await createDocument(TENANT_ID, ownWorker.id, REAL_DOC_FORKLIFT, "VERIFIED");
  await createDocument(TENANT_ID, ownWorker.id, REAL_DOC_DRUG_TEST, "VERIFIED");

  const otherCompany = await createCompany(OTHER_TENANT_ID, "tenancy-b");
  await createJobOrder(OTHER_TENANT_ID, otherCompany.id, "tenancy-b");
  const { worker: foreignWorker } = await createWorker(OTHER_TENANT_ID, "TenancyForeign");

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const allIds = [...result.eligibleWorkers, ...result.ineligibleWorkers].map((w) => w.workerId);
    assert.ok(!allIds.includes(foreignWorker.id), "un worker de otro tenant nunca debe aparecer en el resultado");
    assert.ok(allIds.includes(ownWorker.id));
  });
});

test("tenancy: un Job Order de otro tenant no es visible — runDeterministicMatching lanza notFound", async () => {
  const otherCompany = await createCompany(OTHER_TENANT_ID, "tenancy-jo");
  const foreignJobOrder = await createJobOrder(OTHER_TENANT_ID, otherCompany.id, "tenancy-jo");

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    await assert.rejects(() => runDeterministicMatching(foreignJobOrder.id), /not found/i);
  });
});

test("contratos: el MatchRunResult completo de una corrida real es válido contra matchRunResultSchema", async () => {
  const company = await createCompany(TENANT_ID, "contract");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "contract");
  const { worker } = await createWorker(TENANT_ID, "Contract");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_FORKLIFT, "VERIFIED");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_DRUG_TEST, "VERIFIED");

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const parsed = matchRunResultSchema.safeParse(result);
    assert.equal(parsed.success, true, JSON.stringify(parsed.success === false ? parsed.error.issues : null));
  });
});

test("orden estable ante empate: dos workers con el mismo finalScore se ordenan por workerId asc", async () => {
  const company = await createCompany(TENANT_ID, "tie");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "tie");
  const { worker: w1 } = await createWorker(TENANT_ID, "TieA");
  const { worker: w2 } = await createWorker(TENANT_ID, "TieB");
  for (const w of [w1, w2]) {
    await createDocument(TENANT_ID, w.id, REAL_DOC_FORKLIFT, "VERIFIED");
    await createDocument(TENANT_ID, w.id, REAL_DOC_DRUG_TEST, "VERIFIED");
  }

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const result = await runDeterministicMatching(jobOrder.id);
    const relevant = result.eligibleWorkers.filter((w) => w.workerId === w1.id || w.workerId === w2.id);
    assert.equal(relevant.length, 2);
    assert.equal(relevant[0]!.finalScore, relevant[1]!.finalScore, "ambos workers deben tener el mismo score (fixture idéntico)");
    const sortedIds = [w1.id, w2.id].sort();
    assert.deepEqual(relevant.map((w) => w.workerId), sortedIds);
  });
});

test("mismo input produce siempre el mismo resultado: dos corridas consecutivas del mismo Job Order son idénticas salvo generatedAt", async () => {
  const company = await createCompany(TENANT_ID, "determinism");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "determinism");
  const { worker } = await createWorker(TENANT_ID, "Determinism");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_FORKLIFT, "VERIFIED");
  await createDocument(TENANT_ID, worker.id, REAL_DOC_DRUG_TEST, "VERIFIED");

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    const run1 = await runDeterministicMatching(jobOrder.id);
    const run2 = await runDeterministicMatching(jobOrder.id);
    const { generatedAt: g1, ...rest1 } = run1;
    const { generatedAt: g2, ...rest2 } = run2;
    void g1;
    void g2;
    assert.deepEqual(rest1, rest2);
  });
});

test("cero escrituras: runDeterministicMatching no crea/modifica ninguna Assignment/Worker/JobOrder", async () => {
  const company = await createCompany(TENANT_ID, "no-writes");
  const jobOrder = await createJobOrder(TENANT_ID, company.id, "no-writes");
  const { worker } = await createWorker(TENANT_ID, "NoWrites");

  const beforeCounts = {
    assignments: await prisma.assignment.count({ where: { tenantId: TENANT_ID } }),
    workers: await prisma.worker.count({ where: { tenantId: TENANT_ID } }),
    jobOrders: await prisma.jobOrder.count({ where: { tenantId: TENANT_ID } }),
  };

  await runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions: [] }, async () => {
    await runDeterministicMatching(jobOrder.id);
  });

  const afterCounts = {
    assignments: await prisma.assignment.count({ where: { tenantId: TENANT_ID } }),
    workers: await prisma.worker.count({ where: { tenantId: TENANT_ID } }),
    jobOrders: await prisma.jobOrder.count({ where: { tenantId: TENANT_ID } }),
  };
  assert.deepEqual(afterCounts, beforeCounts);

  const workerAfter = await prisma.worker.findUnique({ where: { id: worker.id } });
  assert.equal(workerAfter!.status, "AVAILABLE");
});
