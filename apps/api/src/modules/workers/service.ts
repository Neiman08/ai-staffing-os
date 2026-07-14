import type { WorkerDetail, WorkerDocument } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";

/**
 * F5.2: superficie mínima aprobada — GET /workers/:id únicamente, para
 * verificar que la conversión desde Candidate funcionó. Listado completo,
 * edición, filtros y disponibilidad de Worker quedan para el bloque
 * siguiente (ver docs/F5_STAFFING_OPERATIONS_PLAN.md §5).
 */
export async function getWorkerDetail(id: string): Promise<WorkerDetail> {
  const worker = await scopedDb.worker.findUnique({
    where: { id },
    include: {
      candidate: true,
      documents: { include: { documentType: true } },
    },
  });
  if (!worker) throw AppError.notFound("Worker not found");

  // F5.2 §8 (aprobado): nunca se mueven ni duplican documentos en la
  // conversión — acá se combinan, en memoria, los del Worker con los del
  // Candidate de origen (vía la relación 1:1), marcando su procedencia.
  const candidateDocuments = await scopedDb.document.findMany({
    where: { candidateId: worker.candidateId },
    include: { documentType: true },
  });

  const workerDocuments: WorkerDocument[] = worker.documents.map((doc) => ({
    id: doc.id,
    documentTypeName: doc.documentType.name,
    status: doc.status,
    expirationDate: doc.expirationDate?.toISOString() ?? null,
    source: "worker",
  }));

  const fromCandidateDocuments: WorkerDocument[] = candidateDocuments.map((doc) => ({
    id: doc.id,
    documentTypeName: doc.documentType.name,
    status: doc.status,
    expirationDate: doc.expirationDate?.toISOString() ?? null,
    source: "candidate",
  }));

  return {
    id: worker.id,
    candidateId: worker.candidateId,
    candidateName: `${worker.candidate.firstName} ${worker.candidate.lastName}`,
    employmentType: worker.employmentType,
    defaultPayRate: worker.defaultPayRate.toString(),
    status: worker.status,
    complianceStatus: worker.complianceStatus,
    hiredAt: worker.hiredAt?.toISOString() ?? null,
    documents: [...workerDocuments, ...fromCandidateDocuments],
    createdAt: worker.createdAt.toISOString(),
  };
}
