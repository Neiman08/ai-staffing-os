import { z } from "zod";

export const companySizeSchema = z.enum(["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"]);
export const contactDecisionRoleSchema = z.enum([
  "OWNER",
  "HR",
  "OPERATIONS_MANAGER",
  "PROJECT_MANAGER",
  "PLANT_MANAGER",
  "RECRUITER",
  "OTHER",
]);

export const nextFollowUpSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    dueDate: z.string(),
  })
  .nullable();

export const companyListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  industryName: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  estimatedSize: companySizeSchema.nullable(),
  commercialScore: z.number().nullable(),
  contactCount: z.number(),
  openOpportunityCount: z.number(),
  nextFollowUp: nextFollowUpSchema,
  lastActivityAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CompanyListItem = z.infer<typeof companyListItemSchema>;

export const contactSummarySchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  title: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  decisionRole: contactDecisionRoleSchema.nullable(),
  isPrimary: z.boolean(),
});
export type ContactSummary = z.infer<typeof contactSummarySchema>;

export const opportunitySummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  stage: z.string(),
  estimatedRevenue: z.string().nullable(),
  probability: z.number().nullable(),
  createdByAgentTaskId: z.string().nullable(), // F3: badge "AI"
});
export type OpportunitySummary = z.infer<typeof opportunitySummarySchema>;

export const followUpSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  dueDate: z.string(),
  notes: z.string().nullable(),
  createdByAgentTaskId: z.string().nullable(), // F3: badge "AI"
});
export type FollowUpSummary = z.infer<typeof followUpSummarySchema>;

export const activityItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  subject: z.string(),
  body: z.string().nullable(),
  performedByLabel: z.string(),
  createdAt: z.string(),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const companyDetailSchema = companyListItemSchema.extend({
  website: z.string().nullable(),
  phone: z.string().nullable(),
  commercialScoreReason: z.string().nullable(), // F2: explicación auditable del Sales Agent
  notes: z.string().nullable(),
  possibleCategoryNames: z.array(z.string()),
  contacts: z.array(contactSummarySchema),
  opportunities: z.array(opportunitySummarySchema),
  upcomingFollowUps: z.array(followUpSummarySchema),
  recentActivity: z.array(activityItemSchema),
});
export type CompanyDetail = z.infer<typeof companyDetailSchema>;

export const createCompanyInputSchema = z.object({
  name: z.string().min(1),
  industryId: z.string().min(1),
  status: z.enum(["LEAD", "PROSPECT", "CLIENT", "INACTIVE"]).optional(),
  website: z.string().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  estimatedSize: companySizeSchema.optional(),
  possibleCategoryIds: z.array(z.string()).optional(),
  commercialScore: z.number().min(0).max(100).optional(),
  notes: z.string().optional(),
});
export type CreateCompanyInput = z.infer<typeof createCompanyInputSchema>;

export const updateCompanyInputSchema = createCompanyInputSchema.partial();
export type UpdateCompanyInput = z.infer<typeof updateCompanyInputSchema>;

export const contactInputSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  title: z.string().optional(),
  linkedinUrl: z.string().optional(),
  decisionRole: contactDecisionRoleSchema.optional(),
  isPrimary: z.boolean().optional(),
});
export type ContactInput = z.infer<typeof contactInputSchema>;

export const updateContactInputSchema = contactInputSchema.partial();
export type UpdateContactInput = z.infer<typeof updateContactInputSchema>;

export const contactListItemSchema = contactSummarySchema.extend({
  companyId: z.string(),
  companyName: z.string(),
});
export type ContactListItem = z.infer<typeof contactListItemSchema>;
