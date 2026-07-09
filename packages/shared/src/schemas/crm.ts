import { z } from "zod";

export const companyListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  industryName: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  contactCount: z.number(),
  createdAt: z.string(),
});
export type CompanyListItem = z.infer<typeof companyListItemSchema>;
