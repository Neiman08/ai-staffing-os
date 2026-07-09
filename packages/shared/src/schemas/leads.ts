import { z } from "zod";
import { activityItemSchema, followUpSummarySchema, nextFollowUpSchema } from "./crm";
import { paginationQuerySchema } from "./common";

export const leadPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const leadStatusSchema = z.enum(["NEW", "CONTACTED", "INTERESTED", "QUALIFIED", "UNQUALIFIED", "CONVERTED"]);

export const leadQuerySchema = paginationQuerySchema.extend({
  status: leadStatusSchema.optional(),
  source: z.string().optional(),
  priority: leadPrioritySchema.optional(),
  assignedToId: z.string().optional(),
  industryId: z.string().optional(),
});
export type LeadQuery = z.infer<typeof leadQuerySchema>;

export const leadListItemSchema = z.object({
  id: z.string(),
  companyName: z.string().nullable(),
  industryName: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  source: z.string().nullable(),
  status: leadStatusSchema,
  priority: leadPrioritySchema,
  ownerLabel: z.string().nullable(),
  aiScore: z.number().nullable(),
  nextFollowUp: nextFollowUpSchema,
  createdByAgentTaskId: z.string().nullable(), // F2: badge "AI" en la UI cuando no es null
  createdAt: z.string(),
});
export type LeadListItem = z.infer<typeof leadListItemSchema>;

export const leadDetailSchema = leadListItemSchema.extend({
  companyId: z.string().nullable(),
  industryId: z.string().nullable(),
  aiScoreReason: z.string().nullable(),
  notes: z.string().nullable(),
  ownerId: z.string().nullable(),
  upcomingFollowUps: z.array(followUpSummarySchema),
  recentActivity: z.array(activityItemSchema),
});
export type LeadDetail = z.infer<typeof leadDetailSchema>;

export const createLeadInputSchema = z.object({
  companyId: z.string().optional(),
  industryId: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  source: z.string().optional(),
  priority: leadPrioritySchema.optional(),
  status: leadStatusSchema.optional(),
  ownerId: z.string().optional(),
  aiScore: z.number().min(0).max(10).optional(),
  aiScoreReason: z.string().optional(),
  notes: z.string().optional(),
});
export type CreateLeadInput = z.infer<typeof createLeadInputSchema>;

export const updateLeadInputSchema = createLeadInputSchema.partial();
export type UpdateLeadInput = z.infer<typeof updateLeadInputSchema>;

export const convertLeadInputSchema = z.object({
  // Required only if the lead has no companyId yet.
  newCompanyName: z.string().optional(),
  opportunity: z.object({
    title: z.string().min(1),
    categoryId: z.string().optional(),
    estimatedWorkers: z.number().int().positive().optional(),
    estimatedPayRate: z.number().positive().optional(),
    estimatedBillRate: z.number().positive().optional(),
    estimatedRevenue: z.number().positive().optional(),
    probability: z.number().min(0).max(100).optional(),
    expectedCloseDate: z.string().optional(),
  }),
});
export type ConvertLeadInput = z.infer<typeof convertLeadInputSchema>;

export const convertLeadResultSchema = z.object({
  companyId: z.string(),
  opportunityId: z.string(),
});
export type ConvertLeadResult = z.infer<typeof convertLeadResultSchema>;
