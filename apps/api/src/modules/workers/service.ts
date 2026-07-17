import type {
  CreateWorkerInput,
  Paginated,
  UpdateWorkerInput,
  UpdateWorkerStatusInput,
  WorkerDetail,
  WorkerDocument,
  WorkerListItem,
  WorkerQuery,
} from "@ai-staffing-os/shared";
import { isValidWorkerStatusTransition, WORKER_STATUS_TRANSITIONS } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";
import { createWorkerFromQualifiedCandidate } from "../talent/service";
import {
  evaluateOnboardingProgress,
  isValidOnboardingTransition,
  type OnboardingStatus,
  type PlacementReadinessStatusLike,
} from "../operations-intelligence/worker-onboarding";
import {
  buildChecklistFromRequirements,
  isValidChecklistItemTransition,
  type ChecklistItemStatus,
} from "../operations-intelligence/document-checklist";

type WorkerRow = {
  id: string;
  candidateId: string;
  candidate: { firstName: string; lastName: string; city: string | null; state: string | null; categories: { name: string }[] };
  employmentType: string;
  defaultPayRate: { toString(): string };
  status: string;
  complianceStatus: string;
  hiredAt: Date | null;
  createdAt: Date;
};

function toListItem(worker: WorkerRow): WorkerListItem {
  return {
    id: worker.id,
    candidateId: worker.candidateId,
    candidateName: `${worker.candidate.firstName} ${worker.candidate.lastName}`,
    city: worker.candidate.city,
    state: worker.candidate.state,
    categoryNames: worker.candidate.categories.map((c) => c.name),
    employmentType: worker.employmentType as never,
    defaultPayRate: worker.defaultPayRate.toString(),
    status: worker.status as never,
    complianceStatus: worker.complianceStatus,
    hiredAt: worker.hiredAt?.toISOString() ?? null,
    createdAt: worker.createdAt.toISOString(),
  };
}

const WORKER_WITH_CANDIDATE_INCLUDE = { candidate: { include: { categories: true } } } as const;

export async function listWorkers(query: WorkerQuery): Promise<Paginated<WorkerListItem>> {
  const sortField = query.sortBy ?? "createdAt";
  const sortDir = query.sortDir ?? "desc";

  const rows = await scopedDb.worker.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit: query.limit ?? 20 }),
    where: {
      status: query.status,
      employmentType: query.employmentType,
      complianceStatus: query.complianceStatus,
      candidate: {
        OR: query.search
          ? [
              { firstName: { contains: query.search, mode: "insensitive" } },
              { lastName: { contains: query.search, mode: "insensitive" } },
            ]
          : undefined,
        state: query.state,
        city: query.city,
        categories: query.categoryId ? { some: { id: query.categoryId } } : undefined,
      },
    },
    orderBy: [{ [sortField]: sortDir }, { id: sortDir }],
    include: WORKER_WITH_CANDIDATE_INCLUDE,
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit ?? 20);
  return { items: items.map(toListItem), nextCursor };
}

export async function getWorkerDetail(id: string): Promise<WorkerDetail> {
  const worker = await scopedDb.worker.findUnique({
    where: { id },
    include: {
      candidate: { include: { categories: true } },
      documents: { include: { documentType: true } },
    },
  });
  if (!worker) throw AppError.notFound("Worker not found");

  // F5.2 §8 (aprobado, mantenido en F5.3): nunca se mueven ni duplican
  // documentos — se combinan en memoria los del Worker con los del
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
    ...toListItem(worker),
    email: worker.candidate.email,
    phone: worker.candidate.phone,
    languages: worker.candidate.languages,
    documents: [...workerDocuments, ...fromCandidateDocuments],
    updatedAt: worker.updatedAt.toISOString(),
  };
}

