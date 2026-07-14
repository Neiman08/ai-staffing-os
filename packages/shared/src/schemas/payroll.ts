import { z } from "zod";
import { paginationQuerySchema } from "./common";

// F5.6: enum real (packages/db/prisma/schema.prisma TimeEntryStatus) — no
// se amplía. LOCKED nunca se alcanza desde este módulo: se reserva para
// cuando una TimeEntry entra a un PayrollRun (F5.7, todavía no
// implementado) — F5.6 solo produce PENDING/APPROVED.
export const timeEntryStatusSchema = z.enum(["PENDING", "APPROVED", "LOCKED"]);
export type TimeEntryStatusValue = z.infer<typeof timeEntryStatusSchema>;

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
export const createTimeEntryInputSchema = z.object({
  assignmentId: z.string().min(1),
  date: z.string().min(1),
  regularHours: z.number().min(0).max(24).optional(),
  overtimeHours: z.number().min(0).max(24).optional(),
  doubleHours: z.number().min(0).max(24).optional(),
  perDiem: z.number().nonnegative().optional(),
  bonus: z.number().nonnegative().optional(),
});
export type CreateTimeEntryInput = z.infer<typeof createTimeEntryInputSchema>;

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
});
export type TimeEntryListItem = z.infer<typeof timeEntryListItemSchema>;

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
