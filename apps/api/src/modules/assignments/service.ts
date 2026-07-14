import type {
  AssignmentDetail,
  AssignmentListItem,
  AssignmentQuery,
  CreateAssignmentInput,
  Paginated,
  UpdateAssignmentInput,
  UpdateAssignmentStatusInput,
} from "@ai-staffing-os/shared";
import { ASSIGNMENT_STATUS_TRANSITIONS, isValidAssignmentStatusTransition } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";

const ASSIGNMENT_INCLUDE = {
  worker: { include: { candidate: true } },
  jobOrder: { include: { company: true } },
  project: true,
} as const;

type AssignmentRow = {
  id: string;
  workerId: string;
  worker: { candidate: { firstName: string; lastName: string }; complianceStatus: string };
  jobOrderId: string;
  jobOrder: { title: string; company: { name: string } };
  projectId: string | null;
  project: { name: string } | null;
  payRate: { toString(): string };
  billRate: { toString(): string };
  startDate: Date;
  endDate: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

function toListItem(a: AssignmentRow): AssignmentListItem {
  return {
    id: a.id,
    workerId: a.workerId,
    workerName: `${a.worker.candidate.firstName} ${a.worker.candidate.lastName}`,
    jobOrderId: a.jobOrderId,
    jobOrderTitle: a.jobOrder.title,
    companyName: a.jobOrder.company.name,
    projectId: a.projectId,
    projectName: a.project?.name ?? null,
    payRate: a.payRate.toString(),
    billRate: a.billRate.toString(),
    startDate: a.startDate.toISOString(),
    endDate: a.endDate?.toISOString() ?? null,
    status: a.status as never,
    createdAt: a.createdAt.toISOString(),
  };
}

async function getRowById(id: string): Promise<AssignmentRow> {
  const row = await scopedDb.assignment.findUnique({ where: { id }, include: ASSIGNMENT_INCLUDE });
  if (!row) throw AppError.notFound("Assignment not found");
  return row;
}

/**
 * F5.4 (plan §6.3, aprobado): JobOrder.workersFilled SIEMPRE se deriva del
 * conteo real de Assignments SCHEDULED/ACTIVE — nunca se edita a mano
 * (mismo principio "no duplicar/derivar" ya aplicado en F1 a
 * Company.nextAction). La auto-transición de estado (OPEN →
 * PARTIALLY_FILLED → FILLED) es exactamente lo que el comentario de
 * JobOrderStatus en schema.prisma (F5.1) ya anticipaba: "se automatizan
 * cuando exista el módulo de Assignments" — ese módulo es este. Nunca
 * toca DRAFT/CLOSED/CANCELLED: esas son decisiones humanas explícitas,
 * jamás derivadas de un conteo.
 */
async function recomputeJobOrderFillState(jobOrderId: string): Promise<void> {
  const activeCount = await scopedDb.assignment.count({
    where: { jobOrderId, status: { in: ["SCHEDULED", "ACTIVE"] } },
  });
  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId } });
  if (!jobOrder) return;

  const data: { workersFilled: number; status?: "OPEN" | "PARTIALLY_FILLED" | "FILLED" } = {
    workersFilled: activeCount,
  };
  if (jobOrder.status === "OPEN" || jobOrder.status === "PARTIALLY_FILLED" || jobOrder.status === "FILLED") {
    if (activeCount <= 0) data.status = "OPEN";
    else if (activeCount < jobOrder.workersNeeded) data.status = "PARTIALLY_FILLED";
    else data.status = "FILLED";
  }

  await scopedDb.jobOrder.update({ where: { id: jobOrderId }, data });
}

/**
 * F5.4: mismo criterio — Worker.status alterna entre AVAILABLE/ASSIGNED
 * exclusivamente en función de si tiene alguna Assignment SCHEDULED/ACTIVE
 * real (ver comentario de WorkerStatus en talent.ts, F5.3: "ASSIGNED... se
 * automatiza cuando exista el módulo de Assignments"). Nunca pisa
 * ON_LEAVE/TERMINATED — esas siguen siendo decisiones humanas explícitas.
 */
async function recomputeWorkerAssignedState(workerId: string): Promise<void> {
  const activeCount = await scopedDb.assignment.count({
    where: { workerId, status: { in: ["SCHEDULED", "ACTIVE"] } },
  });
  const worker = await scopedDb.worker.findUnique({ where: { id: workerId } });
  if (!worker || worker.status === "ON_LEAVE" || worker.status === "TERMINATED") return;

  const nextStatus = activeCount > 0 ? "ASSIGNED" : "AVAILABLE";
  if (worker.status !== nextStatus) {
    await scopedDb.worker.update({ where: { id: workerId }, data: { status: nextStatus } });
  }
}