/**
 * F5.3: Worker.candidateId es una FK única y NO nullable (schema.prisma)
 * — no existe "crear un Worker desde cero". Esta es la misma operación
 * que POST /candidates/:id/convert-to-worker (F5.2): un Candidate
 * QUALIFIED sin Worker todavía. Reutiliza createWorkerFromQualifiedCandidate
 * (talent/service.ts) para no duplicar ni divergir la regla de negocio ni
 * la transacción — la única diferencia real frente al endpoint de F5.2 es
 * de UX (se llega desde el listado de Workers, con el Candidate elegido en
 * un selector, en vez de desde la página de detalle del Candidate) y de
 * semántica de error: acá un Candidate que ya tiene Worker es un 409
 * (intento explícito de "crear" algo que ya existe), no un no-op
 * idempotente como en el botón contextual de Candidate Detail.
 */
export async function createWorker(input: CreateWorkerInput): Promise<WorkerListItem> {
  const candidate = await scopedDb.candidate.findUnique({
    where: { id: input.candidateId },
    include: { worker: true },
  });
  if (!candidate) throw AppError.badRequest("Candidate not found");

  if (candidate.worker) {
    throw AppError.conflict("This Candidate has already been converted to a Worker", {
      existingWorkerId: candidate.worker.id,
    });
  }

  const worker = await createWorkerFromQualifiedCandidate(candidate, {
    employmentType: input.employmentType,
    defaultPayRate: input.defaultPayRate,
  });

  if (input.hiredAt) {
    await scopedDb.worker.update({ where: { id: worker.id }, data: { hiredAt: new Date(input.hiredAt) } });
  }

  // F5.3: se audita en ambas entidades — el Worker (creado) y el
  // Candidate (movido a PLACED como efecto de esta misma operación),
  // mismo criterio que convertCandidateToWorker ya aplica del lado del
  // Candidate. Sin PII en metadata (solo IDs/estados).
  await logActivity({
    entityType: "worker",
    entityId: worker.id,
    type: "SYSTEM",
    subject: `Worker created manually from Candidate ${candidate.firstName} ${candidate.lastName}`,
  });
  await logAuditEvent({
    action: "worker.created",
    entityType: "worker",
    entityId: worker.id,
    after: { candidateId: candidate.id, status: worker.status, employmentType: worker.employmentType },
  });
  await logActivity({
    entityType: "candidate",
    entityId: candidate.id,
    type: "SYSTEM",
    subject: "Candidate converted to Worker",
  });
  await logAuditEvent({
    action: "candidate.converted_to_worker",
    entityType: "candidate",
    entityId: candidate.id,
    before: { status: "QUALIFIED" },
    after: { status: "PLACED", workerId: worker.id },
  });

  return getListItemById(worker.id);
}

async function getListItemById(id: string): Promise<WorkerListItem> {
  const worker = await scopedDb.worker.findUnique({ where: { id }, include: WORKER_WITH_CANDIDATE_INCLUDE });
  if (!worker) throw AppError.notFound("Worker not found");
  return toListItem(worker);
}

export async function updateWorker(id: string, input: UpdateWorkerInput): Promise<WorkerListItem> {
  // Verify-then-act: scopedDb.worker.findUnique ya está tenant-scoped
  // (STRICT_TENANT_MODELS) — si el registro es de otro tenant, esto
  // devuelve null antes de tocar nada.
  const existing = await scopedDb.worker.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Worker not found");

  const updated = await scopedDb.worker.update({
    where: { id },
    data: {
      employmentType: input.employmentType,
      defaultPayRate: input.defaultPayRate,
      hiredAt: input.hiredAt !== undefined ? new Date(input.hiredAt) : undefined,
      // F5.3: status/complianceStatus/candidateId/tenantId nunca aparecen
      // acá — updateWorkerInputSchema no los declara. complianceStatus es
      // dominio de Compliance (fuera de alcance de F5.3); status se
      // cambia únicamente vía PATCH /workers/:id/status.
    },
    include: WORKER_WITH_CANDIDATE_INCLUDE,
  });

  await logActivity({
    entityType: "worker",
    entityId: id,
    type: "SYSTEM",
    subject: "Worker updated",
  });
  await logAuditEvent({
    action: "worker.updated",
    entityType: "worker",
    entityId: id,
    before: { employmentType: existing.employmentType, defaultPayRate: existing.defaultPayRate.toString() },
    after: { employmentType: updated.employmentType, defaultPayRate: updated.defaultPayRate.toString() },
  });

  return toListItem(updated);
}

