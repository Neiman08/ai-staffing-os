/**
 * F9.10: Exceptions and Incidents -- wiring impuro entre
 * `operations-intelligence/incident-rules.ts` (puro) y los datos reales
 * del tenant. Un `OperationalIncident` es el relato de un humano sobre
 * un evento operativo real -- NUNCA infiere culpa, NUNCA aplica una
 * sanción, NUNCA termina un Assignment/Worker automáticamente (esas
 * acciones, si proceden, las toma un humano por separado con los
 * endpoints ya existentes de F9.5/F5.3).
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";
import {
  INCIDENT_STATUS_TRANSITIONS,
  isValidIncidentStatusTransition,
  requiresAtLeastOneRelation,
  type IncidentStatusValue,
  type IncidentTypeValue,
} from "../operations-intelligence/incident-rules";

export interface CreateIncidentInput {
  type: IncidentTypeValue;
  description: string;
  occurredAt: string;
  workerId?: string | null;
  assignmentId?: string | null;
  companyId?: string | null;
  jobOrderId?: string | null;
}

export interface UpdateIncidentInput {
  description?: string;
  occurredAt?: string;
}

export interface IncidentRecord {
  id: string;
  type: IncidentTypeValue;
  status: IncidentStatusValue;
  workerId: string | null;
  workerName: string | null;
  assignmentId: string | null;
  companyId: string | null;
  companyName: string | null;
  jobOrderId: string | null;
  jobOrderTitle: string | null;
  description: string;
  occurredAt: string;
  reportedById: string | null;
  resolutionNotes: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentQuery {
  status?: IncidentStatusValue;
  type?: IncidentTypeValue;
  workerId?: string;
  companyId?: string;
  jobOrderId?: string;
  cursor?: string;
  limit?: number;
}

const INCIDENT_INCLUDE = {
  worker: { include: { candidate: true } },
  company: { select: { name: true } },
  jobOrder: { select: { title: true } },
} as const;

type IncidentRow = {
  id: string;
  type: string;
  status: string;
  workerId: string | null;
  worker: { candidate: { firstName: string; lastName: string } } | null;
  assignmentId: string | null;
  companyId: string | null;
  company: { name: string } | null;
  jobOrderId: string | null;
  jobOrder: { title: string } | null;
  description: string;
  occurredAt: Date;
  reportedById: string | null;
  resolutionNotes: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toIncidentRecord(row: IncidentRow): IncidentRecord {
  return {
    id: row.id,
    type: row.type as IncidentTypeValue,
    status: row.status as IncidentStatusValue,
    workerId: row.workerId,
    workerName: row.worker ? `${row.worker.candidate.firstName} ${row.worker.candidate.lastName}` : null,
    assignmentId: row.assignmentId,
    companyId: row.companyId,
    companyName: row.company?.name ?? null,
    jobOrderId: row.jobOrderId,
    jobOrderTitle: row.jobOrder?.title ?? null,
    description: row.description,
    occurredAt: row.occurredAt.toISOString(),
    reportedById: row.reportedById,
    resolutionNotes: row.resolutionNotes,
    resolvedById: row.resolvedById,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * F9.10: exige AL MENOS una relación real (Worker/Assignment/Company/
 * JobOrder) para todo tipo salvo OTHER (`requiresAtLeastOneRelation`,
 * puro) -- nunca inventa una relación, solo verifica que la(s) enviada(s)
 * existan de verdad en este tenant.
 */
export async function createIncident(input: CreateIncidentInput): Promise<IncidentRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const hasAnyRelation = !!(input.workerId || input.assignmentId || input.companyId || input.jobOrderId);
  if (requiresAtLeastOneRelation(input.type) && !hasAnyRelation) {
    throw AppError.badRequest(`Incident type ${input.type} requires at least one of workerId/assignmentId/companyId/jobOrderId`);
  }

  if (input.workerId) {
    const worker = await scopedDb.worker.findUnique({ where: { id: input.workerId } });
    if (!worker) throw AppError.badRequest("Worker not found");
  }
  if (input.assignmentId) {
    const assignment = await scopedDb.assignment.findUnique({ where: { id: input.assignmentId } });
    if (!assignment) throw AppError.badRequest("Assignment not found");
  }
  if (input.companyId) {
    const company = await scopedDb.company.findUnique({ where: { id: input.companyId } });
    if (!company) throw AppError.badRequest("Company not found");
  }
  if (input.jobOrderId) {
    const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: input.jobOrderId } });
    if (!jobOrder) throw AppError.badRequest("Job Order not found");
  }

  const created = await scopedDb.operationalIncident.create({
    data: {
      tenantId: ctx.tenantId,
      type: input.type as never,
      status: "OPEN",
      description: input.description,
      occurredAt: new Date(input.occurredAt),
      workerId: input.workerId ?? undefined,
      assignmentId: input.assignmentId ?? undefined,
      companyId: input.companyId ?? undefined,
      jobOrderId: input.jobOrderId ?? undefined,
      reportedById: ctx.userId,
    },
    include: INCIDENT_INCLUDE,
  });

  await logAuditEvent({
    action: "incident.created",
    entityType: "operationalIncident",
    entityId: created.id,
    after: { type: input.type, status: "OPEN", workerId: input.workerId ?? null },
  });

  return toIncidentRecord(created);
}

