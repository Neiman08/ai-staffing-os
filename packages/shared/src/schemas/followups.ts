import { z } from "zod";
import { paginationQuerySchema } from "./common";

export const followUpTypeSchema = z.enum(["CALL", "EMAIL", "LINKEDIN", "MEETING"]);
export const followUpStatusSchema = z.enum(["PENDING", "DONE", "SNOOZED", "CANCELLED"]);
export const followUpEntityTypeSchema = z.enum(["company", "lead", "opportunity", "contact"]);
export const followUpPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

export const followUpQuerySchema = paginationQuerySchema.extend({
  status: followUpStatusSchema.optional(),
  assignedToId: z.string().optional(),
  entityType: followUpEntityTypeSchema.optional(),
  overdue: z.coerce.boolean().optional(),
});
export type FollowUpQuery = z.infer<typeof followUpQuerySchema>;

export const followUpListItemSchema = z.object({
  id: z.string(),
  entityType: followUpEntityTypeSchema,
  entityId: z.string(),
  entityLabel: z.string(),
  type: followUpTypeSchema,
  dueDate: z.string(),
  priority: followUpPrioritySchema,
  assignedToLabel: z.string().nullable(),
  status: followUpStatusSchema,
  notes: z.string().nullable(),
  overdue: z.boolean(),
  createdByAgentTaskId: z.string().nullable(), // F3: badge "AI"
  campaignId: z.string().nullable(), // F4: paso de una secuencia de campaña
  createdAt: z.string(),
});
export type FollowUpListItem = z.infer<typeof followUpListItemSchema>;

export const createFollowUpInputSchema = z.object({
  entityType: followUpEntityTypeSchema,
  entityId: z.string().min(1),
  type: followUpTypeSchema,
  dueDate: z.string(),
  priority: followUpPrioritySchema.optional(),
  assignedToId: z.string().optional(),
  reminderAt: z.string().optional(),
  notes: z.string().optional(),
});
export type CreateFollowUpInput = z.infer<typeof createFollowUpInputSchema>;

export const updateFollowUpInputSchema = z.object({
  dueDate: z.string().optional(),
  priority: followUpPrioritySchema.optional(),
  assignedToId: z.string().optional(),
  status: followUpStatusSchema.optional(),
  notes: z.string().optional(),
});
export type UpdateFollowUpInput = z.infer<typeof updateFollowUpInputSchema>;