export async function updateWorkerStatus(id: string, input: UpdateWorkerStatusInput): Promise<WorkerListItem> {
  const existing = await scopedDb.worker.findUnique({ where: { id }, include: WORKER_WITH_CANDIDATE_INCLUDE });
  if (!existing) throw AppError.notFound("Worker not found");

  const from = existing.status as never;
  const to = input.status;

  // F5.3: idempotente — pedir el estado ya vigente es un no-op exitoso,
  // nunca un error ni una segunda entrada de Activity/AuditLog.
  if (from === to) {
    return toListItem(existing);
  }

  // F5.3: ASSIGNED nunca es un destino manual válido (mismo criterio que
  // JobOrder.PARTIALLY_FILLED/FILLED en F5.1) — se automatiza cuando
  // exista el módulo de Assignments, fuera de alcance acá.
  if (!isValidWorkerStatusTransition(from, to)) {
    throw AppError.badRequest(`Cannot transition Worker from ${existing.status} to ${to}`, {
      from: existing.status,
      to,
      allowedFromCurrentStatus: WORKER_STATUS_TRANSITIONS[from],
    });
  }

  const updated = await scopedDb.worker.update({
    where: { id },
    data: { status: to },
    include: WORKER_WITH_CANDIDATE_INCLUDE,
  });

  await logActivity({
    entityType: "worker",
    entityId: id,
    type: "SYSTEM",
    subject: `Status changed: ${existing.status} → ${to}`,
  });
  await logAuditEvent({
    action: "worker.status_changed",
    entityType: "worker",
    entityId: id,
    before: { status: existing.status },
    after: { status: to },
  });

  return toListItem(updated);
}

// ================= F9.1: Worker Onboarding =================

export interface WorkerOnboardingRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  workerId: string | null;
  status: OnboardingStatus;
  progress: number;
  blockers: string[];
  warnings: string[];
  nextBestAction: string;
  requiresApproval: true;
  rulesVersion: number;
  startedById: string | null;
  createdAt: string;
  updatedAt: string;
}

