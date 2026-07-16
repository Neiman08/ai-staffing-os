import { z } from "zod";

// F6.1: contratos del matching Job Order <-> Worker. Zod es la única
// fuente de verdad — todos los tipos se infieren desde acá, nunca se
// duplica una interface manual en paralelo. La fórmula de scoring real
// se implementa en F6.3; este archivo solo fija la forma del resultado
// y su versionado, para que F6.2-F6.6 construyan contra un contrato
// estable. "La IA propone, la IA no decide, la IA no crea Assignments
// automáticamente" — ningún tipo de acá representa una escritura, solo
// una propuesta de solo lectura.

// ---------- Versionado (constantes explícitas, ver plan §F6.1) ----------
export const MATCH_SCHEMA_VERSION = 1;
export const MATCH_ALGORITHM_VERSION = "v1";

// ---------- Enums ----------

export const matchEligibilitySchema = z.enum(["ELIGIBLE", "INELIGIBLE", "REVIEW_REQUIRED"]);
export type MatchEligibility = z.infer<typeof matchEligibilitySchema>;

export const availabilityStatusSchema = z.enum(["AVAILABLE", "DATE_CONFLICT", "WORKER_UNAVAILABLE", "UNKNOWN"]);
export type AvailabilityStatus = z.infer<typeof availabilityStatusSchema>;

export const llmStatusSchema = z.enum(["NOT_RUN", "COMPLETED", "FAILED", "BUDGET_BLOCKED", "FALLBACK_DETERMINISTIC"]);
export type LlmStatus = z.infer<typeof llmStatusSchema>;

// ---------- Bloques de evaluación por factor ----------

// Explicación corta y auditable de un factor — nunca un prompt completo
// ni el registro fuente crudo (ej. nunca el Document entero, solo su key
// y su estado ya resumidos en texto).
export const matchAssessmentSchema = z.object({
  label: z.string(),
  detail: z.string().optional(),
});
export type MatchAssessment = z.infer<typeof matchAssessmentSchema>;

const scoreSchema = z.number().min(0).max(100);
// F6.1 (decisión aprobada del PO): el ajuste del LLM está acotado a
// ±10 puntos sobre el score determinístico — nunca puede por sí solo
// mover a un Worker de INELIGIBLE a ELIGIBLE (esa invariante se valida
// más abajo, a nivel de resultado completo, no solo por rango numérico).
const llmAdjustmentSchema = z.number().min(-10).max(10);

// ---------- F6.3: desglose de los 7 factores del scoring determinista ----------
// (plan §7.4) — cada uno con su peso máximo y su score real, para que el
// frontend explique "por qué" sin recalcular nada. `evidence` es texto
// corto ya derivado (nunca datos crudos sensibles, ver §7.5 del plan).
export const matchFactorSchema = z
  .object({
    key: z.enum(["requiredDocuments", "experience", "location", "payRate", "assignmentHistory", "languages", "dataRecency"]),
    label: z.string(),
    maxWeight: z.number().positive(),
    score: z.number().min(0),
    evidence: z.array(z.string()),
  })
  .refine((v) => v.score <= v.maxWeight, { message: "score cannot exceed maxWeight", path: ["score"] });
export type MatchFactor = z.infer<typeof matchFactorSchema>;

export const matchFactorsSchema = z.object({
  requiredDocuments: matchFactorSchema,
  experience: matchFactorSchema,
  location: matchFactorSchema,
  payRate: matchFactorSchema,
  assignmentHistory: matchFactorSchema,
  languages: matchFactorSchema,
  dataRecency: matchFactorSchema,
});
export type MatchFactors = z.infer<typeof matchFactorsSchema>;

// ---------- Resultado de matching para un Worker ----------

export const workerMatchResultSchema = z
  .object({
    workerId: z.string(),
    candidateId: z.string(),
    // Nombre para mostrar en UI (firstName + lastName) — deliberadamente
    // NO se incluye email/phone/dirección/documentos completos: eso ya
    // vive en Worker/Candidate/Document, el matching solo referencia ids.
    displayName: z.string(),
    // Strings (no el enum de Prisma) para no atar packages/shared al
    // cliente generado de la DB — mismo patrón ya usado en
    // assignmentDetailSchema.workerComplianceStatus.
    workerStatus: z.string(),
    complianceStatus: z.string(),
    availabilityStatus: availabilityStatusSchema,
    eligibility: matchEligibilitySchema,
    deterministicScore: scoreSchema,
    // null únicamente cuando no corrió ningún ajuste LLM real para este
    // Worker (llmStatus del run padre != COMPLETED) — nunca un 0
    // inventado que se confundiría con "el LLM bajó el score a 0".
    llmAdjustment: llmAdjustmentSchema.nullable(),
    finalScore: scoreSchema,
    // Explicación corta, auditable — nunca el prompt completo enviado al LLM.
    rationale: z.string(),
    strengths: z.array(z.string()),
    gaps: z.array(z.string()),
    // Razones duras que producen INELIGIBLE — vacío si no aplica. Un
    // Worker con disqualifiers no vacíos nunca puede ser ELIGIBLE (ver
    // refine abajo), sin importar qué diga deterministicScore/llmAdjustment.
    disqualifiers: z.array(z.string()),
    // Keys de DocumentType (ej. "forklift_cert"), nunca el Document
    // completo — evita filtrar fileUrl/aiExtraction/etc.
    requiredDocumentsMissing: z.array(z.string()),
    categoryAssessment: matchAssessmentSchema,
    experienceAssessment: matchAssessmentSchema,
    locationAssessment: matchAssessmentSchema,
    payRateAssessment: matchAssessmentSchema,
    complianceAssessment: matchAssessmentSchema,
    availabilityAssessment: matchAssessmentSchema,
    // F6.3: desglose completo de los 7 factores — vacío/cero en cada uno
    // cuando el Worker tiene disqualifiers (nunca se puntúa parcialmente
    // a alguien ya excluido, ver matching/scoring.ts).
    factors: matchFactorsSchema,
  })
  .refine((v) => v.disqualifiers.length === 0 || v.eligibility !== "ELIGIBLE", {
    message: "A worker with any disqualifier can never be ELIGIBLE",
    path: ["disqualifiers"],
  })
  .refine(
    (v) => {
      const sum = Object.values(v.factors).reduce((acc, f) => acc + f.score, 0);
      return Math.abs(sum - v.deterministicScore) < 0.01;
    },
    { message: "deterministicScore must equal the sum of all factor scores", path: ["deterministicScore"] },
  );
