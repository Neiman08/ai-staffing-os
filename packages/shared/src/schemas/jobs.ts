import { z } from "zod";
import { paginationQuerySchema } from "./common";
import { riskLevelSchema } from "./agents";

// F5.1: DRAFT agregado (migraciones 20260713190000/20260713190100) — un
// Job Order nuevo SIEMPRE arranca acá, nunca en OPEN directamente.
export const jobOrderStatusSchema = z.enum([
  "DRAFT",
  "OPEN",
  "PARTIALLY_FILLED",
  "FILLED",
  "CLOSED",
  "CANCELLED",
]);
export type JobOrderStatusValue = z.infer<typeof jobOrderStatusSchema>;

export const jobOrderShiftTypeSchema = z.enum(["DAY", "NIGHT", "WEEKEND", "ROTATING"]);

/**
 * F5.1: matriz de transiciones manuales aprobada por el PO. PARTIALLY_FILLED
 * y FILLED nunca son destino de una transición manual — se automatizan
 * cuando exista el módulo de Assignments (fase posterior); intentar
 * moverlas a mano es rechazado explícitamente por el servicio, nunca
 * silenciosamente ignorado.
 */
export const JOB_ORDER_STATUS_TRANSITIONS: Record<JobOrderStatusValue, JobOrderStatusValue[]> = {
  DRAFT: ["OPEN", "CANCELLED"],
  OPEN: ["CLOSED", "CANCELLED"],
  PARTIALLY_FILLED: ["CLOSED", "CANCELLED"],
  FILLED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

/** Idempotente: pedir el mismo estado ya vigente siempre es válido (no-op), nunca un error. */
export function isValidJobOrderStatusTransition(from: JobOrderStatusValue, to: JobOrderStatusValue): boolean {
  if (from === to) return true;
  return JOB_ORDER_STATUS_TRANSITIONS[from].includes(to);
}

// F5.1: { city, state } obligatorios en cuanto se provee location — address
// sigue siendo libre. Si location se omite del todo, no aplica ninguna
// restricción (el campo completo es opcional un nivel más arriba).
export const jobOrderLocationSchema = z.object({
  address: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
});
export type JobOrderLocation = z.infer<typeof jobOrderLocationSchema>;

export const jobOrderListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  categoryId: z.string(),
  categoryName: z.string(),
  status: jobOrderStatusSchema,
  workersNeeded: z.number(),
  workersFilled: z.number(),
  billRate: z.string(),
  payRate: z.string(),
  shiftType: z.string(),
  urgency: riskLevelSchema,
  startDate: z.string(),
  endDate: z.string().nullable(),
  createdAt: z.string(),
});
export type JobOrderListItem = z.infer<typeof jobOrderListItemSchema>;

// F5.1: se mantiene cursor/limit (convención real del resto del repo —
// Companies/Contacts/Leads/Candidates todos paginan así) en vez de
// page/pageSize. El resto de los filtros pedidos se soportan tal cual.
export const jobOrderQuerySchema = paginationQuerySchema.extend({
  search: z.string().optional(), // contains sobre title, insensible a mayúsculas
  status: jobOrderStatusSchema.optional(),
  companyId: z.string().optional(),
  categoryId: z.string().optional(),
  urgency: riskLevelSchema.optional(),
  startDateFrom: z.string().optional(),
  startDateTo: z.string().optional(),
  sortBy: z.enum(["createdAt", "startDate"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});
export type JobOrderQuery = z.infer<typeof jobOrderQuerySchema>;

export const jobOrderDetailSchema = jobOrderListItemSchema.extend({
  description: z.string().nullable(),
  location: jobOrderLocationSchema.nullable(),
  scheduleNotes: z.string().nullable(),
  requirements: z.array(z.string()),
  createdById: z.string().nullable(),
  createdByName: z.string().nullable(),
  updatedAt: z.string(),
});
export type JobOrderDetail = z.infer<typeof jobOrderDetailSchema>;

export const createJobOrderInputSchema = z
  .object({
    companyId: z.string().min(1),
    categoryId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    workersNeeded: z.number().int().positive(),
    billRate: z.number().nonnegative(),
    payRate: z.number().nonnegative(),
    location: jobOrderLocationSchema.optional(),
    shiftType: jobOrderShiftTypeSchema.optional(),
    scheduleNotes: z.string().optional(),
    startDate: z.string().min(1),
    endDate: z.string().optional(),
    urgency: riskLevelSchema.optional(),
    requirements: z.array(z.string()).optional(),
    // Deliberadamente SIN: status, workersFilled, createdById, tenantId —
    // ninguno de los cuatro se acepta desde el body bajo ninguna forma.
  })
  .refine((v) => v.billRate > v.payRate, {
    message: "billRate must be greater than payRate",
    path: ["billRate"],
  })
  .refine((v) => !v.endDate || new Date(v.endDate) >= new Date(v.startDate), {
    message: "endDate cannot be before startDate",
    path: ["endDate"],
  });
export type CreateJobOrderInput = z.infer<typeof createJobOrderInputSchema>;

// F5.1: sin refine de billRate/payRate ni de fechas acá — un PATCH parcial
// puede traer solo uno de los dos lados de cada comparación; el servicio
// valida contra los valores ya existentes fusionados con el patch, no
// contra el body aislado (ver jobs/service.ts).
export const updateJobOrderInputSchema = z.object({
  companyId: z.string().min(1).optional(),
  categoryId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  workersNeeded: z.number().int().positive().optional(),
  billRate: z.number().nonnegative().optional(),
  payRate: z.number().nonnegative().optional(),
  location: jobOrderLocationSchema.optional(),
  shiftType: jobOrderShiftTypeSchema.optional(),
  scheduleNotes: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  urgency: riskLevelSchema.optional(),
  requirements: z.array(z.string()).optional(),
  // Deliberadamente SIN: status, workersFilled, createdById, tenantId —
  // el estado se cambia únicamente vía PATCH /job-orders/:id/status.
});
export type UpdateJobOrderInput = z.infer<typeof updateJobOrderInputSchema>;

export const updateJobOrderStatusInputSchema = z.object({
  status: jobOrderStatusSchema,
});
export type UpdateJobOrderStatusInput = z.infer<typeof updateJobOrderStatusInputSchema>;
