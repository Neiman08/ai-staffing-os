import { z } from "zod";
import { paginationQuerySchema } from "./common";

// F5.4 originalmente decía "no se amplía" -- F9.5 lo revisita por
// instrucción explícita del PO (extensión ADITIVA, ver migración
// `20260717220000_f9_5_assignment_management`). SCHEDULED/ACTIVE/
// COMPLETED/TERMINATED conservan EXACTAMENTE su semántica y
// transiciones previas; DRAFT/PENDING_APPROVAL son etapas nuevas antes
// de SCHEDULED (que pasa a jugar el rol de "CONFIRMED"); PAUSED es
// reversible entre SCHEDULED/ACTIVE; CANCELLED es una alternativa
// reversible a TERMINATED (que sigue terminal, sin reapertura).
export const assignmentStatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "SCHEDULED",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
  "TERMINATED",
]);
export type AssignmentStatusValue = z.infer<typeof assignmentStatusSchema>;

/**
 * F5.4 (base) + F9.5 (extensión aditiva). COMPLETED/TERMINATED siguen
 * terminales, sin reapertura. CANCELLED siempre puede reabrirse a
 * DRAFT (nunca un rechazo permanente, mismo criterio que F8.7/F9.1-4).
 */
export const ASSIGNMENT_STATUS_TRANSITIONS: Record<AssignmentStatusValue, AssignmentStatusValue[]> = {
  DRAFT: ["PENDING_APPROVAL", "CANCELLED"],
  PENDING_APPROVAL: ["SCHEDULED", "DRAFT", "CANCELLED"],
  SCHEDULED: ["ACTIVE", "PAUSED", "CANCELLED", "TERMINATED"],
  ACTIVE: ["PAUSED", "COMPLETED", "TERMINATED"],
  PAUSED: ["ACTIVE", "CANCELLED", "TERMINATED"],
  COMPLETED: [],
  CANCELLED: ["DRAFT"],
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
  placementId: z.string().nullable(),
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
    // F9.5: enlace opcional a un Placement (F9.4) YA aprobado -- si se
    // provee, el Assignment nace en DRAFT (nuevo lifecycle extendido)
    // en vez de SCHEDULED (comportamiento F5.4 sin cambios cuando no
    // se provee).
    placementId: z.string().optional(),
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
