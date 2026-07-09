import { z } from "zod";

export const activityTypeSchema = z.enum(["NOTE", "CALL", "EMAIL", "MEETING", "TASK", "SYSTEM"]);
export const activityEntityTypeSchema = z.enum(["company", "lead", "opportunity", "contact"]);

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
