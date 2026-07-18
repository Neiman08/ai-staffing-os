/**
 * F10.2: Client Portal -- TODA función acá exige `ctx.companyId` (la
 * identidad de portal resuelta en F10.1) y SIEMPRE filtra por esa
 * Company explícitamente en el `where` de Prisma -- nunca confía en un
 * companyId que venga del query string/body. Ownership + tenancy son
 * dos capas independientes: `scopedDb` ya filtra por tenantId (F0),
 * estas funciones agregan el filtro de Company encima.
 *
 * Nunca expone: pay rates internos, notas internas de recruiting
 * (score/reasons/gaps/risks de CandidateMatch/Shortlist), margen, ni
 * ningún dato de otro cliente.
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { AppError } from "../../core/errors";
import * as payrollService from "../payroll/service";

function requireClientContext(): { tenantId: string; companyId: string } {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  if (!ctx.companyId) throw AppError.forbidden("This account is not linked to a Company portal identity");
  return { tenantId: ctx.tenantId, companyId: ctx.companyId };
}

export interface ClientDashboardSummary {
  openJobOrders: number;
  activeAssignments: number;
  pendingTimeEntries: number;
  openIncidents: number;
}

export async function getClientDashboard(): Promise<ClientDashboardSummary> {
  const { companyId } = requireClientContext();

  const [openJobOrders, activeAssignments, pendingTimeEntries, openIncidents] = await Promise.all([
    scopedDb.jobOrder.count({ where: { companyId, status: { in: ["OPEN", "PARTIALLY_FILLED"] } } }),
    scopedDb.assignment.count({ where: { jobOrder: { companyId }, status: { in: ["SCHEDULED", "ACTIVE", "PAUSED"] } } }),
    scopedDb.timeEntry.count({ where: { assignment: { jobOrder: { companyId } }, status: { in: ["SUBMITTED", "NEEDS_REVIEW"] } } }),
    scopedDb.operationalIncident.count({ where: { companyId, status: { in: ["OPEN", "UNDER_REVIEW", "ACTION_REQUIRED"] } } }),
  ]);

  return { openJobOrders, activeAssignments, pendingTimeEntries, openIncidents };
}

export interface ClientJobOrderListItem {
  id: string;
  title: string;
  status: string;
  workersNeeded: number;
  workersFilled: number;
  startDate: string;
  endDate: string | null;
  location: unknown;
}

export async function listClientJobOrders(query: { cursor?: string; limit?: number }) {
  const { companyId } = requireClientContext();
  const limit = query.limit ?? 20;
  const rows = await scopedDb.jobOrder.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: { companyId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  const mapped: ClientJobOrderListItem[] = items.map((j) => ({
    id: j.id,
    title: j.title,
    status: j.status,
    workersNeeded: j.workersNeeded,
    workersFilled: j.workersFilled,
    startDate: j.startDate.toISOString(),
    endDate: j.endDate?.toISOString() ?? null,
    location: j.location,
  }));
  return { items: mapped, nextCursor };
}

export async function getClientJobOrderDetail(id: string): Promise<ClientJobOrderListItem> {
  const { companyId } = requireClientContext();
  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id } });
  // F10.2: 404 (nunca 403) cuando pertenece a otra Company -- no confirma
  // ni niega la existencia del recurso a quien no tiene acceso (mismo
  // criterio IDOR-safe usado en el resto de los servicios de portal).
  if (!jobOrder || jobOrder.companyId !== companyId) throw AppError.notFound("Job order not found");
  return {
    id: jobOrder.id,
    title: jobOrder.title,
    status: jobOrder.status,
    workersNeeded: jobOrder.workersNeeded,
    workersFilled: jobOrder.workersFilled,
    startDate: jobOrder.startDate.toISOString(),
    endDate: jobOrder.endDate?.toISOString() ?? null,
    location: jobOrder.location,
  };
}

export interface ClientShortlistEntry {
  candidateId: string;
  candidateName: string;
  rank: number;
  reviewStatus: string;
}

/**
 * F10.2: solo entradas que un Recruiter ya marcó como listas para
 * mostrar al cliente (READY_FOR_REVIEW/APPROVED/HOLD) -- DRAFT sigue en
 * trabajo interno, REMOVED fue descartada internamente. Nunca expone
 * score/reasons/gaps/risks (lógica de scoring interna).
 */
export async function listClientShortlist(jobOrderId: string): Promise<ClientShortlistEntry[]> {
  const { companyId } = requireClientContext();
  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId } });
  if (!jobOrder || jobOrder.companyId !== companyId) throw AppError.notFound("Job order not found");

  const entries = await scopedDb.candidateShortlistEntry.findMany({
    where: { jobOrderId, reviewStatus: { in: ["READY_FOR_REVIEW", "APPROVED", "HOLD"] } },
    include: { candidate: { select: { firstName: true, lastName: true } } },
    orderBy: { rank: "asc" },
  });

  return entries.map((e) => ({
    candidateId: e.candidateId,
    candidateName: `${e.candidate.firstName} ${e.candidate.lastName}`,
    rank: e.rank,
    reviewStatus: e.reviewStatus,
  }));
}

export interface ClientPlacementListItem {
  id: string;
  candidateName: string | null;
  jobOrderTitle: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
}

