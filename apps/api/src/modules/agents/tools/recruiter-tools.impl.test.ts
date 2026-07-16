// F6.5: tests del Recruiter Agent graduado (capa LLM acotada) contra un
// provider controlado (mock) — cero llamadas reales a OpenAI. Fixtures
// sintéticos y desechables, limpiados en after(). Cada test usa su
// propio tenantId dedicado (deriva de un sufijo único) — runDeterministicMatching
// evalúa TODOS los Workers del tenant, así que compartir un tenant entre
// tests contaminaría los conteos de llamadas al LLM de un test con los
// Workers creados por otro. Cubre exactamente los casos pedidos: ajuste
// +10/-10, ajuste fuera de rango rechazado, respuesta inválida, error de
// proveedor, budget blocked, deterministic only, Worker ineligible
// ignorado, contenido protegido no enviado, fallback correcto, costo
// registrado solo cuando hubo llamada real.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import type { LLMCompletionResult, LLMProvider } from "@ai-staffing-os/agents";
import type { MatchRunResult } from "@ai-staffing-os/shared";
import { runWithTenancyContext } from "../../../core/tenancy/context";
import { createRecruiterTools } from "./recruiter-tools.impl";
import { UsageAccumulator } from "../usage";

const TENANT_PREFIX = "MATCHING-F65-TEST-TENANT";
const FIXTURE_PREFIX = "MATCHING-F65-TEST-FIXTURE";
const REAL_INDUSTRY = "industry-construction";
const REAL_CATEGORY = "category-forklift-operator";
const REAL_DOC_FORKLIFT = "forklift_cert";
const REAL_DOC_DRUG_TEST = "drug_test";

const createdCompanyIds: string[] = [];
const createdCandidateIds: string[] = [];
const createdWorkerIds: string[] = [];
const createdJobOrderIds: string[] = [];
const createdDocumentIds: string[] = [];
const createdAgentInstanceIds: string[] = [];
const createdAgentTaskIds: string[] = [];

after(async () => {
  if (createdAgentTaskIds.length > 0) await prisma.agentTask.deleteMany({ where: { id: { in: createdAgentTaskIds } } });
  if (createdDocumentIds.length > 0) await prisma.document.deleteMany({ where: { id: { in: createdDocumentIds } } });
  if (createdJobOrderIds.length > 0) await prisma.jobOrder.deleteMany({ where: { id: { in: createdJobOrderIds } } });
  if (createdWorkerIds.length > 0) await prisma.worker.deleteMany({ where: { id: { in: createdWorkerIds } } });
  if (createdCandidateIds.length > 0) await prisma.candidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  if (createdCompanyIds.length > 0) await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  if (createdAgentInstanceIds.length > 0) await prisma.agentInstance.deleteMany({ where: { id: { in: createdAgentInstanceIds } } });
  await prisma.$disconnect();
});

function tenantFor(suffix: string): string {
  return `${TENANT_PREFIX}-${suffix}`;
}

async function createFixtureJobOrderWithWorker(suffix: string) {
  const tenantId = tenantFor(suffix);
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
      location: { city: "Chicago", state: "IL" },
      requirements: [REAL_DOC_FORKLIFT, REAL_DOC_DRUG_TEST],
    },
  });
  createdJobOrderIds.push(jobOrder.id);

  const candidate = await prisma.candidate.create({
    data: {
      tenantId,
      firstName: "Fixture",
      lastName: suffix,
      status: "PLACED",
      yearsExperience: 10,
      city: "Chicago",
      state: "IL",
      languages: ["en", "es"],
      categories: { connect: [{ id: REAL_CATEGORY }] },
    },
  });
  createdCandidateIds.push(candidate.id);

  const worker = await prisma.worker.create({
    data: { tenantId, candidateId: candidate.id, defaultPayRate: 21, status: "AVAILABLE", complianceStatus: "COMPLIANT" },
  });
  createdWorkerIds.push(worker.id);

  for (const key of [REAL_DOC_FORKLIFT, REAL_DOC_DRUG_TEST]) {
    const documentType = await prisma.documentType.findFirstOrThrow({ where: { key } });
    const document = await prisma.document.create({
      data: { tenantId, workerId: worker.id, documentTypeId: documentType.id, status: "VERIFIED" },
    });
    createdDocumentIds.push(document.id);
  }

  return { tenantId, company, jobOrder, worker, candidate };
}

async function pushBudgetOverLimit(tenantId: string) {
  const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "recruiter" }, select: { id: true } });
  const instance = await prisma.agentInstance.create({ data: { tenantId, definitionId: definition.id } });
  createdAgentInstanceIds.push(instance.id);
  const task = await prisma.agentTask.create({
    data: {
      tenantId,
      agentInstanceId: instance.id,
      type: "budget_filler",
      input: {},
      status: "DONE",
      triggeredBy: "USER",
      costUsd: 1000,
    },
  });
  createdAgentTaskIds.push(task.id);
}

