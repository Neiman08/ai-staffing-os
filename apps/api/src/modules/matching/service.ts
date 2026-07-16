// F6.4: orquestador determinista del matching Job Order <-> Worker —
// une la disponibilidad real (F6.2) y el scoring determinista (F6.3)
// contra datos reales del tenant, vía scopedDb (tenancy automática,
// nunca acepta un tenantId por parámetro). Sin IA, sin AgentTask, sin
// escritura — la capa LLM (F6.5) y la persistencia (F6.6) se agregan
// encima de esta función, nunca la modifican.

import type { AgentTaskDetail, MatchHistoryEntry, MatchRunResult, Paginated, WorkerMatchResult } from "@ai-staffing-os/shared";
import { MATCH_ALGORITHM_VERSION, MATCH_SCHEMA_VERSION } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { toCursorPage } from "../../core/pagination";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";
import { createAndRunTaskSync, toAgentTaskDetail } from "../agents/task-executor";
import { evaluateWorkerAvailability, type AssignmentForAvailability } from "./availability";
import { scoreWorkerForJobOrder, type WorkerScoringInput } from "./scoring";

const MATCHING_TASK_TYPE = "match_workers_to_job_order";

function jobOrderIdFromInput(input: unknown): string | null {
  if (input && typeof input === "object" && "jobOrderId" in input) {
    const value = (input as { jobOrderId?: unknown }).jobOrderId;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function assessmentLabel(a: WorkerMatchResult["categoryAssessment"]): string {
  return a.detail ? `${a.label} (${a.detail})` : a.label;
}

function buildRationale(result: ReturnType<typeof scoreWorkerForJobOrder>): string {
  if (result.eligibility === "INELIGIBLE") {
    return `No elegible: ${result.gaps.join(" ")}`.trim();
  }
  const topStrength = result.strengths[0] ?? "sin fortalezas destacadas";
  return `Score determinista ${result.deterministicScore.toFixed(1)}/100. ${topStrength}`;
}

/**
 * Corre el matching determinista completo para un Job Order real —
 * evalúa cada Worker del tenant, aplica disponibilidad (F6.2) +
 * elegibilidad/score (F6.3), y devuelve el ranking completo. Solo
 * lectura: cero Assignment creada, cero Worker/JobOrder modificado.
 */
export async function runDeterministicMatching(jobOrderId: string): Promise<MatchRunResult> {
  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const workers = await scopedDb.worker.findMany({
    include: {
      candidate: { include: { categories: { select: { id: true } } } },
      documents: { include: { documentType: { select: { key: true } } } },
      assignments: {
        select: {
          id: true,
          status: true,
          startDate: true,
          endDate: true,
          jobOrder: { select: { categoryId: true, companyId: true } },
        },
      },
    },
  });

  const eligibleWorkers: WorkerMatchResult[] = [];
  const ineligibleWorkers: WorkerMatchResult[] = [];

  for (const worker of workers) {
    const assignmentsForAvailability: AssignmentForAvailability[] = worker.assignments.map((a) => ({
      id: a.id,
      status: a.status,
      startDate: a.startDate,
      endDate: a.endDate,
    }));

    const availability = evaluateWorkerAvailability({
      workerId: worker.id,
      workerStatus: worker.status,
      assignments: assignmentsForAvailability,
      jobOrderStartDate: jobOrder.startDate,
      jobOrderEndDate: jobOrder.endDate,
    });

    const scoringInput: WorkerScoringInput = {
      workerId: worker.id,
      candidateId: worker.candidateId,
      displayName: `${worker.candidate.firstName} ${worker.candidate.lastName}`,
      workerStatus: worker.status,
      complianceStatus: worker.complianceStatus,
      defaultPayRate: Number(worker.defaultPayRate),
      candidateCategoryIds: worker.candidate.categories.map((c) => c.id),
      yearsExperience: worker.candidate.yearsExperience,
      city: worker.candidate.city,
      state: worker.candidate.state,
      languages: worker.candidate.languages,
      candidateUpdatedAt: worker.candidate.updatedAt,
      documents: worker.documents.map((d) => ({ documentTypeKey: d.documentType.key, status: d.status })),
      assignmentHistory: worker.assignments.map((a) => ({
        status: a.status,
        categoryId: a.jobOrder.categoryId,
        companyId: a.jobOrder.companyId,
      })),
      availabilityStatus: availability.availabilityStatus,
      jobOrder: {
        categoryId: jobOrder.categoryId,
        companyId: jobOrder.companyId,
        requirements: Array.isArray(jobOrder.requirements) ? (jobOrder.requirements as unknown[]).map(String) : [],
        payRate: Number(jobOrder.payRate),
        location: jobOrder.location as { city?: string; state?: string } | null,
      },
    };

    const scoreResult = scoreWorkerForJobOrder(scoringInput);

    const matchResult: WorkerMatchResult = {
      workerId: worker.id,
      candidateId: worker.candidateId,
      displayName: scoringInput.displayName,
      workerStatus: worker.status,
      complianceStatus: worker.complianceStatus,
      availabilityStatus: availability.availabilityStatus,
      eligibility: scoreResult.eligibility,
      deterministicScore: scoreResult.deterministicScore,
      llmAdjustment: null,
      finalScore: scoreResult.deterministicScore,
      rationale: buildRationale(scoreResult),
      strengths: scoreResult.strengths,
      gaps: scoreResult.gaps,
      disqualifiers: scoreResult.disqualifiers,
      requiredDocumentsMissing: scoreResult.requiredDocumentsMissing,
      categoryAssessment: scoreResult.categoryAssessment,
      experienceAssessment: scoreResult.experienceAssessment,
      locationAssessment: scoreResult.locationAssessment,
      payRateAssessment: scoreResult.payRateAssessment,
      complianceAssessment: scoreResult.complianceAssessment,
      availabilityAssessment: scoreResult.availabilityAssessment,
      factors: scoreResult.factors,
    };

    if (matchResult.eligibility === "ELIGIBLE") eligibleWorkers.push(matchResult);
    else ineligibleWorkers.push(matchResult);
  }

  // Orden estable ante empate: finalScore desc, luego workerId asc — el
  // mismo input siempre produce el mismo orden, nunca depende del orden
  // de iteración de la DB.
  eligibleWorkers.sort((a, b) => b.finalScore - a.finalScore || a.workerId.localeCompare(b.workerId));
  ineligibleWorkers.sort((a, b) => a.workerId.localeCompare(b.workerId));

  return {
    schemaVersion: MATCH_SCHEMA_VERSION,
    algorithmVersion: MATCH_ALGORITHM_VERSION,
    jobOrderId: jobOrder.id,
    agentTaskId: null,
    generatedAt: new Date().toISOString(),
    provider: null,
    model: null,
    llmStatus: "NOT_RUN",
    deterministicOnly: true,
    cost: { usd: 0 },
    eligibleWorkers,
    ineligibleWorkers,
    warnings: [],
    inputSnapshot: {
      jobOrderId: jobOrder.id,
      categoryId: jobOrder.categoryId,
      requirements: Array.isArray(jobOrder.requirements) ? (jobOrder.requirements as unknown[]).map(String) : [],
      payRate: Number(jobOrder.payRate),
      startDate: jobOrder.startDate.toISOString(),
      endDate: jobOrder.endDate?.toISOString() ?? null,
      workersNeeded: jobOrder.workersNeeded,
      workersConsidered: workers.length,
    },
  };
}

// Reexport pequeño de utilidad para quien consuma el resultado y quiera
// mostrar una etiqueta legible sin reimplementar el formato — usado por
// el futuro frontend (F6.7), no por la lógica de matching en sí.
export { assessmentLabel };

// ---------- F6.6: API + historial (persistencia vía AgentTask.output) ----------

/**
 * Ejecuta el matching real para un Job Order — verify-then-act (el Job
 * Order debe existir en el tenant), guardia de concurrencia (best-effort:
 * si ya hay una corrida QUEUED/RUNNING para el mismo Job Order, 409 en
 * vez de duplicar el gasto de IA), crea el AgentTask real vía
 * createAndRunTaskSync (motor ya existente, sin modificar), y registra
 * Activity + AuditLog. Nunca crea Assignment, nunca modifica Worker/
 * JobOrder — el tool solo analiza y devuelve un ranking.
 */
export async function runMatchingForJobOrder(jobOrderId: string, withLlm?: boolean): Promise<AgentTaskDetail> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const inProgress = await scopedDb.agentTask.findMany({
    where: { type: MATCHING_TASK_TYPE, status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true, input: true },
  });
  if (inProgress.some((t) => jobOrderIdFromInput(t.input) === jobOrderId)) {
    throw AppError.conflict("A matching run is already in progress for this Job Order");
  }

  const task = await createAndRunTaskSync(ctx.tenantId, ctx.userId, {
    agentKey: "recruiter",
    type: MATCHING_TASK_TYPE,
    input: withLlm === undefined ? { jobOrderId } : { jobOrderId, withLlm },
    triggeredBy: "USER",
  });

  const output = task.output as MatchRunResult | null;
  const eligibleCount = output?.eligibleWorkers.length ?? 0;
  const ineligibleCount = output?.ineligibleWorkers.length ?? 0;

  await logActivity({
    entityType: "jobOrder",
    entityId: jobOrderId,
    type: "SYSTEM",
    subject:
      task.status === "DONE"
        ? `AI Matching run: ${eligibleCount} eligible worker(s) found`
        : `AI Matching run failed: ${task.errorMessage ?? "unknown error"}`,
  });

  await logAuditEvent({
    action: task.status === "DONE" ? "matching.executed" : "matching.failed",
    entityType: "jobOrder",
    entityId: jobOrderId,
    after: {
      agentTaskId: task.id,
      workersEvaluated: eligibleCount + ineligibleCount,
      eligibleCount,
      costUsd: output?.cost.usd ?? Number(task.costUsd ?? 0),
      schemaVersion: output?.schemaVersion ?? null,
      algorithmVersion: output?.algorithmVersion ?? null,
      llmStatus: output?.llmStatus ?? null,
    },
  });

  return toAgentTaskDetail(task);
}

/**
 * Última corrida de matching para un Job Order — 404 si nunca se corrió
 * ninguna (nunca inventa un resultado vacío).
 */
export async function getLatestMatchingRun(jobOrderId: string): Promise<AgentTaskDetail> {
  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId }, select: { id: true } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const candidates = await scopedDb.agentTask.findMany({
    where: { type: MATCHING_TASK_TYPE },
    orderBy: { createdAt: "desc" },
  });
  const latest = candidates.find((t) => jobOrderIdFromInput(t.input) === jobOrderId);
  if (!latest) throw AppError.notFound("No matching run found for this Job Order");

  return toAgentTaskDetail(latest);
}