export async function listIncidents(query: IncidentQuery) {
  const limit = query.limit ?? 20;
  const rows = await scopedDb.operationalIncident.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: {
      status: query.status as never,
      type: query.type as never,
      workerId: query.workerId,
      companyId: query.companyId,
      jobOrderId: query.jobOrderId,
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    include: INCIDENT_INCLUDE,
  });

  const { items, nextCursor } = toCursorPage(rows, limit);
  return { items: items.map(toIncidentRecord), nextCursor };
}

export async function getIncidentById(id: string): Promise<IncidentRecord> {
  const row = await scopedDb.operationalIncident.findUnique({ where: { id }, include: INCIDENT_INCLUDE });
  if (!row) throw AppError.notFound("Incident not found");
  return toIncidentRecord(row);
}

/** Edita campos no sensibles al estado -- nunca type/status/relaciones (eso exigiría, en efecto, otro incidente). */
export async function updateIncident(id: string, input: UpdateIncidentInput): Promise<IncidentRecord> {
  const existing = await scopedDb.operationalIncident.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Incident not found");
  if (existing.status === "CLOSED") {
    throw AppError.badRequest("Cannot edit a CLOSED incident -- reopen it first (UNDER_REVIEW) or report a new one");
  }

  const updated = await scopedDb.operationalIncident.update({
    where: { id },
    data: {
      description: input.description,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
    },
    include: INCIDENT_INCLUDE,
  });

  await logAuditEvent({
    action: "incident.updated",
    entityType: "operationalIncident",
    entityId: id,
    before: { description: existing.description },
    after: { description: updated.description },
  });

  return toIncidentRecord(updated);
}

/**
 * Único camino para cambiar `status`. Nunca decide una sanción ni toca
 * Worker/Assignment. `resolutionNotes` es obligatorio solo para
 * alcanzar RESOLVED (el "qué se hizo", nunca un juicio de culpa) --
 * volver a UNDER_REVIEW desde RESOLVED limpia `resolvedById`/
 * `resolvedAt` (ya no está resuelto).
 */
export async function updateIncidentStatus(
  id: string,
  to: IncidentStatusValue,
  resolutionNotes?: string | null,
): Promise<IncidentRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.operationalIncident.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Incident not found");

  const from = existing.status as IncidentStatusValue;
  if (from === to) return toIncidentRecord(await scopedDb.operationalIncident.findUniqueOrThrow({ where: { id }, include: INCIDENT_INCLUDE }));

  if (!isValidIncidentStatusTransition(from, to)) {
    throw AppError.badRequest(`Cannot transition Incident from ${from} to ${to}`, {
      from,
      to,
      allowedFromCurrentStatus: INCIDENT_STATUS_TRANSITIONS[from],
    });
  }
  if (to === "RESOLVED" && !resolutionNotes) {
    throw AppError.badRequest("resolutionNotes is required to mark an Incident RESOLVED");
  }

  const becomesResolved = to === "RESOLVED";
  const leavesResolved = (from === "RESOLVED" || from === "CLOSED") && !becomesResolved && to !== "CLOSED";

  const updated = await scopedDb.operationalIncident.update({
    where: { id },
    data: {
      status: to,
      resolutionNotes: becomesResolved ? resolutionNotes : leavesResolved ? null : undefined,
      resolvedById: becomesResolved ? ctx.userId : leavesResolved ? null : undefined,
      resolvedAt: becomesResolved ? new Date() : leavesResolved ? null : undefined,
    },
    include: INCIDENT_INCLUDE,
  });

  await logAuditEvent({
    action: "incident.status_changed",
    entityType: "operationalIncident",
    entityId: id,
    before: { status: from },
    after: { status: to },
  });

  return toIncidentRecord(updated);
}
