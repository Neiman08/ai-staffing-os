import { z } from "zod";

export const pricingScenarioListItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  recommendedPayMin: z.string(),
  recommendedPayMax: z.string(),
  recommendedBillMin: z.string(),
  recommendedBillMax: z.string(),
  grossMarginPerHour: z.string(),
  netMarginPerHour: z.string().nullable(),
  hiringRisk: z.string(),
  dataConfidence: z.string(),
  status: z.string(),
  rationale: z.string(),
  createdAt: z.string(),
});
export type PricingScenarioListItem = z.infer<typeof pricingScenarioListItemSchema>;
