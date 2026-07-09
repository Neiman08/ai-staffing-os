import { z } from "zod";

export const timeEntryListItemSchema = z.object({
  id: z.string(),
  workerName: z.string(),
  jobOrderTitle: z.string(),
  date: z.string(),
  regularHours: z.string(),
  overtimeHours: z.string(),
  doubleHours: z.string(),
  status: z.string(),
  source: z.string(),
  billAmount: z.string(),
  payAmount: z.string(),
  margin: z.string(),
});
export type TimeEntryListItem = z.infer<typeof timeEntryListItemSchema>;
