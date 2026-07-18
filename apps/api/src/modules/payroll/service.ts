import type {
  BulkApproveTimeEntriesInput,
  BulkApproveTimeEntriesResult,
  CreatePayrollRunInput,
  CreateShiftInput,
  CreateTimeEntryInput,
  Paginated,
  PayrollItem,
  PayrollRunDetail,
  PayrollRunListItem,
  PaginationQuery,
  RejectTimeEntryInput,
  ShiftListItem,
  ShiftQuery,
  TimeEntryListItem,
  TimeEntryQuery,
  TimeEntryStatusValue,
  UpdateShiftInput,
  UpdateTimeEntryInput,
} from "@ai-staffing-os/shared";
import {
  isValidPayrollRunStatusTransition,
  isValidTimeEntryStatusTransition,
  PAYROLL_RUN_STATUS_TRANSITIONS,
  TIME_ENTRY_STATUS_TRANSITIONS,
} from "@ai-staffing-os/shared";
import { computeDiscrepancyFlag, computeOvertimeFlag, computeShiftScheduledHours, computeSubmissionTargetStatus } from "../operations-intelligence/time-entry-signals";
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
  overtimeFlag: boolean;
  discrepancyFlag: boolean;
  discrepancyNotes: string | null;
  rejectionReason: string | null;
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
    overtimeFlag: entry.overtimeFlag,
    discrepancyFlag: entry.discrepancyFlag,
    discrepancyNotes: entry.discrepancyNotes,
    rejectionReason: entry.rejectionReason,
  };
}

/**
 * F9.6: busca un Shift programado para el mismo Assignment+fecha -- si
 * existe más de uno (split shift, ver createShiftInputSchema), usa el
 * primero por orden de creación; no suma turnos múltiples en una sola
 * "duración esperada" inventada.
 */
async function findScheduledHoursForEntry(assignmentId: string, date: Date): Promise<{ scheduledHours: number } | null> {
  const shift = await scopedDb.shift.findFirst({
    where: { assignmentId, date },
    orderBy: { id: "asc" },
  });
  if (!shift) return null;
  return { scheduledHours: computeShiftScheduledHours(shift.startTime, shift.endTime, shift.breakMinutes) };
}

