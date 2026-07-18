import { z } from "zod";
import { paginationQuerySchema } from "./common";

// F5.6 (base) + F9.6 (extensión ADITIVA -- "no se amplía" original
// revisitado por instrucción explícita del PO). PENDING/APPROVED/LOCKED
// conservan EXACTAMENTE su semántica y transiciones previas; DRAFT/
// SUBMITTED/NEEDS_REVIEW/REJECTED son etapas nuevas del lifecycle
// extendido (submission/review explícitos). `createTimeEntry` sigue
// produciendo PENDING sin cambios salvo que se pida el nuevo flujo
// (`startAsDraft`).
export const timeEntryStatusSchema = z.enum(["DRAFT", "PENDING", "SUBMITTED", "NEEDS_REVIEW", "APPROVED", "REJECTED", "LOCKED"]);
export type TimeEntryStatusValue = z.infer<typeof timeEntryStatusSchema>;

/**
 * REJECTED siempre reabre a DRAFT (nunca un rechazo permanente).
 * LOCKED es terminal (mismo criterio F5.7: una vez en un PayrollRun, no
 * se reabre).
 */
export const TIME_ENTRY_STATUS_TRANSITIONS: Record<TimeEntryStatusValue, TimeEntryStatusValue[]> = {
  DRAFT: ["SUBMITTED", "NEEDS_REVIEW"],
  PENDING: ["APPROVED", "REJECTED", "LOCKED"],
  SUBMITTED: ["APPROVED", "REJECTED", "NEEDS_REVIEW", "LOCKED"],
  NEEDS_REVIEW: ["APPROVED", "REJECTED", "SUBMITTED"],
  APPROVED: ["LOCKED"],
  REJECTED: ["DRAFT"],
  LOCKED: [],
};

export function isValidTimeEntryStatusTransition(from: TimeEntryStatusValue, to: TimeEntryStatusValue): boolean {
  if (from === to) return true;
  return TIME_ENTRY_STATUS_TRANSITIONS[from].includes(to);
}

export const timeEntryQuerySchema = paginationQuerySchema.extend({
  assignmentId: z.string().optional(),
  status: timeEntryStatusSchema.optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});
export type TimeEntryQuery = z.infer<typeof timeEntryQuerySchema>;

// F5.6 (plan §8.2, aprobado): un TimeEntry por assignmentId+date (la
// constraint única ya existe en el schema desde F0) — el rango 0-24h por
// categoría de hora y la suma diaria <=24h son "validaciones de negocio
// razonables", verificadas en el servicio contra los valores fusionados
// (mismo patrón que billRate/payRate de Job Orders).
//
// F9.6: `startAsDraft` opcional -- si es true, el TimeEntry nace DRAFT
// (requiere un submit explícito después) en vez de PENDING directo
// (comportamiento F5.6 original, preservado por default para no romper
// integraciones existentes).
export const createTimeEntryInputSchema = z.object({
  assignmentId: z.string().min(1),
  date: z.string().min(1),
  regularHours: z.number().min(0).max(24).optional(),
  overtimeHours: z.number().min(0).max(24).optional(),
  doubleHours: z.number().min(0).max(24).optional(),
  perDiem: z.number().nonnegative().optional(),
  bonus: z.number().nonnegative().optional(),
  startAsDraft: z.boolean().optional(),
});
export type CreateTimeEntryInput = z.infer<typeof createTimeEntryInputSchema>;

// F9.6: motivo obligatorio al rechazar -- nunca un rechazo silencioso.
export const rejectTimeEntryInputSchema = z.object({
  rejectionReason: z.string().min(1),
});
export type RejectTimeEntryInput = z.infer<typeof rejectTimeEntryInputSchema>;

// F5.6: sin assignmentId/date (identidad inmutable del registro — cambiar
// cualquiera de los dos sería, en efecto, otro TimeEntry) ni status (se
// cambia únicamente vía bulk-approve). Solo editable mientras el
// TimeEntry sigue PENDING (verificado en el servicio).
export const updateTimeEntryInputSchema = z.object({
  regularHours: z.number().min(0).max(24).optional(),
  overtimeHours: z.number().min(0).max(24).optional(),
  doubleHours: z.number().min(0).max(24).optional(),
  perDiem: z.number().nonnegative().optional(),
  bonus: z.number().nonnegative().optional(),
});
export type UpdateTimeEntryInput = z.infer<typeof updateTimeEntryInputSchema>;

export const bulkApproveTimeEntriesInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});
export type BulkApproveTimeEntriesInput = z.infer<typeof bulkApproveTimeEntriesInputSchema>;

export const bulkApproveTimeEntriesResultSchema = z.object({
  approved: z.number(),
  skipped: z.number(),
});
export type BulkApproveTimeEntriesResult = z.infer<typeof bulkApproveTimeEntriesResultSchema>;

