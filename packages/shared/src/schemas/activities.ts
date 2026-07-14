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
// F5.2: mismo tipo de gap que "jobOrder" en F5.1 — "candidate" y "worker"
// ya eran valores válidos de Activity.entityType desde F0 (comentario del
// modelo en schema.prisma), pero nunca se agregaron acá. Se corrigen antes
// de conectar el timeline de Candidate/Worker Detail, no después de un 400
// real en el navegador.
// F5.4: "assignment" agregado proactivamente antes de conectar su
// timeline — el mismo tipo de gap ("jobOrder" en F5.1, "candidate"/
// "worker" en F5.2) ya se repitió dos veces; se corrige de antemano acá.
export const activityEntityTypeSchema = z.enum([
  "company",
  "lead",
  "opportunity",
  "contact",
  "jobOrder",
  "candidate",
  "worker",
  "assignment",
  "payrollRun", // F5.7
]);

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
