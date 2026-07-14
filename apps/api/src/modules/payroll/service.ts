import type {
  BulkApproveTimeEntriesInput,
  BulkApproveTimeEntriesResult,
  CreateTimeEntryInput,
  Paginated,
  TimeEntryListItem,
  TimeEntryQuery,
  UpdateTimeEntryInput,
} from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";

const TIME_ENTRY_INCLUDE = {
  assignment: { include: { worker: { include: { candidate: true } }, jobOrder: true } },
} as const;

type TimeEntryRow = {
  id: string;
  assignmentId: string;
  assignment: {
    worker: { candidate: { firstName: string; lastName: string } };
    jobOrder: { title: string };
    billRate: { toString(): string };
    payRate: { toString(): string };
  };
  date: Date;
  regularHours: { toString(): string };
  overtimeHours: { toString(): string };
  doubleHours: { toString(): string };
  status: string;
  source: string;
};

function toListItem(entry: TimeEntryRow): TimeEntryListItem {
  const totalHours = Number(entry.regularHours) + Number(entry.overtimeHours) + Number(entry.doubleHours);
  const billRate = Number(entry.assignment.billRate);
  const payRate = Number(entry.assignment.payRate);
  const billAmount = totalHours * billRate;
  const payAmount = totalHours * payRate;

  return {
    id: entry.id,
    workerName: `${entry.assignment.worker.candidate.firstName} ${entry.assignment.worker.candidate.lastName}`,
    jobOrderTitle: entry.assignment.jobOrder.title,
    date: entry.date.toISOString(),
    regularHours: entry.regularHours.toString(),
    overtimeHours: entry.overtimeHours.toString(),
    doubleHours: entry.doubleHours.toString(),
    status: entry.status,
    source: entry.source,
    billAmount: billAmount.toFixed(2),
    payAmount: payAmount.toFixed(2),
    margin: (billAmount - payAmount).toFixed(2),
  };
}

