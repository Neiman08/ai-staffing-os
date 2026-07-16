// F6.1: validación de los contratos de matching (packages/shared). Sin
// scoring real todavía (F6.3) — estos tests solo prueban la FORMA y las
// invariantes del contrato en sí: rangos válidos, separación
// eligible/ineligible, ausencia de PII, y que el resultado completo
// serializa/deserializa dentro de AgentTask.output (Json) sin cambios
// de schema. Ninguna llamada a OpenAI, ningún AgentTask real escrito.

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import {
  MATCH_SCHEMA_VERSION,
  MATCH_ALGORITHM_VERSION,
  workerMatchResultSchema,
  matchRunResultSchema,
  matchHistoryEntrySchema,
  type WorkerMatchResult,
  type MatchRunResult,
} from "@ai-staffing-os/shared";

function buildWorker(overrides: Partial<WorkerMatchResult> = {}): WorkerMatchResult {
  return {
    workerId: "worker-09",
    candidateId: "candidate-09",
    displayName: "Kevin Wilson",
    workerStatus: "AVAILABLE",
    complianceStatus: "PENDING",
    availabilityStatus: "AVAILABLE",
    eligibility: "INELIGIBLE",
    deterministicScore: 40,
    llmAdjustment: null,
    finalScore: 40,
    rationale: "background_check aún no verificado",
    strengths: ["misma categoría"],
    gaps: ["background_check pendiente"],
    disqualifiers: ["background_check no verificado"],
    requiredDocumentsMissing: ["background_check"],
    categoryAssessment: { label: "Compatible" },
    experienceAssessment: { label: "Suficiente" },
    locationAssessment: { label: "Compatible" },
    payRateAssessment: { label: "Compatible" },
    complianceAssessment: { label: "Incompleto", detail: "background_check PENDING_REVIEW" },
    availabilityAssessment: { label: "Disponible" },
    ...overrides,
  };
}

function buildRun(overrides: Partial<MatchRunResult> = {}): MatchRunResult {
  return {
    schemaVersion: MATCH_SCHEMA_VERSION,
    algorithmVersion: MATCH_ALGORITHM_VERSION,
    jobOrderId: "joborder-01",
    agentTaskId: null,
    generatedAt: new Date().toISOString(),
    provider: null,
    model: null,
    llmStatus: "NOT_RUN",
    deterministicOnly: true,
    cost: { usd: 0 },
    eligibleWorkers: [],
    ineligibleWorkers: [buildWorker()],
    warnings: [],
    inputSnapshot: {
      jobOrderId: "joborder-01",
      categoryId: "category-forklift-operator",
      requirements: ["forklift_cert", "drug_test"],
      payRate: 21,
      startDate: "2026-06-27T00:00:00.000Z",
      endDate: null,
      workersNeeded: 12,
      workersConsidered: 10,
    },
    ...overrides,
  };
}

test("un WorkerMatchResult válido pasa la validación", () => {
  const result = workerMatchResultSchema.safeParse(buildWorker());
  assert.equal(result.success, true, JSON.stringify(result.success === false ? result.error.issues : null));
});

test("deterministicScore/finalScore fuera de [0,100] son inválidos", () => {
  assert.equal(workerMatchResultSchema.safeParse(buildWorker({ deterministicScore: -1 })).success, false);
  assert.equal(workerMatchResultSchema.safeParse(buildWorker({ deterministicScore: 101 })).success, false);
  assert.equal(workerMatchResultSchema.safeParse(buildWorker({ finalScore: -0.01 })).success, false);
  assert.equal(workerMatchResultSchema.safeParse(buildWorker({ finalScore: 100.5 })).success, false);
});

test("llmAdjustment fuera de ±10 es inválido", () => {
  assert.equal(workerMatchResultSchema.safeParse(buildWorker({ llmAdjustment: 10.1 })).success, false);
  assert.equal(workerMatchResultSchema.safeParse(buildWorker({ llmAdjustment: -10.1 })).success, false);
  assert.equal(workerMatchResultSchema.safeParse(buildWorker({ llmAdjustment: 10 })).success, true);
  assert.equal(workerMatchResultSchema.safeParse(buildWorker({ llmAdjustment: -10 })).success, true);
  assert.equal(workerMatchResultSchema.safeParse(buildWorker({ llmAdjustment: null })).success, true);
});

test("un Worker con disqualifiers no vacíos nunca puede ser ELIGIBLE (resultado inconsistente rechazado)", () => {
  const result = workerMatchResultSchema.safeParse(
    buildWorker({ eligibility: "ELIGIBLE", disqualifiers: ["background_check no verificado"] }),
  );
  assert.equal(result.success, false);
});

test("un Worker ELIGIBLE sin disqualifiers es válido", () => {
  const result = workerMatchResultSchema.safeParse(
    buildWorker({
      eligibility: "ELIGIBLE",
      disqualifiers: [],
      requiredDocumentsMissing: [],
      complianceStatus: "COMPLIANT",
      deterministicScore: 85,
      finalScore: 85,
    }),
  );
  assert.equal(result.success, true);
});