function fixedResponseProvider(content: string): LLMProvider {
  return { async complete(): Promise<LLMCompletionResult> {
    return { content, tokensUsed: 100, promptTokens: 60, completionTokens: 40 };
  } };
}

function throwingProvider(): LLMProvider {
  return { complete: () => Promise.reject(new Error("simulated network error")) };
}

function buildTool(llmProvider: LLMProvider) {
  const usage = new UsageAccumulator();
  const tools = createRecruiterTools({ taskId: "task-test", agentInstanceId: "agent-instance-test", llmProvider, usage });
  const rawTool = tools.find((t) => t.name === "matchWorkersToJobOrder")!;
  const tool = {
    execute: (input: { jobOrderId: string; withLlm?: boolean }) => rawTool.execute(input) as Promise<MatchRunResult>,
  };
  return { tool, usage };
}

test("ajuste +10: finalScore = deterministicScore + 10, acotado a 100", async () => {
  const { tenantId, jobOrder } = await createFixtureJobOrderWithWorker("plus10");
  const { tool } = buildTool(fixedResponseProvider('{"adjustment": 10, "rationale": "Ajuste positivo de prueba."}'));

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    const result = await tool.execute({ jobOrderId: jobOrder.id });
    assert.equal(result.llmStatus, "COMPLETED");
    assert.equal(result.eligibleWorkers.length, 1);
    const worker = result.eligibleWorkers[0]!;
    assert.equal(worker.llmAdjustment, 10);
    assert.equal(worker.finalScore, Math.min(100, worker.deterministicScore + 10));
  });
});

test("ajuste -10: finalScore = deterministicScore - 10, acotado a 0", async () => {
  const { tenantId, jobOrder } = await createFixtureJobOrderWithWorker("minus10");
  const { tool } = buildTool(fixedResponseProvider('{"adjustment": -10, "rationale": "Ajuste negativo de prueba."}'));

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    const result = await tool.execute({ jobOrderId: jobOrder.id });
    assert.equal(result.eligibleWorkers.length, 1);
    const worker = result.eligibleWorkers[0]!;
    assert.equal(worker.llmAdjustment, -10);
    assert.equal(worker.finalScore, Math.max(0, worker.deterministicScore - 10));
  });
});

test("ajuste fuera de rango (+15) es rechazado por el schema — se trata como respuesta inválida, cae al fallback determinista", async () => {
  const { tenantId, jobOrder } = await createFixtureJobOrderWithWorker("outofrange");
  const { tool } = buildTool(fixedResponseProvider('{"adjustment": 15, "rationale": "Fuera de rango."}'));

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    const result = await tool.execute({ jobOrderId: jobOrder.id });
    assert.equal(result.llmStatus, "FALLBACK_DETERMINISTIC");
    assert.equal(result.eligibleWorkers.length, 1);
    const worker = result.eligibleWorkers[0]!;
    assert.equal(worker.llmAdjustment, null);
    assert.equal(worker.finalScore, worker.deterministicScore);
  });
});

test("respuesta inválida (no es JSON) — cae al fallback determinista para ese worker, llmStatus=FALLBACK_DETERMINISTIC", async () => {
  const { tenantId, jobOrder } = await createFixtureJobOrderWithWorker("invalidjson");
  const { tool } = buildTool(fixedResponseProvider("esto no es JSON en absoluto"));

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    const result = await tool.execute({ jobOrderId: jobOrder.id });
    assert.equal(result.llmStatus, "FALLBACK_DETERMINISTIC");
    assert.equal(result.eligibleWorkers[0]!.llmAdjustment, null);
  });
});

test("error de proveedor (timeout/red): conserva el resultado determinista, llmStatus=FAILED, cero excepción propagada", async () => {
  const { tenantId, jobOrder } = await createFixtureJobOrderWithWorker("providererror");
  const { tool } = buildTool(throwingProvider());

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    const result = await tool.execute({ jobOrderId: jobOrder.id });
    assert.equal(result.llmStatus, "FAILED");
    const worker = result.eligibleWorkers[0]!;
    assert.equal(worker.llmAdjustment, null);
    assert.equal(worker.finalScore, worker.deterministicScore);
  });
});

test("budget blocked: presupuesto ya excedido → cero llamadas al proveedor, llmStatus=BUDGET_BLOCKED, warning explícito", async () => {
  const { tenantId, jobOrder } = await createFixtureJobOrderWithWorker("budgetblocked");
  await pushBudgetOverLimit(tenantId);

  let callCount = 0;
  const provider: LLMProvider = {
    async complete() {
      callCount++;
      return { content: '{"adjustment": 5, "rationale": "no debería llegar acá"}', tokensUsed: 1 };
    },
  };
  const { tool } = buildTool(provider);

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    const result = await tool.execute({ jobOrderId: jobOrder.id });
    assert.equal(result.llmStatus, "BUDGET_BLOCKED");
    assert.equal(callCount, 0, "no debe haber ninguna llamada real al proveedor si el presupuesto ya está excedido");
    assert.equal(result.cost.usd, 0);
    assert.ok(result.warnings.some((w) => w.toLowerCase().includes("presupuesto")));
  });
});

