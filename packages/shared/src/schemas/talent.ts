import { z } from "zod";

export const candidateListItemSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  languages: z.array(z.string()),
  categoryNames: z.array(z.string()),
  status: z.string(),
  aiScore: z.number().nullable(),
  isWorker: z.boolean(),
  createdAt: z.string(),
});
export type CandidateListItem = z.infer<typeof candidateListItemSchema>;

export const industryListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  isGlobal: z.boolean(),
});
export type IndustryListItem = z.infer<typeof industryListItemSchema>;

export const jobCategoryListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  industryName: z.string().nullable(),
  requiredCertifications: z.array(z.string()),
});
export type JobCategoryListItem = z.infer<typeof jobCategoryListItemSchema>;
