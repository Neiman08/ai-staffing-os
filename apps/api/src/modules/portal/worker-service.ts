/**
 * F10.4/F10.5: Worker Portal -- TODA función exige `ctx.workerId`
 * (F10.1) y filtra explícitamente por él. Nunca expone rankings frente
 * a otros Workers, notas internas de recruiting, ni datos de otro
 * Worker.
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";
import { documentStorageAdapter } from "../../core/document-storage/local-mock.provider";
import { isValidChecklistItemTransition, type ChecklistItemStatus } from "../operations-intelligence/document-checklist";

function requireWorkerContext(): { tenantId: string; workerId: string } {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  if (!ctx.workerId) throw AppError.forbidden("This account is not linked to a Worker portal identity");
  return { tenantId: ctx.tenantId, workerId: ctx.workerId };
}

export interface WorkerProfile {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  languages: string[];
  availabilityNotes: string | null;
  skills: string[];
  employmentType: string;
  defaultPayRate: string;
  status: string;
  complianceStatus: string;
  hiredAt: string | null;
}

function toWorkerProfile(worker: {
  id: string;
  employmentType: string;
  defaultPayRate: { toString(): string };
  status: string;
  complianceStatus: string;
  hiredAt: Date | null;
  candidate: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    languages: string[];
    availabilityNotes: string | null;
    skills: string[];
  };
}): WorkerProfile {
  return {
    id: worker.id,
    firstName: worker.candidate.firstName,
    lastName: worker.candidate.lastName,
    email: worker.candidate.email,
    phone: worker.candidate.phone,
    city: worker.candidate.city,
    state: worker.candidate.state,
    languages: worker.candidate.languages,
    availabilityNotes: worker.candidate.availabilityNotes,
    skills: worker.candidate.skills,
    employmentType: worker.employmentType,
    defaultPayRate: worker.defaultPayRate.toString(),
    status: worker.status,
    complianceStatus: worker.complianceStatus,
    hiredAt: worker.hiredAt?.toISOString() ?? null,
  };
}

export async function getWorkerProfile(): Promise<WorkerProfile> {
  const { workerId } = requireWorkerContext();
  const worker = await scopedDb.worker.findUnique({ where: { id: workerId }, include: { candidate: true } });
  if (!worker) throw AppError.notFound("Worker not found");
  return toWorkerProfile(worker);
}

export interface UpdateWorkerProfileInput {
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  languages?: string[];
  availabilityNotes?: string | null;
  skills?: string[];
}

/**
 * F10.5: SOLO los campos de autoservicio real -- nunca employmentType/
 * defaultPayRate/status/complianceStatus (decisiones internas de HR/
 * compliance, fuera de alcance de un self-update). `updateWorkerProfileInputSchema`
 * a nivel de router ni siquiera declara esos campos.
 */
export async function updateWorkerProfile(input: UpdateWorkerProfileInput): Promise<WorkerProfile> {
  const { workerId } = requireWorkerContext();
  const worker = await scopedDb.worker.findUnique({ where: { id: workerId } });
  if (!worker) throw AppError.notFound("Worker not found");

  const updated = await scopedDb.candidate.update({
    where: { id: worker.candidateId },
    data: {
      phone: input.phone !== undefined ? input.phone : undefined,
      city: input.city !== undefined ? input.city : undefined,
      state: input.state !== undefined ? input.state : undefined,
      languages: input.languages,
      availabilityNotes: input.availabilityNotes !== undefined ? input.availabilityNotes : undefined,
      skills: input.skills,
    },
  });

  await logAuditEvent({
    action: "portal.worker_profile_updated",
    entityType: "candidate",
    entityId: updated.id,
    after: { phone: updated.phone, city: updated.city, state: updated.state },
  });

  const refreshed = await scopedDb.worker.findUniqueOrThrow({ where: { id: workerId }, include: { candidate: true } });
  return toWorkerProfile(refreshed);
}

