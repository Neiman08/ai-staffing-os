/**
 * F10.4: Worker Portal -- TODA función exige `ctx.workerId` (F10.1) y
 * filtra explícitamente por él. Nunca expone rankings frente a otros
 * Workers, notas internas de recruiting, ni datos de otro Worker.
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { AppError } from "../../core/errors";

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
  employmentType: string;
  defaultPayRate: string;
  status: string;
  complianceStatus: string;
  hiredAt: string | null;
}

export async function getWorkerProfile(): Promise<WorkerProfile> {
  const { workerId } = requireWorkerContext();
  const worker = await scopedDb.worker.findUnique({ where: { id: workerId }, include: { candidate: true } });
  if (!worker) throw AppError.notFound("Worker not found");
  return {
    id: worker.id,
    firstName: worker.candidate.firstName,
    lastName: worker.candidate.lastName,
    email: worker.candidate.email,
    phone: worker.candidate.phone,
    city: worker.candidate.city,
    state: worker.candidate.state,
    languages: worker.candidate.languages,
    employmentType: worker.employmentType,
    defaultPayRate: worker.defaultPayRate.toString(),
    status: worker.status,
    complianceStatus: worker.complianceStatus,
    hiredAt: worker.hiredAt?.toISOString() ?? null,
  };
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
}

export async function listWorkerAssignments(): Promise<WorkerAssignmentItem[]> {
  const { workerId } = requireWorkerContext();
  const rows = await scopedDb.assignment.findMany({
    where: { workerId },
    include: { jobOrder: { select: { title: true, company: { select: { name: true } } } } },
    orderBy: { startDate: "desc" },
  });
  return rows.map((a) => ({
    id: a.id,
    jobOrderTitle: a.jobOrder.title,
    companyName: a.jobOrder.company.name,
    status: a.status,
    startDate: a.startDate.toISOString(),
    endDate: a.endDate?.toISOString() ?? null,
  }));
}

export interface WorkerShiftItem {
  id: string;
  assignmentId: string;
  jobOrderTitle: string;
  date: string;
  startTime: string;
  endTime: string;
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
    timezone: s.timezone,
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
    type: i.type,
    status: i.status,
    description: i.description,
    occurredAt: i.occurredAt.toISOString(),
  }));
}