export async function listAssignments(query: AssignmentQuery): Promise<Paginated<AssignmentListItem>> {
  const sortField = query.sortBy ?? "createdAt";
  const sortDir = query.sortDir ?? "desc";

  const rows = await scopedDb.assignment.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit: query.limit ?? 20 }),
    where: {
      workerId: query.workerId,
      jobOrderId: query.jobOrderId,
      projectId: query.projectId,
      status: query.status,
      OR: query.search
        ? [
            { worker: { candidate: { firstName: { contains: query.search, mode: "insensitive" } } } },
            { worker: { candidate: { lastName: { contains: query.search, mode: "insensitive" } } } },
            { jobOrder: { title: { contains: query.search, mode: "insensitive" } } },
          ]
        : undefined,
    },
    orderBy: [{ [sortField]: sortDir }, { id: sortDir }],
    include: ASSIGNMENT_INCLUDE,
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit ?? 20);
  return { items: items.map(toListItem), nextCursor };
}

export async function getAssignmentDetail(id: string): Promise<AssignmentDetail> {
  const row = await getRowById(id);
  return {
    ...toListItem(row),
    workerComplianceStatus: row.worker.complianceStatus,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createAssignment(input: CreateAssignmentInput): Promise<AssignmentListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const worker = await scopedDb.worker.findUnique({ where: { id: input.workerId }, include: { candidate: true } });
  if (!worker) throw AppError.badRequest("Worker not found");

  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: input.jobOrderId } });
  if (!jobOrder) throw AppError.badRequest("Job Order not found");

  if (input.projectId) {
    const project = await scopedDb.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw AppError.badRequest("Project not found");
  }

  // F5.4 (plan §6.3, aprobado): compliance gate — bloqueo duro, sin
  // override. El plan dejó "¿existe un override auditado?" como pregunta
  // abierta para el PO; sin esa aprobación explícita, se aplica el
  // default conservador: nunca se fuerza.
  if (worker.complianceStatus !== "COMPLIANT") {
    throw AppError.badRequest("Worker must be COMPLIANT to be assigned", {
      complianceStatus: worker.complianceStatus,
    });
  }

  // F5.4: solo un Worker AVAILABLE puede recibir una Assignment nueva —
  // evita doble-booking sin construir un detector de solapamiento de
  // fechas (explícitamente fuera de alcance de esta fase).
  if (worker.status !== "AVAILABLE") {
    throw AppError.badRequest("Worker must be AVAILABLE to receive a new Assignment", { status: worker.status });
  }

  if (jobOrder.status !== "OPEN" && jobOrder.status !== "PARTIALLY_FILLED") {
    throw AppError.badRequest("Job Order must be OPEN or PARTIALLY_FILLED to receive a new Assignment", {
      status: jobOrder.status,
    });
  }
  if (jobOrder.workersFilled >= jobOrder.workersNeeded) {
    throw AppError.badRequest("Job Order has no remaining capacity", {
      workersFilled: jobOrder.workersFilled,
      workersNeeded: jobOrder.workersNeeded,
    });
  }

  const assignment = await scopedDb.assignment.create({
    data: {
      tenantId: ctx.tenantId,
      workerId: input.workerId,
      jobOrderId: input.jobOrderId,
      projectId: input.projectId,
      // F5.4 (aprobado): snapshot al crear — un cambio posterior en
      // JobOrder.payRate/billRate nunca se propaga acá.
      payRate: input.payRate,
      billRate: input.billRate,
      startDate: new Date(input.startDate),
      endDate: input.endDate ? new Date(input.endDate) : undefined,
      status: "SCHEDULED",
    },
  });

  await recomputeJobOrderFillState(input.jobOrderId);
  await recomputeWorkerAssignedState(input.workerId);

  const workerName = `${worker.candidate.firstName} ${worker.candidate.lastName}`;
  await logActivity({
    entityType: "assignment",
    entityId: assignment.id,
    type: "SYSTEM",
    subject: `Assignment created: ${workerName} → ${jobOrder.title}`,
  });
  await logAuditEvent({
    action: "assignment.created",
    entityType: "assignment",
    entityId: assignment.id,
    after: { workerId: input.workerId, jobOrderId: input.jobOrderId, status: "SCHEDULED" },
  });
  await logActivity({
    entityType: "jobOrder",
    entityId: input.jobOrderId,
    type: "SYSTEM",
    subject: `Worker assigned: ${workerName}`,
  });
  await logActivity({
    entityType: "worker",
    entityId: input.workerId,
    type: "SYSTEM",
    subject: `Assigned to Job Order: ${jobOrder.title}`,
  });

  return toListItem(await getRowById(assignment.id));
}

