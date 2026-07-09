import { z } from "zod";

export const documentListItemSchema = z.object({
  id: z.string(),
  documentTypeName: z.string(),
  ownerLabel: z.string(),
  ownerType: z.enum(["candidate", "worker"]),
  status: z.string(),
  issuedDate: z.string().nullable(),
  expirationDate: z.string().nullable(),
  verifiedByAgent: z.boolean(),
});
export type DocumentListItem = z.infer<typeof documentListItemSchema>;

export const complianceAlertListItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.string(),
  message: z.string(),
  workerName: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ComplianceAlertListItem = z.infer<typeof complianceAlertListItemSchema>;

export const documentTypeListItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  category: z.string(),
  requiresExpiration: z.boolean(),
});
export type DocumentTypeListItem = z.infer<typeof documentTypeListItemSchema>;