async function computeSignalsForEntry(
  assignmentId: string,
  date: Date,
  hours: { regularHours: number; overtimeHours: number; doubleHours: number },
): Promise<{ overtimeFlag: boolean; discrepancyFlag: boolean; discrepancyNotes: string | null }> {
  const scheduled = await findScheduledHoursForEntry(assignmentId, date);
  const overtimeFlag = computeOvertimeFlag(hours);
  const discrepancy = computeDiscrepancyFlag(hours, scheduled);
  return { overtimeFlag, discrepancyFlag: discrepancy.flag, discrepancyNotes: discrepancy.notes };
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

  const hours = {
    regularHours: input.regularHours ?? 0,
    overtimeHours: input.overtimeHours ?? 0,
    doubleHours: input.doubleHours ?? 0,
  };
  const signals = await computeSignalsForEntry(input.assignmentId, entryDate, hours);
  const initialStatus: TimeEntryStatusValue = input.startAsDraft ? "DRAFT" : "PENDING";

  const created = await scopedDb.timeEntry.create({
    data: {
      tenantId: ctx.tenantId,
      assignmentId: input.assignmentId,
      date: entryDate,
      regularHours: hours.regularHours,
      overtimeHours: hours.overtimeHours,
      doubleHours: hours.doubleHours,
      perDiem: input.perDiem,
      bonus: input.bonus,
      status: initialStatus,
      source: "MANUAL",
      overtimeFlag: signals.overtimeFlag,
      discrepancyFlag: signals.discrepancyFlag,
      discrepancyNotes: signals.discrepancyNotes,
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
    after: { assignmentId: input.assignmentId, date: input.date, status: initialStatus, overtimeFlag: signals.overtimeFlag, discrepancyFlag: signals.discrepancyFlag },
  });

  return toListItem(created);
}

export async function updateTimeEntry(id: string, input: UpdateTimeEntryInput): Promise<TimeEntryListItem> {
  const existing = await scopedDb.timeEntry.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Time entry not found");

  // F5.6 (plan §8, aprobado implícito por el ciclo de vida) + F9.6
  // (extensión aditiva): editable mientras sigue DRAFT o PENDING — una
  // vez SUBMITTED/NEEDS_REVIEW/APPROVED/LOCKED las horas dejan de ser
  // editables a mano libre (corregirlas requeriría antes un reject/
  // reopen explícito, ver `rejectTimeEntry`/`reopenTimeEntry`).
  if (existing.status !== "PENDING" && existing.status !== "DRAFT") {
    throw AppError.badRequest(`Cannot edit a Time entry that is already ${existing.status}`, {
      status: existing.status,
    });
  }

  const mergedHours = {
    regularHours: input.regularHours ?? Number(existing.regularHours),
    overtimeHours: input.overtimeHours ?? Number(existing.overtimeHours),
    doubleHours: input.doubleHours ?? Number(existing.doubleHours),
  };
  assertReasonableHours(mergedHours);
  const signals = await computeSignalsForEntry(existing.assignmentId, existing.date, mergedHours);

  const updated = await scopedDb.timeEntry.update({
    where: { id },
    data: {
      regularHours: input.regularHours,
      overtimeHours: input.overtimeHours,
      doubleHours: input.doubleHours,
      perDiem: input.perDiem,
      bonus: input.bonus,
      overtimeFlag: signals.overtimeFlag,
      discrepancyFlag: signals.discrepancyFlag,
      discrepancyNotes: signals.discrepancyNotes,
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
  // F9.6: SUBMITTED se suma a PENDING como elegible -- ambos representan
  // "ya enviado, esperando revisión" en el lifecycle extendido; NEEDS_REVIEW
  // se excluye a propósito (requiere revisión manual explícita antes de
  // aprobar, nunca un bulk-approve ciego sobre una discrepancia detectada).
  const eligible = candidates.filter((e) => e.status === "PENDING" || e.status === "SUBMITTED");
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

/**
 * F9.6: transición genérica de un único TimeEntry -- guardada por el
 * grafo canónico (`TIME_ENTRY_STATUS_TRANSITIONS`, packages/shared).
 * Nunca decide POR SÍ SOLA aprobar/rechazar: cada wrapper público abajo
 * fija explícitamente el `to` que representa una acción humana real.
 */
async function transitionTimeEntry(
  id: string,
  to: TimeEntryStatusValue,
  action: string,
  extra?: { rejectionReason?: string | null; approvedById?: string | null },
): Promise<TimeEntryListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.timeEntry.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Time entry not found");

  const from = existing.status as TimeEntryStatusValue;
  if (from === to) return toListItem(await scopedDb.timeEntry.findUniqueOrThrow({ where: { id }, include: TIME_ENTRY_INCLUDE }));

  if (!isValidTimeEntryStatusTransition(from, to)) {
    throw AppError.badRequest(`Cannot transition Time entry from ${from} to ${to}`, {
      from,
      to,
      allowedFromCurrentStatus: TIME_ENTRY_STATUS_TRANSITIONS[from],
    });
  }

  const updated = await scopedDb.timeEntry.update({
    where: { id },
    data: {
      status: to,
      rejectionReason: extra?.rejectionReason !== undefined ? extra.rejectionReason : undefined,
      approvedById: extra?.approvedById !== undefined ? extra.approvedById : undefined,
    },
    include: TIME_ENTRY_INCLUDE,
  });

  await logActivity({
    entityType: "assignment",
    entityId: existing.assignmentId,
    type: "SYSTEM",
    subject: `Time entry status changed: ${from} → ${to}`,
  });
  await logAuditEvent({
    action,
    entityType: "timeEntry",
    entityId: id,
    before: { status: from },
    after: { status: to },
  });

  return toListItem(updated);
}

/**
 * F9.6: envía un DRAFT a revisión -- recalcula las señales sobre las
 * horas ACTUALES (pudieron editarse mientras seguía DRAFT) y decide el
 * destino determinísticamente vía `computeSubmissionTargetStatus`, nunca
 * a discreción de quien llama.
 */
export async function submitTimeEntry(id: string): Promise<TimeEntryListItem> {
  const existing = await scopedDb.timeEntry.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Time entry not found");
  if (existing.status !== "DRAFT") {
    throw AppError.badRequest(`Cannot submit a Time entry that is ${existing.status} (must be DRAFT)`, { status: existing.status });
  }

  const hours = {
    regularHours: Number(existing.regularHours),
    overtimeHours: Number(existing.overtimeHours),
    doubleHours: Number(existing.doubleHours),
  };
  const signals = await computeSignalsForEntry(existing.assignmentId, existing.date, hours);
  if (signals.discrepancyFlag !== existing.discrepancyFlag || signals.overtimeFlag !== existing.overtimeFlag) {
    await scopedDb.timeEntry.update({
      where: { id },
      data: { overtimeFlag: signals.overtimeFlag, discrepancyFlag: signals.discrepancyFlag, discrepancyNotes: signals.discrepancyNotes },
    });
  }
  const target = computeSubmissionTargetStatus(signals.discrepancyFlag);
  return transitionTimeEntry(id, target, "timeEntry.submitted");
}

export async function approveTimeEntry(id: string): Promise<TimeEntryListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  return transitionTimeEntry(id, "APPROVED", "timeEntry.approved", { approvedById: ctx.userId });
}

export async function rejectTimeEntry(id: string, input: RejectTimeEntryInput): Promise<TimeEntryListItem> {
  return transitionTimeEntry(id, "REJECTED", "timeEntry.rejected", { rejectionReason: input.rejectionReason });
}

/** F9.6: REJECTED siempre reabre a DRAFT (nunca un rechazo permanente) -- limpia el rejectionReason previo al reabrir. */
export async function reopenTimeEntry(id: string): Promise<TimeEntryListItem> {
  return transitionTimeEntry(id, "DRAFT", "timeEntry.reopened", { rejectionReason: null });
}

// ================= Shifts (F9.6) =================

function toShiftListItem(shift: {
  id: string;
  assignmentId: string;
  assignment: { worker: { candidate: { firstName: string; lastName: string } }; jobOrder: { title: string } };
  date: Date;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  timezone: string | null;
  notes: string | null;
}): ShiftListItem {
  return {
    id: shift.id,
    assignmentId: shift.assignmentId,
    workerName: `${shift.assignment.worker.candidate.firstName} ${shift.assignment.worker.candidate.lastName}`,
    jobOrderTitle: shift.assignment.jobOrder.title,
    date: shift.date.toISOString(),
    startTime: shift.startTime,
    endTime: shift.endTime,
    breakMinutes: shift.breakMinutes,
    scheduledHours: computeShiftScheduledHours(shift.startTime, shift.endTime, shift.breakMinutes).toFixed(2),
    timezone: shift.timezone,
    notes: shift.notes,
  };
}

const SHIFT_INCLUDE = {
  assignment: { include: { worker: { include: { candidate: true } }, jobOrder: true } },
} as const;

export async function listShifts(query: ShiftQuery): Promise<Paginated<ShiftListItem>> {
  const rows = await scopedDb.shift.findMany({
    ...buildCursorArgs(query),
    where: {
      assignmentId: query.assignmentId,
      date:
        query.dateFrom || query.dateTo
          ? {
              gte: query.dateFrom ? new Date(query.dateFrom) : undefined,
              lte: query.dateTo ? new Date(query.dateTo) : undefined,
            }
          : undefined,
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: SHIFT_INCLUDE,
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);
  return { items: items.map(toShiftListItem), nextCursor };
}

export async function createShift(input: CreateShiftInput): Promise<ShiftListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const assignment = await scopedDb.assignment.findUnique({ where: { id: input.assignmentId } });
  if (!assignment) throw AppError.badRequest("Assignment not found");

  const created = await scopedDb.shift.create({
    data: {
      tenantId: ctx.tenantId,
      assignmentId: input.assignmentId,
      date: new Date(input.date),
      startTime: input.startTime,
      endTime: input.endTime,
      breakMinutes: input.breakMinutes ?? 0,
      timezone: input.timezone,
      notes: input.notes,
    },
    include: SHIFT_INCLUDE,
  });

  await logActivity({
    entityType: "assignment",
    entityId: input.assignmentId,
    type: "SYSTEM",
    subject: `Shift scheduled: ${input.date.slice(0, 10)} ${input.startTime}-${input.endTime}`,
  });
  await logAuditEvent({
    action: "shift.created",
    entityType: "shift",
    entityId: created.id,
    after: { assignmentId: input.assignmentId, date: input.date, startTime: input.startTime, endTime: input.endTime },
  });

  return toShiftListItem(created);
}

export async function updateShift(id: string, input: UpdateShiftInput): Promise<ShiftListItem> {
  const existing = await scopedDb.shift.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Shift not found");

  const updated = await scopedDb.shift.update({
    where: { id },
    data: {
      startTime: input.startTime,
      endTime: input.endTime,
      breakMinutes: input.breakMinutes,
      timezone: input.timezone,
      notes: input.notes,
    },
    include: SHIFT_INCLUDE,
  });

  await logAuditEvent({
    action: "shift.updated",
    entityType: "shift",
    entityId: id,
    before: { startTime: existing.startTime, endTime: existing.endTime, breakMinutes: existing.breakMinutes },
    after: { startTime: updated.startTime, endTime: updated.endTime, breakMinutes: updated.breakMinutes },
  });

  return toShiftListItem(updated);
}

// ================= Payroll Runs (F5.7) =================

// F5.7 (plan §9.2, aprobado como valor provisional hasta que se apruebe
// un campo/setting real — ver JobOrder.supervisorContactId/otMultiplier
// en el plan §4.2/§9.2): multiplicador fijo de horas extra.
const OT_MULTIPLIER = 1.5;

async function resolveUserName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const user = await scopedDb.user.findUnique({ where: { id: userId } });
  return user ? `${user.firstName} ${user.lastName}` : null;
}

async function toPayrollRunListItem(run: {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  status: string;
  totalGross: { toString(): string };
  totalBill: { toString(): string };
  totalMargin: { toString(): string };
  createdById: string | null;
  approvedById: string | null;
  createdAt: Date;
  _count?: { items: number };
}): Promise<PayrollRunListItem> {
  const itemCount = run._count?.items ?? (await scopedDb.payrollItem.count({ where: { payrollRunId: run.id } }));
  return {
    id: run.id,
    periodStart: run.periodStart.toISOString(),
    periodEnd: run.periodEnd.toISOString(),
    status: run.status as never,
    totalGross: run.totalGross.toString(),
    totalBill: run.totalBill.toString(),
    totalMargin: run.totalMargin.toString(),
    itemCount,
    createdByName: await resolveUserName(run.createdById),
    approvedByName: await resolveUserName(run.approvedById),
    createdAt: run.createdAt.toISOString(),
  };
}

export async function listPayrollRuns(query: PaginationQuery): Promise<Paginated<PayrollRunListItem>> {
  const rows = await scopedDb.payrollRun.findMany({
    ...buildCursorArgs(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { _count: { select: { items: true } } },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);
  const mapped: PayrollRunListItem[] = [];
  for (const run of items) mapped.push(await toPayrollRunListItem(run));
  return { items: mapped, nextCursor };
}

export async function getPayrollRunDetail(id: string): Promise<PayrollRunDetail> {
  const run = await scopedDb.payrollRun.findUnique({
    where: { id },
    include: {
      items: { include: { worker: { include: { candidate: true } }, assignment: { include: { jobOrder: true } } } },
    },
  });
  if (!run) throw AppError.notFound("Payroll run not found");

  const items: PayrollItem[] = run.items.map((item) => ({
    id: item.id,
    workerName: `${item.worker.candidate.firstName} ${item.worker.candidate.lastName}`,
    jobOrderTitle: item.assignment.jobOrder.title,
    regularHours: item.regularHours.toString(),
    otHours: item.otHours.toString(),
    regularPay: item.regularPay.toString(),
    otPay: item.otPay.toString(),
    perDiem: item.perDiem.toString(),
    bonus: item.bonus.toString(),
    grossPay: item.grossPay.toString(),
    billAmount: item.billAmount.toString(),
    margin: item.margin.toString(),
  }));

  return {
    ...(await toPayrollRunListItem(run)),
    items,
    updatedAt: run.updatedAt.toISOString(),
  };
}

/**
 * F5.7 (plan §9.2, aprobado): agrega TimeEntry APPROVED (nunca PENDING)
 * dentro del período, agrupadas por Assignment → Worker. Marca cada
 * TimeEntry incluida como LOCKED en la misma transacción — impide que
 * una hora ya pagada se vuelva a incluir en otro run.
 *
 * Limitación real documentada (no un bug oculto): PayrollItem no tiene
 * una columna propia para horas dobles (el schema, desde F0, solo
 * declara regularHours/otHours) — TimeEntry.doubleHours se suma dentro
 * de otHours para el cálculo agregado, aplicando el mismo OT_MULTIPLIER
 * a ambas. Esto es una simplificación real: horas dobles deberían
 * pagarse a 2x, no a 1.5x. Se documenta acá y en el informe final en
 * vez de ocultarlo — resolver esto correctamente requeriría una columna
 * nueva en PayrollItem, que no se agrega sin aprobación explícita.
 */
export async function createPayrollRun(input: CreatePayrollRunInput): Promise<PayrollRunListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const periodStart = new Date(input.periodStart);
  const periodEnd = new Date(input.periodEnd);

  const entries = await scopedDb.timeEntry.findMany({
    where: { status: "APPROVED", date: { gte: periodStart, lte: periodEnd } },
    include: { assignment: true },
  });

  if (entries.length === 0) {
    throw AppError.badRequest("No APPROVED time entries were found in this period", {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    });
  }

  const byAssignment = new Map<string, typeof entries>();
  for (const entry of entries) {
    const group = byAssignment.get(entry.assignmentId) ?? [];
    group.push(entry);
    byAssignment.set(entry.assignmentId, group);
  }

  let totalGross = 0;
  let totalBill = 0;
  let totalMargin = 0;
  const itemsData: Array<{
    assignmentId: string;
    workerId: string;
    regularHours: number;
    otHours: number;
    regularPay: number;
    otPay: number;
    perDiem: number;
    bonus: number;
    grossPay: number;
    billAmount: number;
    margin: number;
  }> = [];

  for (const [assignmentId, group] of byAssignment) {
    const assignment = group[0]!.assignment;
    const payRate = Number(assignment.payRate);
    const billRate = Number(assignment.billRate);

    let regularHours = 0;
    let otHours = 0;
    let perDiem = 0;
    let bonus = 0;
    for (const entry of group) {
      regularHours += Number(entry.regularHours);
      otHours += Number(entry.overtimeHours) + Number(entry.doubleHours);
      perDiem += Number(entry.perDiem ?? 0);
      bonus += Number(entry.bonus ?? 0);
    }

    const regularPay = regularHours * payRate;
    const otPay = otHours * payRate * OT_MULTIPLIER;
    const grossPay = regularPay + otPay + perDiem + bonus;
    const billAmount = (regularHours + otHours) * billRate;
    const margin = billAmount - grossPay;

    totalGross += grossPay;
    totalBill += billAmount;
    totalMargin += margin;

    itemsData.push({
      assignmentId,
      workerId: assignment.workerId,
      regularHours,
      otHours,
      regularPay,
      otPay,
      perDiem,
      bonus,
      grossPay,
      billAmount,
      margin,
    });
  }

  const entryIds = entries.map((e) => e.id);

  const run = await scopedDb.$transaction(async (tx) => {
    const created = await tx.payrollRun.create({
      data: {
        tenantId: ctx.tenantId,
        periodStart,
        periodEnd,
        status: "DRAFT",
        totalGross,
        totalBill,
        totalMargin,
        createdById: ctx.userId,
      },
    });

    for (const item of itemsData) {
      await tx.payrollItem.create({
        data: {
          tenantId: ctx.tenantId,
          payrollRunId: created.id,
          ...item,
        },
      });
    }

    await tx.timeEntry.updateMany({ where: { id: { in: entryIds } }, data: { status: "LOCKED" } });

    return created;
  });

  await logActivity({
    entityType: "payrollRun",
    entityId: run.id,
    type: "SYSTEM",
    subject: `Payroll run created: ${input.periodStart.slice(0, 10)} → ${input.periodEnd.slice(0, 10)} (${itemsData.length} workers)`,
  });
  await logAuditEvent({
    action: "payrollRun.created",
    entityType: "payrollRun",
    entityId: run.id,
    after: { periodStart: input.periodStart, periodEnd: input.periodEnd, itemCount: itemsData.length, totalGross },
  });

  return toPayrollRunListItem(run);
}

async function transitionPayrollRun(
  id: string,
  to: "PENDING_APPROVAL" | "APPROVED" | "PAID" | "EXPORTED",
  action: string,
): Promise<PayrollRunListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.payrollRun.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Payroll run not found");

  const from = existing.status as never;
  if (from === to) return toPayrollRunListItem(existing);

  if (!isValidPayrollRunStatusTransition(from, to)) {
    throw AppError.badRequest(`Cannot transition Payroll run from ${existing.status} to ${to}`, {
      from: existing.status,
      to,
      allowedFromCurrentStatus: PAYROLL_RUN_STATUS_TRANSITIONS[from],
    });
  }

  // F5.7 (plan §9.3, aprobado): separación de funciones — quien crea el
  // run no puede ser quien lo aprueba.
  if (to === "APPROVED" && existing.createdById === ctx.userId) {
    throw AppError.forbidden("A Payroll run cannot be approved by the same user who created it");
  }

  const updated = await scopedDb.payrollRun.update({
    where: { id },
    data: {
      status: to,
      approvedById: to === "APPROVED" ? ctx.userId : undefined,
    },
  });

  await logActivity({
    entityType: "payrollRun",
    entityId: id,
    type: "SYSTEM",
    subject: `Payroll run status changed: ${existing.status} → ${to}`,
  });
  await logAuditEvent({
    action,
    entityType: "payrollRun",
    entityId: id,
    before: { status: existing.status },
    after: { status: to },
  });

  return toPayrollRunListItem(updated);
}

export async function submitPayrollRun(id: string): Promise<PayrollRunListItem> {
  return transitionPayrollRun(id, "PENDING_APPROVAL", "payrollRun.submitted");
}

export async function approvePayrollRun(id: string): Promise<PayrollRunListItem> {
  return transitionPayrollRun(id, "APPROVED", "payrollRun.approved");
}

export async function markPayrollRunPaid(id: string): Promise<PayrollRunListItem> {
  return transitionPayrollRun(id, "PAID", "payrollRun.paid");
}

function toCsvRow(fields: Array<string | number>): string {
  return fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(",");
}

/**
 * F5.7 (plan §9.3/§9.6, aprobado): "genera un archivo — CSV en la
 * primera pasada, sin PDF todavía". Sin storage real (decisión ya
 * diferida desde F0/F5.5) — se devuelve el CSV directo en la respuesta
 * HTTP para descarga, nunca se guarda un archivo en disco/bucket.
 */
export async function exportPayrollRun(id: string): Promise<{ csv: string; filename: string }> {
  const detail = await getPayrollRunDetail(id);
  if (detail.status !== "PAID") {
    throw AppError.badRequest(`Cannot export a Payroll run that is ${detail.status} (must be PAID first)`, {
      status: detail.status,
    });
  }

  await transitionPayrollRun(id, "EXPORTED", "payrollRun.exported");

  const header = toCsvRow([
    "Worker",
    "Job Order",
    "Regular Hours",
    "OT Hours",
    "Regular Pay",
    "OT Pay",
    "Per Diem",
    "Bonus",
    "Gross Pay",
    "Bill Amount",
    "Margin",
  ]);
  const rows = detail.items.map((item) =>
    toCsvRow([
      item.workerName,
      item.jobOrderTitle,
      item.regularHours,
      item.otHours,
      item.regularPay,
      item.otPay,
      item.perDiem,
      item.bonus,
      item.grossPay,
      item.billAmount,
      item.margin,
    ]),
  );
  const csv = [header, ...rows].join("\n");
  const filename = `payroll-run-${detail.periodStart.slice(0, 10)}-to-${detail.periodEnd.slice(0, 10)}.csv`;

  return { csv, filename };
}