export const timeEntryListItemSchema = z.object({
  id: z.string(),
  workerName: z.string(),
  jobOrderTitle: z.string(),
  date: z.string(),
  regularHours: z.string(),
  overtimeHours: z.string(),
  doubleHours: z.string(),
  status: z.string(),
  source: z.string(),
  billAmount: z.string(),
  payAmount: z.string(),
  margin: z.string(),
  // F9.6: señales de revisión -- nunca una decisión automática (ver
  // apps/api time-entry-signals.ts).
  overtimeFlag: z.boolean(),
  discrepancyFlag: z.boolean(),
  discrepancyNotes: z.string().nullable(),
  rejectionReason: z.string().nullable(),
});
export type TimeEntryListItem = z.infer<typeof timeEntryListItemSchema>;

// ================= Shifts (F9.6) =================

// F9.6: sin assignmentId+date únicos forzados por schema (a diferencia de
// TimeEntry) -- un Assignment puede, en principio, tener más de un Shift
// planeado el mismo día (ej. split shift); no se inventa una restricción
// de negocio que el PO no pidió.
export const createShiftInputSchema = z.object({
  assignmentId: z.string().min(1),
  date: z.string().min(1),
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "startTime must be HH:MM (24h)"),
  endTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "endTime must be HH:MM (24h)"),
  breakMinutes: z.number().int().min(0).max(720).optional(),
  timezone: z.string().min(1).optional(),
  notes: z.string().optional(),
});
export type CreateShiftInput = z.infer<typeof createShiftInputSchema>;

export const updateShiftInputSchema = z.object({
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "startTime must be HH:MM (24h)")
    .optional(),
  endTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "endTime must be HH:MM (24h)")
    .optional(),
  breakMinutes: z.number().int().min(0).max(720).optional(),
  timezone: z.string().min(1).optional(),
  notes: z.string().optional(),
});
export type UpdateShiftInput = z.infer<typeof updateShiftInputSchema>;

export const shiftQuerySchema = paginationQuerySchema.extend({
  assignmentId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});
export type ShiftQuery = z.infer<typeof shiftQuerySchema>;

export const shiftListItemSchema = z.object({
  id: z.string(),
  assignmentId: z.string(),
  workerName: z.string(),
  jobOrderTitle: z.string(),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  breakMinutes: z.number(),
  scheduledHours: z.string(),
  timezone: z.string().nullable(),
  notes: z.string().nullable(),
});
export type ShiftListItem = z.infer<typeof shiftListItemSchema>;

// F5.7: enum real (packages/db/prisma/schema.prisma PayrollRunStatus) —
// no se amplía. Secuencia estrictamente hacia adelante, sin reapertura
// (plan §9.3): DRAFT → PENDING_APPROVAL → APPROVED → PAID → EXPORTED.
export const payrollRunStatusSchema = z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "PAID", "EXPORTED"]);
export type PayrollRunStatusValue = z.infer<typeof payrollRunStatusSchema>;

export const PAYROLL_RUN_STATUS_TRANSITIONS: Record<PayrollRunStatusValue, PayrollRunStatusValue[]> = {
  DRAFT: ["PENDING_APPROVAL"],
  PENDING_APPROVAL: ["APPROVED"],
  APPROVED: ["PAID"],
  PAID: ["EXPORTED"],
  EXPORTED: [],
};

export function isValidPayrollRunStatusTransition(from: PayrollRunStatusValue, to: PayrollRunStatusValue): boolean {
  if (from === to) return true;
  return PAYROLL_RUN_STATUS_TRANSITIONS[from].includes(to);
}

// F5.7 (plan §9.1, aprobado): sin cálculos fiscales — decisión D7 de la
// arquitectura original, no una restricción nueva de esta fase.
export const createPayrollRunInputSchema = z
  .object({
    periodStart: z.string().min(1),
    periodEnd: z.string().min(1),
  })
  .refine((v) => new Date(v.periodEnd) >= new Date(v.periodStart), {
    message: "periodEnd cannot be before periodStart",
    path: ["periodEnd"],
  });
export type CreatePayrollRunInput = z.infer<typeof createPayrollRunInputSchema>;

export const payrollItemSchema = z.object({
  id: z.string(),
  workerName: z.string(),
  jobOrderTitle: z.string(),
  regularHours: z.string(),
  otHours: z.string(),
  regularPay: z.string(),
  otPay: z.string(),
  perDiem: z.string(),
  bonus: z.string(),
  grossPay: z.string(),
  billAmount: z.string(),
  margin: z.string(),
});
export type PayrollItem = z.infer<typeof payrollItemSchema>;

export const payrollRunListItemSchema = z.object({
  id: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: payrollRunStatusSchema,
  totalGross: z.string(),
  totalBill: z.string(),
  totalMargin: z.string(),
  itemCount: z.number(),
  createdByName: z.string().nullable(),
  approvedByName: z.string().nullable(),
  createdAt: z.string(),
});
export type PayrollRunListItem = z.infer<typeof payrollRunListItemSchema>;

export const payrollRunDetailSchema = payrollRunListItemSchema.extend({
  items: z.array(payrollItemSchema),
  updatedAt: z.string(),
});
export type PayrollRunDetail = z.infer<typeof payrollRunDetailSchema>;