export type WorkerMatchResult = z.infer<typeof workerMatchResultSchema>;

// ---------- Resultado completo de una corrida ----------

export const matchCostSchema = z.object({
  usd: z.number().nonnegative(),
  tokensInput: z.number().int().nonnegative().optional(),
  tokensOutput: z.number().int().nonnegative().optional(),
});
export type MatchCost = z.infer<typeof matchCostSchema>;

// Snapshot mínimo del JobOrder al momento de correr — suficiente para
// auditar qué se evaluó, sin guardar el registro completo (evita
// duplicar location/description/etc. que ya vive en JobOrder).
export const matchInputSnapshotSchema = z.object({
  jobOrderId: z.string(),
  categoryId: z.string(),
  requirements: z.array(z.string()),
  payRate: z.number(),
  startDate: z.string(),
  endDate: z.string().nullable(),
  workersNeeded: z.number().int().nonnegative(),
  workersConsidered: z.number().int().nonnegative(),
});
export type MatchInputSnapshot = z.infer<typeof matchInputSnapshotSchema>;

export const matchRunResultSchema = z
  .object({
    schemaVersion: z.literal(MATCH_SCHEMA_VERSION),
    algorithmVersion: z.string(),
    jobOrderId: z.string(),
    // null cuando la corrida no está atada a un AgentTask real (ej. en
    // un test unitario de scoring) — en producción (F6.6) siempre viene seteado.
    agentTaskId: z.string().nullable(),
    generatedAt: z.string(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    llmStatus: llmStatusSchema,
    deterministicOnly: z.boolean(),
    cost: matchCostSchema,
    eligibleWorkers: z.array(workerMatchResultSchema),
    ineligibleWorkers: z.array(workerMatchResultSchema),
    warnings: z.array(z.string()),
    inputSnapshot: matchInputSnapshotSchema,
  })
  .refine((v) => v.eligibleWorkers.every((w) => w.eligibility === "ELIGIBLE"), {
    message: "eligibleWorkers must only contain workers with eligibility=ELIGIBLE",
    path: ["eligibleWorkers"],
  })
  .refine((v) => v.ineligibleWorkers.every((w) => w.eligibility !== "ELIGIBLE"), {
    message: "ineligibleWorkers must never contain a worker with eligibility=ELIGIBLE — an LLM adjustment can never move a worker into the eligible bucket",
    path: ["ineligibleWorkers"],
  });
export type MatchRunResult = z.infer<typeof matchRunResultSchema>;

// ---------- Historial (para AgentTask.output / listado de corridas) ----------

export const matchHistoryEntrySchema = z.object({
  taskId: z.string(),
  createdAt: z.string(),
  // AgentTaskStatus real como string (mismo motivo que workerStatus arriba).
  status: z.string(),
  cost: z.number().nonnegative(),
  algorithmVersion: z.string(),
  eligibleCount: z.number().int().nonnegative(),
  ineligibleCount: z.number().int().nonnegative(),
  // null solo cuando eligibleCount=0 (no hay ningún score elegible que reportar).
  topScore: scoreSchema.nullable(),
});
export type MatchHistoryEntry = z.infer<typeof matchHistoryEntrySchema>;

// ---------- F6.2: resultado de disponibilidad real de un Worker ----------
//
// Extensión aditiva — solo cubre el factor de disponibilidad (Worker.status
// + Assignments + fechas), sin scoring ni compliance ni categoría (F6.3).
// `eligibility` acá es deliberadamente parcial: representa únicamente si
// la disponibilidad por sí sola descalifica al Worker (INELIGIBLE cuando
// sí), nunca una elegibilidad final — esa combina todos los factores en
// WorkerMatchResult (F6.3). Nunca se sube de INELIGIBLE a ELIGIBLE en un
// paso posterior por este mismo factor; los demás factores solo pueden
// agregar más razones de exclusión, nunca revertir esta.
export const workerAvailabilityResultSchema = z.object({
  workerId: z.string(),
  availabilityStatus: availabilityStatusSchema,
  eligibility: matchEligibilitySchema,
  hasDateConflict: z.boolean(),
  // Ids de Assignment (SCHEDULED|ACTIVE únicamente — COMPLETED/TERMINATED
  // nunca bloquean) cuyo rango de fechas solapa con el Job Order evaluado.
  conflictingAssignmentIds: z.array(z.string()),
  evaluatedJobOrderStart: z.string(),
  evaluatedJobOrderEnd: z.string().nullable(),
  reason: z.string().min(1),
  warnings: z.array(z.string()),
});
export type WorkerAvailabilityResult = z.infer<typeof workerAvailabilityResultSchema>;

// ---------- F6.6: body de POST /job-orders/:id/matching/run ----------
// jobOrderId viene de la URL, nunca del body — este schema solo cubre
// las opciones mínimas de la corrida (plan §14).
export const runMatchingInputSchema = z.object({
  withLlm: z.boolean().optional(),
});
export type RunMatchingInput = z.infer<typeof runMatchingInputSchema>;
