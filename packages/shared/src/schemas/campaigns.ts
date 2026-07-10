import { z } from "zod";
import { activityItemSchema, companySizeSchema, followUpSummarySchema } from "./crm";
import { paginationQuerySchema } from "./common";

// ============================================================
// F4: Campaign / CampaignCompany — ver F4_AUTONOMOUS_OUTREACH_PLAN.md
// §5-§11. Una campaña agrupa empresas ya existentes en el CRM bajo
// criterios de segmentación compartidos; CampaignCompany registra el
// estado de una empresa DENTRO de una campaña específica.
// ============================================================

export const campaignStatusSchema = z.enum(["DRAFT", "ACTIVE", "PAUSED", "COMPLETED"]);
export const campaignCompanyStatusSchema = z.enum([
  "TARGETED",
  "SEQUENCING",
  "HOT",
  "COLD",
  "RECOVERED",
  "CONVERTED",
  "EXCLUDED",
]);
export const conversationIntentSchema = z.enum([
  "INTERESTED",
  "VERY_INTERESTED",
  "CALL_LATER",
  "NO_BUDGET",
  "HAS_PROVIDER",
  "NOT_INTERESTED",
  "OUT_OF_MARKET",
]);

export const campaignQuerySchema = paginationQuerySchema.extend({
  status: campaignStatusSchema.optional(),
});
export type CampaignQuery = z.infer<typeof campaignQuerySchema>;

export const campaignListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: campaignStatusSchema,
  industryName: z.string().nullable(),
  state: z.string().nullable(),
  city: z.string().nullable(),
  minCompanySize: companySizeSchema.nullable(),
  maxCompanySize: companySizeSchema.nullable(),
  minScore: z.number().nullable(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]),
  createdByAgentTaskId: z.string().nullable(), // badge "AI" cuando la creó el Campaign Agent
  statusCounts: z.record(z.string(), z.number()), // conteo de CampaignCompany por status
  costUsd: z.number(),
  createdAt: z.string(),
});
export type CampaignListItem = z.infer<typeof campaignListItemSchema>;

export const campaignCompanyListItemSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  status: campaignCompanyStatusSchema,
  lastIntent: conversationIntentSchema.nullable(),
  lastIntentAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CampaignCompanyListItem = z.infer<typeof campaignCompanyListItemSchema>;

export const campaignDetailSchema = campaignListItemSchema.extend({
  targetCategoryIds: z.array(z.string()),
  leadsCreated: z.number(),
  opportunitiesCreated: z.number(),
  opportunitiesValueUsd: z.number(),
  latestRecommendation: z.string().nullable(), // último output de optimizeCampaign
  companies: z.array(campaignCompanyListItemSchema),
});
export type CampaignDetail = z.infer<typeof campaignDetailSchema>;

export const createCampaignInputSchema = z.object({
  name: z.string().min(1),
  industryId: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  minCompanySize: companySizeSchema.optional(),
  maxCompanySize: companySizeSchema.optional(),
  targetCategoryIds: z.array(z.string()).optional(),
  minScore: z.number().min(0).max(100).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
});
export type CreateCampaignInput = z.infer<typeof createCampaignInputSchema>;

export const updateCampaignInputSchema = z.object({
  status: campaignStatusSchema.optional(),
  name: z.string().min(1).optional(),
  minScore: z.number().min(0).max(100).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
});
export type UpdateCampaignInput = z.infer<typeof updateCampaignInputSchema>;

// Los tres tipos de tarea que se pueden invocar sobre una campaña completa
// (POST /campaigns/:id/tasks) — measure_campaign no gasta IA, es agregación.
export const campaignTaskInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("select_target_companies"), input: z.object({ limit: z.number().int().positive().max(50).optional() }) }),
  z.object({ type: z.literal("measure_campaign"), input: z.object({}) }),
  z.object({ type: z.literal("optimize_campaign"), input: z.object({}) }),
]);
export type CampaignTaskInput = z.infer<typeof campaignTaskInputSchema>;

// ============================================================
// F4: CampaignCompany detail — secuencia (FollowUp) + conversación
// (Activity), reutilizando los schemas ya existentes de crm.ts.
// ============================================================

export const campaignCompanyDetailSchema = campaignCompanyListItemSchema.extend({
  industryName: z.string(),
  commercialScore: z.number().nullable(),
  sequence: z.array(followUpSummarySchema),
  recentActivity: z.array(activityItemSchema),
});
export type CampaignCompanyDetail = z.infer<typeof campaignCompanyDetailSchema>;

// Los tres tipos de tarea que se pueden invocar sobre una empresa puntual
// dentro de una campaña (POST /campaign-companies/:id/tasks).
export const campaignCompanyTaskInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan_sequence"), input: z.object({}) }),
  z.object({ type: z.literal("personalize_message"), input: z.object({ step: z.number().int().min(0).max(3) }) }),
  z.object({ type: z.literal("suggest_next_step"), input: z.object({}) }),
]);
export type CampaignCompanyTaskInput = z.infer<typeof campaignCompanyTaskInputSchema>;

export const logConversationInputSchema = z.object({
  replyText: z.string().min(1).max(5000),
});
export type LogConversationInput = z.infer<typeof logConversationInputSchema>;

export const logConversationResultSchema = z.object({
  intent: conversationIntentSchema,
  rationale: z.string(),
  newStatus: campaignCompanyStatusSchema,
});
export type LogConversationResult = z.infer<typeof logConversationResultSchema>;
