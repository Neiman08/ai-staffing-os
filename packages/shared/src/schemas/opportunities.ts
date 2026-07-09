import { z } from "zod";
import { activityItemSchema, followUpSummarySchema } from "./crm";

export const opportunityStageSchema = z.enum([
  "MEETING_SCHEDULED",
  "PROPOSAL_SENT",
  "NEGOTIATION",
  "WON",
  "LOST",
]);

export const opportunityListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  stage: opportunityStageSchema,
  categoryName: z.string().nullable(),
  estimatedWorkers: z.number().nullable(),
  estimatedPayRate: z.string().nullable(),
  estimatedBillRate: z.string().nullable(),
  estimatedMarginPerHour: z.string().nullable(),
  estimatedRevenue: z.string().nullable(),
  probability: z.number().nullable(),
  expectedCloseDate: z.string().nullable(),
  ownerLabel: z.string().nullable(),
  createdAt: z.string(),
});
export type OpportunityListItem = z.infer<typeof opportunityListItemSchema>;

export const opportunityDetailSchema = opportunityListItemSchema.extend({
  categoryId: z.string().nullable(),
  ownerId: z.string().nullable(),
  upcomingFollowUps: z.array(followUpSummarySchema),
  recentActivity: z.array(activityItemSchema),
});
export type OpportunityDetail = z.infer<typeof opportunityDetailSchema>;

export const createOpportunityInputSchema = z.object({
  companyId: z.string().min(1),
  title: z.string().min(1),
  stage: opportunityStageSchema.optional(),
  categoryId: z.string().optional(),
  estimatedWorkers: z.number().int().positive().optional(),
  estimatedPayRate: z.number().positive().optional(),
  estimatedBillRate: z.number().positive().optional(),
  estimatedRevenue: z.number().positive().optional(),
  probability: z.number().min(0).max(100).optional(),
  expectedCloseDate: z.string().optional(),
  ownerId: z.string().optional(),
});
export type CreateOpportunityInput = z.infer<typeof createOpportunityInputSchema>;

export const updateOpportunityInputSchema = createOpportunityInputSchema.partial().omit({ companyId: true });
export type UpdateOpportunityInput = z.infer<typeof updateOpportunityInputSchema>;

export const updateOpportunityStageInputSchema = z.object({
  stage: opportunityStageSchema,
});
export type UpdateOpportunityStageInput = z.infer<typeof updateOpportunityStageInputSchema>;

export const pipelineColumnSchema = z.object({
  stage: opportunityStageSchema,
  totalValue: z.string(),
  opportunities: z.array(opportunityListItemSchema),
});
export type PipelineColumn = z.infer<typeof pipelineColumnSchema>;

export const pipelineResponseSchema = z.object({
  columns: z.array(pipelineColumnSchema),
});
export type PipelineResponse = z.infer<typeof pipelineResponseSchema>;
