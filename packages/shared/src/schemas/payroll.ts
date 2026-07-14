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