export async function listTimeEntries(query: TimeEntryQuery): Promise<Paginated<TimeEntryListItem>> {
  const rows = await scopedDb.timeEntry.findMany({
    ...buildCursorArgs(query),
    where: {
      assignmentId: query.assignmentId,
      status: query.status,
      date:
        query.dateFrom || query.dateTo
          ? {
              gte: query.dateFrom ? new Date(query.dateFrom) : undefined,
              lte: query.dateTo ? new Date(query.dateTo) : undefined,
            }
          : undefined,
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: TIME_ENTRY_INCLUDE,
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);
  return { items: items.map(toListItem), nextCursor };
}

function assertReasonableHours(hours: { regularHours?: number; overtimeHours?: number; doubleHours?: number }): void {
  const total = (hours.regularHours ?? 0) + (hours.overtimeHours ?? 0) + (hours.doubleHours ?? 0);
  if (total > 24) {
    throw AppError.badRequest("Total hours for a single day cannot exceed 24", { total });
  }
}

export async function createTimeEntry(input: CreateTimeEntryInput): Promise<TimeEntryListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const assignment = await scopedDb.assignment.findUnique({ where: { id: input.assignmentId } });
  if (!assignment) throw AppError.badRequest("Assignment not found");

  assertReasonableHours(input);

  const entryDate = new Date(input.date);
  // F5.6: mismo constraint único ya declarado en el schema desde F0
  // (@@unique([assignmentId, date])) — se verifica acá con un findFirst
  // (WhereInput admite assignmentId/date como campos planos; el nombre
  // compuesto assignmentId_date solo existe para WhereUniqueInput, que
  // scopedDb.findUnique ya redirige a findFirst tenant-scoped y no lo
  // reconocería) para devolver un 409 legible en vez de un error crudo
  // de Postgres.
  const existing = await scopedDb.timeEntry.findFirst({ where: { assignmentId: input.assignmentId, date: entryDate } });
  if (existing) {
    throw AppError.conflict("A TimeEntry already exists for this Assignment and date", { existingId: existing.id });
  }

  const created = await scopedDb.timeEntry.create({
    data: {
      tenantId: ctx.tenantId,
      assignmentId: input.assignmentId,
      date: entryDate,
      regularHours: input.regularHours ?? 0,
      overtimeHours: input.overtimeHours ?? 0,
      doubleHours: input.doubleHours ?? 0,
      perDiem: input.perDiem,
      bonus: input.bonus,
      status: "PENDING",
      source: "MANUAL",
    },
    include: TIME_ENTRY_INCLUDE,
  });

  await logActivity({
    entityType: "assignment",
    entityId: input.assignmentId,
    type: "SYSTEM",
    subject: `Time entry logged: ${entryDate.toISOString().slice(0, 10)}`,
  });
  await logAuditEvent({
    action: "timeEntry.created",
    entityType: "timeEntry",
    entityId: created.id,
    after: { assignmentId: input.assignmentId, date: input.date, status: "PENDING" },
  });

  return toListItem(created);
}

export async function updateTimeEntry(id: string, input: UpdateTimeEntryInput): Promise<TimeEntryListItem> {
  const existing = await scopedDb.timeEntry.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Time entry not found");

  // F5.6 (plan §8, aprobado implícito por el ciclo de vida): una vez
  // APPROVED (o LOCKED, cuando exista Payroll) las horas dejan de ser
  // editables a mano libre — corregirlas requeriría primero revertir la
  // aprobación, fuera de alcance de F5.6.
  if (existing.status !== "PENDING") {
    throw AppError.badRequest(`Cannot edit a Time entry that is already ${existing.status}`, {
      status: existing.status,
    });
  }

  assertReasonableHours({
    regularHours: input.regularHours ?? Number(existing.regularHours),
    overtimeHours: input.overtimeHours ?? Number(existing.overtimeHours),
    doubleHours: input.doubleHours ?? Number(existing.doubleHours),
  });

  const updated = await scopedDb.timeEntry.update({
    where: { id },
    data: {
      regularHours: input.regularHours,
      overtimeHours: input.overtimeHours,
      doubleHours: input.doubleHours,
      perDiem: input.perDiem,
      bonus: input.bonus,
      // F5.6: assignmentId/date/status nunca aparecen acá —
      // updateTimeEntryInputSchema no los declara.
    },
    include: TIME_ENTRY_INCLUDE,
  });

  await logActivity({
    entityType: "assignment",
    entityId: existing.assignmentId,
    type: "SYSTEM",
    subject: `Time entry updated: ${existing.date.toISOString().slice(0, 10)}`,
  });
  await logAuditEvent({
    action: "timeEntry.updated",
    entityType: "timeEntry",
    entityId: id,
    before: { regularHours: existing.regularHours.toString(), overtimeHours: existing.overtimeHours.toString() },
    after: { regularHours: updated.regularHours.toString(), overtimeHours: updated.overtimeHours.toString() },
  });

  return toListItem(updated);
}

/**
 * F5.6 (plan §8.3/§8.5, aprobado): aprueba en lote — solo las entradas
 * que de verdad están PENDING (las demás se ignoran silenciosamente, no
 * es un error pedir aprobar algo que ya no aplica). Una sola AuditLog
 * con los IDs afectados, mismo criterio ya anticipado en el plan
 * ("action: timeEntry.bulk_approved, before/after con los IDs
 * afectados").
 */
export async function bulkApproveTimeEntries(input: BulkApproveTimeEntriesInput): Promise<BulkApproveTimeEntriesResult> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const candidates = await scopedDb.timeEntry.findMany({ where: { id: { in: input.ids } } });
  const eligible = candidates.filter((e) => e.status === "PENDING");
  const eligibleIds = eligible.map((e) => e.id);

  if (eligibleIds.length > 0) {
    await scopedDb.timeEntry.updateMany({
      where: { id: { in: eligibleIds } },
      data: { status: "APPROVED", approvedById: ctx.userId },
    });

    await logAuditEvent({
      action: "timeEntry.bulk_approved",
      entityType: "timeEntry",
      entityId: eligibleIds.join(","),
      before: { ids: eligibleIds, status: "PENDING" },
      after: { ids: eligibleIds, status: "APPROVED" },
    });

    for (const entry of eligible) {
      await logActivity({
        entityType: "assignment",
        entityId: entry.assignmentId,
        type: "SYSTEM",
        subject: `Time entry approved: ${entry.date.toISOString().slice(0, 10)}`,
      });
    }
  }

  return { approved: eligibleIds.length, skipped: candidates.length - eligibleIds.length };
}
