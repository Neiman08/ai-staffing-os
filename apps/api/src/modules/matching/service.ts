// F6.4: orquestador determinista del matching Job Order <-> Worker —
// une la disponibilidad real (F6.2) y el scoring determinista (F6.3)
// contra datos reales del tenant, vía scopedDb (tenancy automática,
// nunca acepta un tenantId por parámetro). Sin IA, sin AgentTask, sin
// escritura — la capa LLM (F6.5) y la persistencia (F6.6) se agregan
// encima de esta función, nunca la modifican.

import type { MatchRunResult, WorkerMatchResult } from "@ai-staffing-os/shared";
import { MATCH_ALGORITHM_VERSION, MATCH_SCHEMA_VERSION } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { evaluateWorkerAvailability, type AssignmentForAvailability } from "./availability";
import { scoreWorkerForJobOrder, type WorkerScoringInput } from "./scoring";

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
