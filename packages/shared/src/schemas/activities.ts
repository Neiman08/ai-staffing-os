import { z } from "zod";

export const activityTypeSchema = z.enum(["NOTE", "CALL", "EMAIL", "MEETING", "TASK", "SYSTEM"]);
// F5.1: bug real encontrado al conectar el timeline de Job Order Detail —
// Activity.entityType es un String libre en el schema de Prisma desde F0
// (el propio comentario del modelo ya listaba "jobOrder" como valor
// válido: "company" | "candidate" | "jobOrder" | "lead" | "opportunity" |
// "contact" | ...), pero este enum de validación nunca se actualizó para
// incluirlo — GET /activities?entityType=jobOrder devolvía 400 aunque
// logActivity ya escribía filas jobOrder.created/updated/status_changed
// sin problema (logActivity no valida contra este enum, solo el query de
// lectura lo hacía). Se agrega "jobOrder" acá, sin tocar el modelo.
export const activityEntityTypeSchema = z.enum(["company", "lead", "opportunity", "contact", "jobOrder"]);

export const activityQuerySchema = z.object({
  entityType: activityEntityTypeSchema,
  entityId: z.string().min(1),
});
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export const createActivityInputSchema = z.object({
  entityType: activityEntityTypeSchema,
  entityId: z.string().min(1),
  type: activityTypeSchema,
  subject: z.string().min(1),
  body: z.string().optional(),
});
export type CreateActivityInput = z.infer<typeof createActivityInputSchema>;
