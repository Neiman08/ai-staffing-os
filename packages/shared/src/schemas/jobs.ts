import { z } from "zod";

export const jobOrderListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  companyName: z.string(),
  categoryName: z.string(),
  status: z.string(),
  workersNeeded: z.number(),
  workersFilled: z.number(),
  billRate: z.string(),
  payRate: z.string(),
  shiftType: z.string(),
  urgency: z.string(),
  startDate: z.string(),
});
export type JobOrderListItem = z.infer<typeof jobOrderListItemSchema>;