export async function updateAssignment(id: string, input: UpdateAssignmentInput): Promise<AssignmentListItem> {
  // Verify-then-act: scopedDb.assignment.findUnique ya está tenant-scoped
  // (STRICT_TENANT_MODELS) — si el registro es de otro tenant, esto
  // devuelve null antes de tocar nada.
  const existing = await scopedDb.assignment.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Assignment not found");

  if (input.projectId) {
    const project = await scopedDb.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw AppError.badRequest("Project not found");
  }

  const mergedStartDate = input.startDate ? new Date(input.startDate) : existing.startDate;
  const mergedEndDate =
    input.endDate !== undefined ? (input.endDate ? new Date(input.endDate) : null) : existing.endDate;
  if (mergedEndDate && mergedEndDate < mergedStartDate) {
    throw AppError.badRequest("endDate cannot be before startDate");
  }

  const updated = await scopedDb.assignment.update({
    where: { id },
    data: {
      projectId: input.projectId,
      payRate: input.payRate,
      billRate: input.billRate,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      endDate: input.endDate !== undefined ? (input.endDate ? new Date(input.endDate) : null) : undefined,
      // F5.4: workerId/jobOrderId/status/tenantId nunca aparecen acá —
      // updateAssignmentInputSchema no los declara.
    },
    include: ASSIGNMENT_INCLUDE,
  });

  await logActivity({
    entityType: "assignment",
    entityId: id,
    type: "SYSTEM",
    subject: "Assignment updated",
  });
  await logAuditEvent({
    action: "assignment.updated",
    entityType: "assignment",
    entityId: id,
    before: { payRate: existing.payRate.toString(), billRate: existing.billRate.toString() },
    after: { payRate: updated.payRate.toString(), billRate: updated.billRate.toString() },
  });

  return toListItem(updated);
}

export async function updateAssignmentStatus(
  id: string,
  input: UpdateAssignmentStatusInput,
): Promise<AssignmentListItem> {
  const existing = await getRowById(id);

  const from = existing.status as never;
  const to = input.status;

  // F5.4: idempotente — pedir el estado ya vigente es un no-op exitoso,
  // nunca un error ni una segunda entrada de Activity/AuditLog.
  if (from === to) {
    return toListItem(existing);
  }

  if (!isValidAssignmentStatusTransition(from, to)) {
    throw AppError.badRequest(`Cannot transition Assignment from ${existing.status} to ${to}`, {
      from: existing.status,
      to,
      allowedFromCurrentStatus: ASSIGNMENT_STATUS_TRANSITIONS[from],
    });
  }

  const updated = await scopedDb.assignment.update({
    where: { id },
    data: { status: to },
    include: ASSIGNMENT_INCLUDE,
  });

  await recomputeJobOrderFillState(existing.jobOrderId);
  await recomputeWorkerAssignedState(existing.workerId);

  // F5.4 (plan §6.2, aprobado): el motivo de cierre se guarda como texto
  // libre dentro de la Activity — nunca como un campo/enum estructurado.
  const subject = input.reason
    ? `Status changed: ${existing.status} → ${to} (${input.reason})`
    : `Status changed: ${existing.status} → ${to}`;

  await logActivity({ entityType: "assignment", entityId: id, type: "SYSTEM", subject });
  await logAuditEvent({
    action: "assignment.status_changed",
    entityType: "assignment",
    entityId: id,
    before: { status: existing.status },
    after: { status: to, reason: input.reason ?? null },
  });

  if (to === "COMPLETED" || to === "TERMINATED") {
    await logActivity({
      entityType: "jobOrder",
      entityId: existing.jobOrderId,
      type: "SYSTEM",
      subject: `Assignment ended (${to}): ${existing.worker.candidate.firstName} ${existing.worker.candidate.lastName}`,
    });
    await logActivity({
      entityType: "worker",
      entityId: existing.workerId,
      type: "SYSTEM",
      subject: `Assignment ended (${to}): ${existing.jobOrder.title}`,
    });
  }

  return toListItem(updated);
}