test("deterministic only (withLlm: false): cero llamadas al proveedor, llmStatus=NOT_RUN", async () => {
  const { tenantId, jobOrder } = await createFixtureJobOrderWithWorker("detonly");
  let callCount = 0;
  const provider: LLMProvider = {
    async complete() {
      callCount++;
      return { content: "{}", tokensUsed: 1 };
    },
  };
  const { tool } = buildTool(provider);

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    const result = await tool.execute({ jobOrderId: jobOrder.id, withLlm: false });
    assert.equal(result.llmStatus, "NOT_RUN");
    assert.equal(callCount, 0);
    assert.equal(result.deterministicOnly, true);
  });
});

test("Worker ineligible es ignorado por la capa LLM — nunca se le llama, y nunca puede terminar ELIGIBLE", async () => {
  const tenantId = tenantFor("ineligible");
  const company = await prisma.company.create({
    data: { tenantId, name: `${FIXTURE_PREFIX} ineligible Co`, industryId: REAL_INDUSTRY, status: "CLIENT", origin: "MANUAL" },
  });
  createdCompanyIds.push(company.id);
  const jobOrder = await prisma.jobOrder.create({
    data: {
      tenantId,
      companyId: company.id,
      categoryId: REAL_CATEGORY,
      title: `${FIXTURE_PREFIX} ineligible JobOrder`,
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
  const candidate = await prisma.candidate.create({
    data: { tenantId, firstName: "Fixture", lastName: "Ineligible", status: "PLACED", categories: { connect: [{ id: REAL_CATEGORY }] } },
  });
  createdCandidateIds.push(candidate.id);
  const worker = await prisma.worker.create({
    data: { tenantId, candidateId: candidate.id, defaultPayRate: 21, status: "TERMINATED", complianceStatus: "COMPLIANT" },
  });
  createdWorkerIds.push(worker.id);

  let callCount = 0;
  const provider: LLMProvider = {
    async complete() {
      callCount++;
      return { content: '{"adjustment": 10, "rationale": "no debería llegar acá"}', tokensUsed: 1 };
    },
  };
  const { tool } = buildTool(provider);

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    const result = await tool.execute({ jobOrderId: jobOrder.id });
    assert.equal(result.eligibleWorkers.length, 0);
    assert.equal(callCount, 0, "un worker TERMINATED (0 elegibles) no debe generar ninguna llamada al LLM");
    const match = result.ineligibleWorkers.find((w) => w.workerId === worker.id);
    assert.ok(match);
    assert.equal(match!.eligibility, "INELIGIBLE");
  });
});

test("contenido protegido no enviado: el prompt nunca incluye el nombre del candidato ni su ciudad cruda", async () => {
  const { tenantId, jobOrder, candidate } = await createFixtureJobOrderWithWorker("noPII");
  let capturedPrompt = "";
  const provider: LLMProvider = {
    async complete(request) {
      capturedPrompt = request.messages.map((m) => m.content).join("\n");
      return { content: '{"adjustment": 0, "rationale": "ok"}', tokensUsed: 1 };
    },
  };
  const { tool } = buildTool(provider);

  await runWithTenancyContext({ tenantId, userId: "u-test", permissions: [] }, async () => {
    await tool.execute({ jobOrderId: jobOrder.id });
  });

  assert.ok(!capturedPrompt.includes(candidate.firstName), "el prompt no debe incluir el firstName del candidato");
  assert.ok(!capturedPrompt.includes(candidate.lastName), "el prompt no debe incluir el lastName del candidato");
  assert.ok(!capturedPrompt.includes("Chicago"), "el prompt no debe incluir la ciudad cruda del candidato");
});

test("costo: se registra solo cuando hubo llamada real (0 en NOT_RUN/BUDGET_BLOCKED, > 0 en COMPLETED)", async () => {
  const { tenantId: t1, jobOrder: jo1 } = await createFixtureJobOrderWithWorker("cost-notrun");
  const { tool: toolNotRun } = buildTool(fixedResponseProvider('{"adjustment": 0, "rationale": "x"}'));
  await runWithTenancyContext({ tenantId: t1, userId: "u-test", permissions: [] }, async () => {
    const result = await toolNotRun.execute({ jobOrderId: jo1.id, withLlm: false });
    assert.equal(result.cost.usd, 0);
  });

  const { tenantId: t2, jobOrder: jo2 } = await createFixtureJobOrderWithWorker("cost-completed");
  const { tool: toolCompleted } = buildTool(fixedResponseProvider('{"adjustment": 3, "rationale": "x"}'));
  await runWithTenancyContext({ tenantId: t2, userId: "u-test", permissions: [] }, async () => {
    const result = await toolCompleted.execute({ jobOrderId: jo2.id });
    assert.ok(result.cost.usd > 0, "una corrida COMPLETED con al menos 1 llamada real debe tener costo > 0");
  });
});