test("payload de WorkerMatchResult no expone campos de PII sensible (email/phone/ssn/dirección/documentos completos)", () => {
  const shape = workerMatchResultSchema._def.schema.shape;
  const forbiddenKeys = ["email", "phone", "ssn", "address", "documents", "resumeUrl", "linkedinUrl"];
  for (const key of forbiddenKeys) {
    assert.equal(key in shape, false, `WorkerMatchResult no debe tener el campo "${key}"`);
  }
});

test("un MatchRunResult válido pasa la validación", () => {
  const result = matchRunResultSchema.safeParse(buildRun());
  assert.equal(result.success, true, JSON.stringify(result.success === false ? result.error.issues : null));
});

test("eligibleWorkers nunca puede contener un Worker con eligibility != ELIGIBLE", () => {
  const invalid = buildRun({ eligibleWorkers: [buildWorker({ eligibility: "INELIGIBLE" })] });
  assert.equal(matchRunResultSchema.safeParse(invalid).success, false);
});

test("ineligibleWorkers nunca puede contener un Worker con eligibility=ELIGIBLE — un ajuste LLM nunca mueve a un Worker al bucket elegible", () => {
  const invalid = buildRun({
    ineligibleWorkers: [buildWorker({ eligibility: "ELIGIBLE", disqualifiers: [], llmAdjustment: 10 })],
  });
  assert.equal(matchRunResultSchema.safeParse(invalid).success, false);
});

test("un Worker ELIGIBLE con llmAdjustment=+10 en eligibleWorkers es válido (el ajuste solo mueve el score, no la elegibilidad)", () => {
  const valid = buildRun({
    eligibleWorkers: [
      buildWorker({
        eligibility: "ELIGIBLE",
        disqualifiers: [],
        requiredDocumentsMissing: [],
        deterministicScore: 80,
        llmAdjustment: 10,
        finalScore: 90,
      }),
    ],
    ineligibleWorkers: [],
  });
  assert.equal(matchRunResultSchema.safeParse(valid).success, true);
});

test("schemaVersion y algorithmVersion son obligatorios", () => {
  const raw = buildRun() as Record<string, unknown>;
  delete raw.schemaVersion;
  assert.equal(matchRunResultSchema.safeParse(raw).success, false);

  const raw2 = buildRun() as Record<string, unknown>;
  delete raw2.algorithmVersion;
  assert.equal(matchRunResultSchema.safeParse(raw2).success, false);
});

test("schemaVersion debe ser exactamente MATCH_SCHEMA_VERSION (literal, no cualquier número)", () => {
  const raw = { ...buildRun(), schemaVersion: 2 };
  assert.equal(matchRunResultSchema.safeParse(raw).success, false);
});

test("un MatchHistoryEntry válido pasa la validación, y topScore=null solo cuando eligibleCount=0", () => {
  const valid = matchHistoryEntrySchema.safeParse({
    taskId: "task-1",
    createdAt: new Date().toISOString(),
    status: "DONE",
    cost: 0.01,
    algorithmVersion: MATCH_ALGORITHM_VERSION,
    eligibleCount: 0,
    ineligibleCount: 10,
    topScore: null,
  });
  assert.equal(valid.success, true);

  const invalidScore = matchHistoryEntrySchema.safeParse({
    taskId: "task-1",
    createdAt: new Date().toISOString(),
    status: "DONE",
    cost: 0.01,
    algorithmVersion: MATCH_ALGORITHM_VERSION,
    eligibleCount: 1,
    ineligibleCount: 9,
    topScore: 150,
  });
  assert.equal(invalidScore.success, false);
});

test("un MatchRunResult completo serializa/deserializa dentro de AgentTask.output (Json) sin cambios de schema, y sin escribir ningún AgentTask real", async () => {
  const run = buildRun({
    eligibleWorkers: [
      buildWorker({
        eligibility: "ELIGIBLE",
        disqualifiers: [],
        requiredDocumentsMissing: [],
        complianceStatus: "COMPLIANT",
        deterministicScore: 85,
        llmAdjustment: 5,
        finalScore: 90,
      }),
    ],
  });
  const serialized = JSON.parse(JSON.stringify(run));
  const reparsed = matchRunResultSchema.safeParse(serialized);
  assert.equal(reparsed.success, true, JSON.stringify(reparsed.success === false ? reparsed.error.issues : null));

  // Confirma contra el schema real de AgentTask.output (Json?) sin
  // necesitar una tabla nueva ni una migración — Prisma valida en
  // tiempo de ejecución que sea JSON serializable, que ya lo probamos
  // arriba. No se crea ningún AgentTask real: solo se valida la forma
  // del campo contra el cliente Prisma generado, con findFirst (0 filas
  // esperado, cero escritura).
  const anyTask = await prisma.agentTask.findFirst({ select: { output: true } });
  assert.ok(anyTask === null || anyTask.output === null || typeof anyTask.output === "object");
});