export interface WorkerOnboardingSummaryItem {
  id: string;
  jobOrderId: string;
  jobOrderTitle: string;
  status: string;
  progress: number;
  nextBestAction: string;
}

export async function listWorkerOnboarding(): Promise<WorkerOnboardingSummaryItem[]> {
  const { workerId } = requireWorkerContext();
  const rows = await scopedDb.workerOnboarding.findMany({
    where: { workerId },
    include: { jobOrder: { select: { title: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    jobOrderId: r.jobOrderId,
    jobOrderTitle: r.jobOrder.title,
    status: r.status,
    progress: r.progress,
    nextBestAction: r.nextBestAction,
  }));
}

export interface WorkerDocumentItem {
  id: string;
  label: string;
  status: string;
  required: boolean;
  expiresAt: string | null;
  rejectionReason: string | null;
}

export async function listWorkerDocuments(): Promise<WorkerDocumentItem[]> {
  const { workerId } = requireWorkerContext();
  const items = await scopedDb.documentChecklistItem.findMany({
    where: { workerOnboarding: { workerId } },
    orderBy: { createdAt: "asc" },
  });
  return items.map((i) => ({
    id: i.id,
    label: i.label,
    status: i.status,
    required: i.required,
    expiresAt: i.expiresAt?.toISOString() ?? null,
    rejectionReason: i.rejectionReason,
  }));
}

/**
 * F10.5: "subir" un documento -- SOLO metadata (fileName), NUNCA bytes
 * reales (`DocumentStorageAdapter`, ver docs/F10_PLAN.md §7.1 -- ningún
 * proveedor real de storage existe todavía). Verifica ownership
 * (el item pertenece a un WorkerOnboarding de ESTE Worker) antes de
 * reutilizar el grafo de transiciones ya validado de F9.2
 * (`isValidChecklistItemTransition`) -- PENDING/UNDER_REVIEW/REJECTED
 * -> SUBMITTED, nunca otra transición.
 */
export async function submitWorkerDocument(itemId: string, input: { fileName: string; notes?: string | null }) {
  const { tenantId, workerId } = requireWorkerContext();
  const item = await scopedDb.documentChecklistItem.findUnique({ where: { id: itemId }, include: { workerOnboarding: true } });
  if (!item || item.workerOnboarding.workerId !== workerId) throw AppError.notFound("Checklist item not found");

  const from = item.status as ChecklistItemStatus;
  if (!isValidChecklistItemTransition(from, "SUBMITTED")) {
    throw AppError.badRequest(`Cannot submit a document that is ${from}`);
  }

  const stored = await documentStorageAdapter.store({ fileName: input.fileName });

  // F10.5: crea el Document real (relación ya modelada desde F0, nunca
  // usada hasta ahora por un flujo de portal) -- `fileUrl` guarda la
  // referencia MOCK, nunca una URL real navegable. `source` conserva su
  // significado original de F9.2 ("cómo se originó este item"), no se
  // reutiliza para la referencia de storage.
  const document = await scopedDb.document.create({
    data: {
      tenantId,
      documentTypeId: item.documentTypeId,
      candidateId: item.workerOnboarding.candidateId,
      workerId: item.workerOnboarding.workerId,
      fileUrl: stored.reference,
      status: "PENDING_REVIEW",
    },
  });

  const updated = await scopedDb.documentChecklistItem.update({
    where: { id: itemId },
    data: { status: "SUBMITTED", source: "worker_upload", documentId: document.id, notes: input.notes ?? undefined },
  });

  await logAuditEvent({
    action: "portal.worker_document_submitted",
    entityType: "document_checklist_item",
    entityId: itemId,
    before: { status: from },
    after: { status: "SUBMITTED", documentId: document.id, storageReference: stored.reference, storageStatus: stored.status },
  });

  return {
    id: updated.id,
    label: updated.label,
    status: updated.status,
    required: updated.required,
    expiresAt: updated.expiresAt?.toISOString() ?? null,
    rejectionReason: updated.rejectionReason,
  };
}

export interface WorkerPlacementItem {
  id: string;
  jobOrderTitle: string;
  companyName: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
}

export async function listWorkerPlacements(): Promise<WorkerPlacementItem[]> {
  const { workerId } = requireWorkerContext();
  const rows = await scopedDb.placement.findMany({
    where: { workerId },
    include: { jobOrder: { select: { title: true } }, company: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((p) => ({
    id: p.id,
    jobOrderTitle: p.jobOrder.title,
    companyName: p.company.name,
    status: p.status,
    startDate: p.startDate?.toISOString() ?? null,
    endDate: p.endDate?.toISOString() ?? null,
  }));
}

export interface WorkerAssignmentItem {
  id: string;
  jobOrderTitle: string;
  companyName: string;
  status: string;
  startDate: string;
  endDate: string | null;
  location: unknown;
  shiftType: string;
  scheduleNotes: string | null;
  supervisorName: string | null;
}

/**
 * F10.6: enriquece con location/shiftType/scheduleNotes (de JobOrder,
 * F5.1) y supervisorName (de Project.supervisorContactId, F5.4 --
 * ninguna relación Prisma directa, se resuelve con un segundo query
 * batched). Nunca expone billRate/payRate/margen -- ese dato ya se
 * excluía acá desde F10.4, sin cambios.
 */
export async function listWorkerAssignments(): Promise<WorkerAssignmentItem[]> {
  const { workerId } = requireWorkerContext();
  const rows = await scopedDb.assignment.findMany({
    where: { workerId },
    include: {
      jobOrder: { select: { title: true, location: true, shiftType: true, scheduleNotes: true, company: { select: { name: true } } } },
      project: { select: { supervisorContactId: true } },
    },
    orderBy: { startDate: "desc" },
  });

  const supervisorIds = [...new Set(rows.map((a) => a.project?.supervisorContactId).filter((v): v is string => !!v))];
  const contacts = supervisorIds.length
    ? await scopedDb.contact.findMany({ where: { id: { in: supervisorIds } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const contactNameById = new Map(contacts.map((c) => [c.id, `${c.firstName} ${c.lastName}`]));

  return rows.map((a) => ({
    id: a.id,
    jobOrderTitle: a.jobOrder.title,
    companyName: a.jobOrder.company.name,
    status: a.status,
    startDate: a.startDate.toISOString(),
    endDate: a.endDate?.toISOString() ?? null,
    location: a.jobOrder.location,
    shiftType: a.jobOrder.shiftType,
    scheduleNotes: a.jobOrder.scheduleNotes,
    supervisorName: a.project?.supervisorContactId ? (contactNameById.get(a.project.supervisorContactId) ?? null) : null,
  }));
}

export interface WorkerShiftItem {
  id: string;
  assignmentId: string;
  jobOrderTitle: string;
  date: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  timezone: string | null;
}

export async function listWorkerShifts(): Promise<WorkerShiftItem[]> {
  const { workerId } = requireWorkerContext();
  const rows = await scopedDb.shift.findMany({
    where: { assignment: { workerId } },
    include: { assignment: { include: { jobOrder: { select: { title: true } } } } },
    orderBy: { date: "desc" },
    take: 50,
  });
  return rows.map((s) => ({
    id: s.id,
    assignmentId: s.assignmentId,
    jobOrderTitle: s.assignment.jobOrder.title,
    date: s.date.toISOString(),
    startTime: s.startTime,
    endTime: s.endTime,
    breakMinutes: s.breakMinutes,
    timezone: s.timezone,
  }));
}

export interface WorkerScheduleChangeRequestItem {
  id: string;
  assignmentId: string;
  requestType: string;
  requestedChange: string;
  status: string;
  reviewNotes: string | null;
  createdAt: string;
}

/**
 * F10.6: el Worker NUNCA muta Assignment/Shift directamente -- esto solo
 * crea un registro pendiente de revisión interna (ver
 * modules/assignments/service.ts::reviewScheduleChangeRequest). Ownership
 * verificado antes de crear (404, no 403, si el Assignment no es del
 * Worker actual -- mismo criterio IDOR del resto de F10).
 */
export async function requestScheduleChange(
  assignmentId: string,
  input: { requestType: string; requestedChange: string },
): Promise<WorkerScheduleChangeRequestItem> {
  const { tenantId, workerId } = requireWorkerContext();
  const assignment = await scopedDb.assignment.findUnique({ where: { id: assignmentId } });
  if (!assignment || assignment.workerId !== workerId) throw AppError.notFound("Assignment not found");

  const created = await scopedDb.scheduleChangeRequest.create({
    data: {
      tenantId,
      assignmentId,
      requestedById: workerId,
      requestType: input.requestType,
      requestedChange: input.requestedChange,
      status: "PENDING",
    },
  });

  await logAuditEvent({
    action: "portal.worker_schedule_change_requested",
    entityType: "schedule_change_request",
    entityId: created.id,
    after: { assignmentId, requestType: created.requestType, status: created.status },
  });

  return {
    id: created.id,
    assignmentId: created.assignmentId,
    requestType: created.requestType,
    requestedChange: created.requestedChange,
    status: created.status,
    reviewNotes: created.reviewNotes,
    createdAt: created.createdAt.toISOString(),
  };
}

export async function listWorkerScheduleChangeRequests(assignmentId?: string): Promise<WorkerScheduleChangeRequestItem[]> {
  const { workerId } = requireWorkerContext();
  const rows = await scopedDb.scheduleChangeRequest.findMany({
    where: { assignment: { workerId }, ...(assignmentId ? { assignmentId } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    assignmentId: r.assignmentId,
    requestType: r.requestType,
    requestedChange: r.requestedChange,
    status: r.status,
    reviewNotes: r.reviewNotes,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface WorkerTimeEntryItem {
  id: string;
  assignmentId: string;
  jobOrderTitle: string;
  date: string;
  regularHours: string;
  overtimeHours: string;
  doubleHours: string;
  status: string;
  rejectionReason: string | null;
}

export async function listWorkerTimeEntries(query: { cursor?: string; limit?: number }) {
  const { workerId } = requireWorkerContext();
  const limit = query.limit ?? 20;
  const rows = await scopedDb.timeEntry.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: { assignment: { workerId } },
    include: { assignment: { include: { jobOrder: { select: { title: true } } } } },
    orderBy: [{ date: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  const mapped: WorkerTimeEntryItem[] = items.map((t) => ({
    id: t.id,
    assignmentId: t.assignmentId,
    jobOrderTitle: t.assignment.jobOrder.title,
    date: t.date.toISOString(),
    regularHours: t.regularHours.toString(),
    overtimeHours: t.overtimeHours.toString(),
    doubleHours: t.doubleHours.toString(),
    status: t.status,
    rejectionReason: t.rejectionReason,
  }));
  return { items: mapped, nextCursor };
}

export interface WorkerIncidentItem {
  id: string;
  assignmentId: string | null;
  type: string;
  status: string;
  description: string;
  occurredAt: string;
}

export async function listWorkerIncidents(): Promise<WorkerIncidentItem[]> {
  const { workerId } = requireWorkerContext();
  const rows = await scopedDb.operationalIncident.findMany({
    where: { workerId },
    orderBy: { occurredAt: "desc" },
    take: 50,
  });
  return rows.map((i) => ({
    id: i.id,
    assignmentId: i.assignmentId,
    type: i.type,
    status: i.status,
    description: i.description,
    occurredAt: i.occurredAt.toISOString(),
  }));
}
