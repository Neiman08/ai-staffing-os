import { z } from "zod";

export const revenueSummarySchema = z.object({
  newLeadsThisWeek: z.number(),
  companiesContacted: z.number(),
  pendingFollowUps: z.number(),
  openOpportunities: z.number(),
  pipelineValue: z.string(),
  scheduledMeetings: z.number(),
  companiesByIndustry: z.array(z.object({ industryName: z.string(), count: z.number() })),
  companiesByState: z.array(z.object({ state: z.string(), count: z.number() })),
});
export type RevenueSummary = z.infer<typeof revenueSummarySchema>;

export const industryPerformanceSchema = z.object({
  industryName: z.string(),
  wonOpportunities: z.number(),
  wonRevenue: z.string(),
});

export const statePerformanceSchema = z.object({
  state: z.string(),
  wonOpportunities: z.number(),
  wonRevenue: z.string(),
});

export const topOpportunitySchema = z.object({
  id: z.string(),
  title: z.string(),
  companyName: z.string(),
  estimatedRevenue: z.string().nullable(),
  stage: z.string(),
});

export const staleLeadSchema = z.object({
  id: z.string(),
  companyName: z.string().nullable(),
  status: z.string(),
  daysSinceLastActivity: z.number(),
});

export const dormantClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  daysSinceLastActivity: z.number(),
});

export const pipelineByStageSchema = z.object({
  stage: z.string(),
  count: z.number(),
  totalValue: z.string(),
  weightedValue: z.string(),
});

export const revenueIntelligenceSchema = z.object({
  topIndustries: z.array(industryPerformanceSchema),
  topStates: z.array(statePerformanceSchema),
  biggestOpportunities: z.array(topOpportunitySchema),
  leadsWithoutFollowUp: z.array(staleLeadSchema),
  dormantClients: z.array(dormantClientSchema),
  pipelineByStage: z.array(pipelineByStageSchema),
});
export type RevenueIntelligence = z.infer<typeof revenueIntelligenceSchema>;