function toOnboardingRecord(record: {
  id: string;
  candidateId: string;
  jobOrderId: string;
  workerId: string | null;
  status: string;
  progress: number;
  blockers: string[];
  warnings: string[];
  nextBestAction: string;
  rulesVersion: number;
  startedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): WorkerOnboardingRecord {
  return {
    id: record.id,
    candidateId: record.candidateId,
    jobOrderId: record.jobOrderId,
    workerId: record.workerId,
    status: record.status as OnboardingStatus,
    progress: record.progress,
    blockers: record.blockers,
    warnings: record.warnings,
    nextBestAction: record.nextBestAction,
    requiresApproval: true,
    rulesVersion: record.rulesVersion,
    startedById: record.startedById,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Reevalúa progress/blockers/warnings/nextBestAction para el `status`
 * dado -- reutiliza `PlacementReadiness.readinessStatus` (F8.10, NUNCA
 * recalculado acá) y el `complianceStatus` del Worker si ya existe.
 */
async function computeOnboardingSignals(
  candidateId: string,
  jobOrderId: string,
  status: OnboardingStatus,
): Promise<ReturnType<typeof evaluateOnboardingProgress>> {
  const [candidate, placementReadiness] = await Promise.all([
    scopedDb.candidate.findUnique({ where: { id: candidateId }, include: { worker: true } }),
    scopedDb.placementReadiness.findFirst({ where: { candidateId, jobOrderId }, select: { readinessStatus: true } }),
  ]);
  if (!candidate) throw AppError.notFound("Candidate not found");
  if (!placementReadiness) {
    throw AppError.badRequest("No Placement Readiness evaluation found for this candidate and job order -- run it first", {
      candidateId,
      jobOrderId,
    });
  }

  return evaluateOnboardingProgress({
    status,
    placementReadinessStatus: placementReadiness.readinessStatus as PlacementReadinessStatusLike,
    hasExistingWorker: !!candidate.worker,
    workerComplianceStatus: candidate.worker?.complianceStatus ?? null,
  });
}

/**
 * F9.1: inicia el onboarding de un Candidate ya "autorizado" -- exige
 * una `PlacementReadiness` YA evaluada (F8.10, consumida como señal,
 * nunca recalculada) para el mismo par. Idempotente por
 * (candidateId, jobOrderId): si ya existe un registro, lo devuelve tal
 * cual sin crear un segundo ni reiniciar su progreso. `INVITED` es un
 * estado interno/preview -- nunca se envía una invitación real (no hay
 * integración de email/SMS en este proyecto). Si el Candidate ya tiene
 * un Worker (conversión previa vía F5.2), se enlaza automáticamente
 * -- nunca se crea uno nuevo acá.
 */
export async function startWorkerOnboarding(candidateId: string, jobOrderId: string): Promise<WorkerOnboardingRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.workerOnboarding.findFirst({ where: { candidateId, jobOrderId } });
  if (existing) return toOnboardingRecord(existing);

  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId }, select: { id: true } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const candidate = await scopedDb.candidate.findUnique({ where: { id: candidateId }, include: { worker: true } });
  if (!candidate) throw AppError.notFound("Candidate not found");

  const signals = await computeOnboardingSignals(candidateId, jobOrderId, "INVITED");

  const record = await scopedDb.workerOnboarding.create({
    data: {
      tenantId: ctx.tenantId,
      candidateId,
      jobOrderId,
      workerId: candidate.worker?.id ?? null,
      status: "INVITED",
      progress: signals.progress,
      blockers: signals.blockers,
      warnings: signals.warnings,
      nextBestAction: signals.nextBestAction,
      rulesVersion: signals.rulesVersion,
      startedById: ctx.userId,
    },
  });

  await logAuditEvent({
    action: "worker.onboarding_started",
    entityType: "worker_onboarding",
    entityId: record.id,
    after: { candidateId, jobOrderId, status: record.status },
  });

  return toOnboardingRecord(record);
}

/** Lee el onboarding YA persistido -- nunca lo inicia. */
export async function getWorkerOnboarding(candidateId: string, jobOrderId: string): Promise<WorkerOnboardingRecord | null> {
  const record = await scopedDb.workerOnboarding.findFirst({ where: { candidateId, jobOrderId } });
  if (!record) return null;
  return toOnboardingRecord(record);
}

/**
 * Único camino para cambiar `status`. Valida la transición
 * (`isValidOnboardingTransition`) y, específicamente, RECHAZA moverse a
 * `ACTIVE` si todavía no existe un Worker -- nunca lo crea/activa acá,
 * eso sigue siendo responsabilidad exclusiva del flujo ya existente
 * `convertCandidateToWorker`/`createWorker` (F5.2/F5.3).
 */
export async function updateWorkerOnboardingStatus(
  candidateId: string,
  jobOrderId: string,
  status: OnboardingStatus,
): Promise<WorkerOnboardingRecord> {
  const existing = await scopedDb.workerOnboarding.findFirst({ where: { candidateId, jobOrderId } });
  if (!existing) throw AppError.notFound("Worker onboarding not found");

  const currentStatus = existing.status as OnboardingStatus;
  if (!isValidOnboardingTransition(currentStatus, status)) {
    throw AppError.badRequest(`Invalid onboarding status transition: ${currentStatus} -> ${status}`);
  }

  // Re-vincula workerId por si se convirtió el Candidate en Worker
  // DESPUÉS de iniciar el onboarding (F5.2, flujo separado) -- nunca lo
  // crea acá, solo lee la relación ya existente. Se resuelve ANTES del
  // guard de ACTIVE para no depender del valor ya persistido (que puede
  // seguir en null si la conversión ocurrió después del último cambio
  // de estado registrado).
  const candidate = await scopedDb.candidate.findUnique({ where: { id: candidateId }, include: { worker: true } });
  const workerId = candidate?.worker?.id ?? existing.workerId;

  if (status === "ACTIVE" && !workerId) {
    throw AppError.badRequest(
      "Cannot activate onboarding: no Worker exists yet for this Candidate -- convert the Candidate to a Worker first",
      { candidateId },
    );
  }

  const signals = await computeOnboardingSignals(candidateId, jobOrderId, status);

  const updated = await scopedDb.workerOnboarding.update({
    where: { id: existing.id },
    data: {
      status,
      workerId,
      progress: signals.progress,
      blockers: signals.blockers,
      warnings: signals.warnings,
      nextBestAction: signals.nextBestAction,
      rulesVersion: signals.rulesVersion,
    },
  });

  await logAuditEvent({
    action: "worker.onboarding_status_changed",
    entityType: "worker_onboarding",
    entityId: existing.id,
    before: { status: currentStatus },
    after: { status },
  });

  return toOnboardingRecord(updated);
}

// ================= F9.2: Document Checklist =================

export interface DocumentChecklistItemRecord {
  id: string;
  workerOnboardingId: string;
  documentTypeId: string;
  documentTypeKey: string;
  documentId: string | null;
  label: string;
  required: boolean;
  status: ChecklistItemStatus;
  source: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
  verifiedById: string | null;
  rejectionReason: string | null;
  notes: string | null;
  manualReviewRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

function toChecklistItemRecord(record: {
  id: string;
  workerOnboardingId: string;
  documentTypeId: string;
  documentType: { key: string };
  documentId: string | null;
  label: string;
  required: boolean;
  status: string;
  source: string | null;
  expiresAt: Date | null;
  verifiedAt: Date | null;
  verifiedById: string | null;
  rejectionReason: string | null;
  notes: string | null;
  manualReviewRequired: boolean;
  createdAt: Date;
  updatedAt: Date;
}): DocumentChecklistItemRecord {
  return {
    id: record.id,
    workerOnboardingId: record.workerOnboardingId,
    documentTypeId: record.documentTypeId,
    documentTypeKey: record.documentType.key,
    documentId: record.documentId,
    label: record.label,
    required: record.required,
    status: record.status as ChecklistItemStatus,
    source: record.source,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    verifiedById: record.verifiedById,
    rejectionReason: record.rejectionReason,
    notes: record.notes,
    manualReviewRequired: record.manualReviewRequired,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * F9.2: genera el checklist de documentos requeridos para un
 * `WorkerOnboarding` YA iniciado (404 si no existe -- nunca lo inicia
 * acá), a partir de `JobOrder.requirements` (ya existente, nunca una
 * lista inventada). Idempotente: solo CREA los items faltantes -- nunca
 * pisa el estado de un item ya existente (mismo criterio que
 * `generateShortlistForJobOrder`, F8.7: regenerar nunca revierte una
 * decisión/progreso humano ya hecho).
 */
export async function generateChecklistForOnboarding(
  candidateId: string,
  jobOrderId: string,
): Promise<DocumentChecklistItemRecord[]> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const onboarding = await scopedDb.workerOnboarding.findFirst({ where: { candidateId, jobOrderId } });
  if (!onboarding) throw AppError.notFound("Worker onboarding not found -- start onboarding first");

  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId }, select: { requirements: true } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const requiredKeys = Array.isArray(jobOrder.requirements) ? (jobOrder.requirements as unknown[]).map(String) : [];
  const documentTypes = requiredKeys.length > 0 ? await scopedDb.documentType.findMany({ where: { key: { in: requiredKeys } } }) : [];

  const drafts = buildChecklistFromRequirements(
    documentTypes.map((dt) => ({ documentTypeId: dt.id, documentTypeKey: dt.key, documentTypeName: dt.name })),
    Object.fromEntries(documentTypes.map((dt) => [dt.id, dt.requiresExpiration])),
  );

  const existingItems = await scopedDb.documentChecklistItem.findMany({
    where: { workerOnboardingId: onboarding.id },
    select: { documentTypeId: true },
  });
  const existingTypeIds = new Set(existingItems.map((i) => i.documentTypeId));

  const toCreate = drafts.filter((d) => !existingTypeIds.has(d.documentTypeId));
  if (toCreate.length > 0) {
    await scopedDb.documentChecklistItem.createMany({
      data: toCreate.map((d) => ({
        tenantId: ctx.tenantId,
        workerOnboardingId: onboarding.id,
        documentTypeId: d.documentTypeId,
        label: d.label,
        required: d.required,
        status: d.status,
        manualReviewRequired: d.manualReviewRequired,
      })),
    });

    await logAuditEvent({
      action: "worker.checklist_generated",
      entityType: "worker_onboarding",
      entityId: onboarding.id,
      after: { candidateId, jobOrderId, itemsCreated: toCreate.length },
    });
  }

  const allItems = await scopedDb.documentChecklistItem.findMany({
    where: { workerOnboardingId: onboarding.id },
    include: { documentType: { select: { key: true } } },
    orderBy: { createdAt: "asc" },
  });
  return allItems.map(toChecklistItemRecord);
}

/** Lee el checklist YA generado. Nunca lo regenera. */
export async function getChecklistForOnboarding(candidateId: string, jobOrderId: string): Promise<DocumentChecklistItemRecord[]> {
  const onboarding = await scopedDb.workerOnboarding.findFirst({ where: { candidateId, jobOrderId }, select: { id: true } });
  if (!onboarding) throw AppError.notFound("Worker onboarding not found");

  const items = await scopedDb.documentChecklistItem.findMany({
    where: { workerOnboardingId: onboarding.id },
    include: { documentType: { select: { key: true } } },
    orderBy: { createdAt: "asc" },
  });
  return items.map(toChecklistItemRecord);
}

export interface UpdateChecklistItemInput {
  status: ChecklistItemStatus;
  expiresAt?: string | null;
  rejectionReason?: string | null;
  notes?: string | null;
}

/**
 * Único camino para cambiar el estado de un item de checklist -- valida
 * la transición (`isValidChecklistItemTransition`). Marcar `VERIFIED`
 * registra `verifiedAt`/`verifiedById` del contexto de tenancy, nunca
 * del body. Nunca crea/modifica el `Document` real -- ese enlace
 * (`documentId`) sigue siendo responsabilidad del módulo de compliance
 * ya existente.
 */
export async function updateChecklistItemStatus(
  itemId: string,
  input: UpdateChecklistItemInput,
): Promise<DocumentChecklistItemRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.documentChecklistItem.findUnique({ where: { id: itemId } });
  if (!existing) throw AppError.notFound("Checklist item not found");

  const currentStatus = existing.status as ChecklistItemStatus;
  if (!isValidChecklistItemTransition(currentStatus, input.status)) {
    throw AppError.badRequest(`Invalid checklist item status transition: ${currentStatus} -> ${input.status}`);
  }

  const updated = await scopedDb.documentChecklistItem.update({
    where: { id: itemId },
    data: {
      status: input.status,
      expiresAt: input.expiresAt !== undefined ? (input.expiresAt ? new Date(input.expiresAt) : null) : undefined,
      rejectionReason: input.rejectionReason !== undefined ? input.rejectionReason : undefined,
      notes: input.notes !== undefined ? input.notes : undefined,
      verifiedAt: input.status === "VERIFIED" ? new Date() : existing.verifiedAt,
      verifiedById: input.status === "VERIFIED" ? ctx.userId : existing.verifiedById,
    },
    include: { documentType: { select: { key: true } } },
  });

  await logAuditEvent({
    action: "worker.checklist_item_status_changed",
    entityType: "document_checklist_item",
    entityId: itemId,
    before: { status: currentStatus },
    after: { status: input.status },
  });

  return toChecklistItemRecord(updated);
}
