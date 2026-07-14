import { z } from "zod";
import { paginationQuerySchema } from "./common";

// F5.4: enum real (packages/db/prisma/schema.prisma AssignmentStatus) —
// no se amplía. Dos estados terminales (COMPLETED/TERMINATED) ya bastan
// para representar "cerrado" (mismo criterio que el plan aprobado §6.2:
// el motivo de cierre se captura como texto libre en Activity, no como
// un campo/enum nuevo — ver `reason` en updateAssignmentStatusInputSchema).
export const assignmentStatusSchema = z.enum(["SCHEDULED", "ACTIVE", "COMPLETED", "TERMINATED"]);
export type AssignmentStatusValue = z.infer<typeof assignmentStatusSchema>;

/**
 * F5.4: matriz aprobada (plan §6.1-6.2). SCHEDULED es siempre el estado
 * inicial (nunca se crea directo en ACTIVE — debe iniciar explícitamente).
 * COMPLETED/TERMINATED son terminales, sin reapertura (no se pidió una).
 */
export const ASSIGNMENT_STATUS_TRANSITIONS: Record<AssignmentStatusValue, AssignmentStatusValue[]> = {
  SCHEDULED: ["ACTIVE", "TERMINATED"],
  ACTIVE: ["COMPLETED", "TERMINATED"],
  COMPLETED: [],
  TERMINATED: [],
};

/** Idempotente: pedir el mismo estado ya vigente siempre es válido (no-op), nunca un error. */
export function isValidAssignmentStatusTransition(from: AssignmentStatusValue, to: AssignmentStatusValue): boolean {
  if (from === to) return true;
  return ASSIGNMENT_STATUS_TRANSITIONS[from].includes(to);
}

export const assignmentListItemSchema = z.object({
  id: z.string(),
  workerId: z.string(),
  workerName: z.string(),
  jobOrderId: z.string(),
  jobOrderTitle: z.string(),
  companyName: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  payRate: z.string(),
  billRate: z.string(),
  startDate: z.string(),
  endDate: z.string().nullable(),
  status: assignmentStatusSchema,
  createdAt: z.string(),
});
export type AssignmentListItem = z.infer<typeof assignmentListItemSchema>;

// F5.4: se mantiene cursor/limit — misma convención de todo el resto del
// repo (Job Orders/Candidates/Workers), no page/pageSize.
export const assignmentQuerySchema = paginationQuerySchema.extend({
  search: z.string().optional(), // contains sobre worker.candidate.firstName/lastName y jobOrder.title
  workerId: z.string().optional(),
  jobOrderId: z.string().optional(),
  projectId: z.string().optional(),
  status: assignmentStatusSchema.optional(),
  sortBy: z.enum(["createdAt", "startDate"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});
export type AssignmentQuery = z.infer<typeof assignmentQuerySchema>;

export const assignmentDetailSchema = assignmentListItemSchema.extend({
  workerComplianceStatus: z.string(),
  updatedAt: z.string(),
});
export type AssignmentDetail = z.infer<typeof assignmentDetailSchema>;

// F5.4 (plan §6.3, aprobado): payRate/billRate son snapshot al crear —
// nunca se recalculan desde JobOrder después. status/workerId/jobOrderId
// nunca cambian tras la creación (workerId/jobOrderId son la identidad de
// la relación; status se cambia únicamente vía PATCH .../status).
export const createAssignmentInputSchema = z
  .object({
    workerId: z.string().min(1),
    jobOrderId: z.string().min(1),
    projectId: z.string().optional(),
    payRate: z.number().nonnegative(),
    billRate: z.number().nonnegative(),
    startDate: z.string().min(1),
    endDate: z.string().optional(),
  })
  .refine((v) => !v.endDate || new Date(v.endDate) >= new Date(v.startDate), {
    message: "endDate cannot be before startDate",
    path: ["endDate"],
  });
export type CreateAssignmentInput = z.infer<typeof createAssignmentInputSchema>;

// F5.4: sin refine de fechas acá — un PATCH parcial puede traer solo
// endDate; el servicio valida contra los valores ya existentes fusionados
// con el patch (mismo patrón que updateJobOrderInputSchema, F5.1).
// Deliberadamente SIN workerId/jobOrderId/status/tenantId.
export const updateAssignmentInputSchema = z.object({
  projectId: z.string().optional(),
  payRate: z.number().nonnegative().optional(),
  billRate: z.number().nonnegative().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentInputSchema>;

// F5.4 (plan §6.2, aprobado): el motivo de cierre se captura como texto
// libre dentro de la Activity generada, no como un campo estructurado
// nuevo — YAGNI hasta que exista un caso de uso real que pida reportar
// rotación por motivo de forma estructurada.
export const updateAssignmentStatusInputSchema = z.object({
  status: assignmentStatusSchema,
  reason: z.string().optional(),
});
export type UpdateAssignmentStatusInput = z.infer<typeof updateAssignmentStatusInputSchema>;