export async function listClientPlacements(query: { cursor?: string; limit?: number }) {
  const { companyId } = requireClientContext();
  const limit = query.limit ?? 20;
  const rows = await scopedDb.placement.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: { companyId },
    include: { candidate: { select: { firstName: true, lastName: true } }, jobOrder: { select: { title: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  const mapped: ClientPlacementListItem[] = items.map((p) => ({
    id: p.id,
    candidateName: p.candidate ? `${p.candidate.firstName} ${p.candidate.lastName}` : null,
    jobOrderTitle: p.jobOrder.title,
    status: p.status,
    startDate: p.startDate?.toISOString() ?? null,
    endDate: p.endDate?.toISOString() ?? null,
  }));
  return { items: mapped, nextCursor };
}

export interface ClientAssignmentListItem {
  id: string;
  workerName: string;
  jobOrderTitle: string;
  status: string;
  startDate: string;
  endDate: string | null;
}

export async function listClientAssignments(query: { cursor?: string; limit?: number }) {
  const { companyId } = requireClientContext();
  const limit = query.limit ?? 20;
  const rows = await scopedDb.assignment.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: { jobOrder: { companyId } },
    include: { worker: { include: { candidate: true } }, jobOrder: { select: { title: true } } },
    orderBy: [{ startDate: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  const mapped: ClientAssignmentListItem[] = items.map((a) => ({
    id: a.id,
    workerName: `${a.worker.candidate.firstName} ${a.worker.candidate.lastName}`,
    jobOrderTitle: a.jobOrder.title,
    status: a.status,
    startDate: a.startDate.toISOString(),
    endDate: a.endDate?.toISOString() ?? null,
  }));
  return { items: mapped, nextCursor };
}

export interface ClientWorkerListItem {
  workerId: string;
  name: string;
  jobOrderTitle: string;
  assignmentStatus: string;
}

/** F10.2: "workers asignados" -- derivado de Assignment (ninguna tabla nueva), sin duplicar listClientAssignments (distinta forma, pensada para una vista de roster). */
export async function listClientWorkers(): Promise<ClientWorkerListItem[]> {
  const { companyId } = requireClientContext();
  const assignments = await scopedDb.assignment.findMany({
    where: { jobOrder: { companyId }, status: { in: ["SCHEDULED", "ACTIVE", "PAUSED"] } },
    include: { worker: { include: { candidate: true } }, jobOrder: { select: { title: true } } },
    orderBy: { startDate: "desc" },
  });
  return assignments.map((a) => ({
    workerId: a.workerId,
    name: `${a.worker.candidate.firstName} ${a.worker.candidate.lastName}`,
    jobOrderTitle: a.jobOrder.title,
    assignmentStatus: a.status,
  }));
}

export interface ClientTimeEntryListItem {
  id: string;
  workerName: string;
  jobOrderTitle: string;
  date: string;
  regularHours: string;
  overtimeHours: string;
  doubleHours: string;
  status: string;
}

export async function listClientPendingTimeEntries(query: { cursor?: string; limit?: number }) {
  const { companyId } = requireClientContext();
  const limit = query.limit ?? 20;
  const rows = await scopedDb.timeEntry.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: { assignment: { jobOrder: { companyId } }, status: { in: ["SUBMITTED", "NEEDS_REVIEW"] } },
    include: { assignment: { include: { worker: { include: { candidate: true } }, jobOrder: { select: { title: true } } } } },
    orderBy: [{ date: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  const mapped: ClientTimeEntryListItem[] = items.map((t) => ({
    id: t.id,
    workerName: `${t.assignment.worker.candidate.firstName} ${t.assignment.worker.candidate.lastName}`,
    jobOrderTitle: t.assignment.jobOrder.title,
    date: t.date.toISOString(),
    regularHours: t.regularHours.toString(),
    overtimeHours: t.overtimeHours.toString(),
    doubleHours: t.doubleHours.toString(),
    status: t.status,
  }));
  return { items: mapped, nextCursor };
}

/**
 * F10.2/F10.7: aprobar horas -- verifica ownership (la TimeEntry
 * pertenece a un Assignment de ESTA Company) antes de reutilizar la
 * transición ya construida y probada en F9.6 (`payrollService.
 * approveTimeEntry`) -- nunca duplica la lógica de transición de
 * estado, solo agrega el gate de ownership encima.
 */
export async function approveClientTimeEntry(id: string) {
  const { companyId } = requireClientContext();
  const entry = await scopedDb.timeEntry.findUnique({ where: { id }, include: { assignment: { include: { jobOrder: true } } } });
  if (!entry || entry.assignment.jobOrder.companyId !== companyId) throw AppError.notFound("Time entry not found");
  return payrollService.approveTimeEntry(id);
}

export async function rejectClientTimeEntry(id: string, rejectionReason: string) {
  const { companyId } = requireClientContext();
  const entry = await scopedDb.timeEntry.findUnique({ where: { id }, include: { assignment: { include: { jobOrder: true } } } });
  if (!entry || entry.assignment.jobOrder.companyId !== companyId) throw AppError.notFound("Time entry not found");
  return payrollService.rejectTimeEntry(id, { rejectionReason });
}

export interface ClientIncidentListItem {
  id: string;
  type: string;
  status: string;
  description: string;
  occurredAt: string;
  workerName: string | null;
}

export async function listClientIncidents(query: { cursor?: string; limit?: number }) {
  const { companyId } = requireClientContext();
  const limit = query.limit ?? 20;
  const rows = await scopedDb.operationalIncident.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: { companyId },
    include: { worker: { include: { candidate: true } } },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  const mapped: ClientIncidentListItem[] = items.map((i) => ({
    id: i.id,
    type: i.type,
    status: i.status,
    description: i.description,
    occurredAt: i.occurredAt.toISOString(),
    workerName: i.worker ? `${i.worker.candidate.firstName} ${i.worker.candidate.lastName}` : null,
  }));
  return { items: mapped, nextCursor };
}