/**
 * Historial paginado de corridas de matching para un Job Order —
 * convierte cada AgentTask a MatchHistoryEntry (taskId/createdAt/status/
 * cost/algorithmVersion/eligibleCount/ineligibleCount/topScore), nunca
 * expone el output completo (eso es .../matching/latest o el detalle
 * puntual, no el listado).
 */
export async function getMatchingHistory(
  jobOrderId: string,
  query: { cursor?: string; limit?: number },
): Promise<Paginated<MatchHistoryEntry>> {
  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId }, select: { id: true } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  // Filtrado en memoria (no vía Json path query de Prisma, sin
  // precedente probado en este repo): el volumen de AgentTask de
  // matching por tenant es bajo, un findMany + filter es simple y
  // seguro. Se pagina DESPUÉS de filtrar, sobre el conjunto ya acotado
  // a este Job Order.
  const all = await scopedDb.agentTask.findMany({
    where: { type: MATCHING_TASK_TYPE },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const forThisJobOrder = all.filter((t) => jobOrderIdFromInput(t.input) === jobOrderId);

  // toCursorPage() por sí sola no reanuda desde un cursor — asume que
  // el `where`/`skip` ya lo hizo la consulta SQL (ver buildCursorArgs).
  // Como acá el filtrado por jobOrderId es en memoria, el avance de
  // cursor también se hace en memoria: se ubica la posición del cursor
  // en el arreglo ya ordenado y se continúa justo después.
  const startIndex = query.cursor ? forThisJobOrder.findIndex((t) => t.id === query.cursor) + 1 : 0;
  const limit = query.limit ?? 20;
  const page = forThisJobOrder.slice(startIndex, startIndex + limit + 1);
  const { items, nextCursor } = toCursorPage(page, limit);

  const entries: MatchHistoryEntry[] = items.map((t) => {
    const output = t.output as MatchRunResult | null;
    const eligibleCount = output?.eligibleWorkers.length ?? 0;
    const topScore = eligibleCount > 0 ? Math.max(...output!.eligibleWorkers.map((w) => w.finalScore)) : null;
    return {
      taskId: t.id,
      createdAt: t.createdAt.toISOString(),
      status: t.status,
      cost: Number(t.costUsd ?? 0),
      algorithmVersion: output?.algorithmVersion ?? MATCH_ALGORITHM_VERSION,
      eligibleCount,
      ineligibleCount: output?.ineligibleWorkers.length ?? 0,
      topScore,
    };
  });

  return { items: entries, nextCursor };
}
