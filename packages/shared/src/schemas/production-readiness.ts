import { z } from "zod";

/**
 * F4.7.5: Production Cleanup — todos los endpoints acá son de solo
 * lectura (auditoría/reportes/planes), ninguno borra ni fusiona nada.
 * Ver apps/api/src/modules/production-readiness/.
 */
export const dataOriginSchema = z.enum([
  "DEMO",
  "SEED",
  "MANUAL",
  "GOOGLE_PLACES",
  "PEOPLE_DATA_LABS",
  "WEBSITE",
  "HUNTER",
  "API_PROVIDER",
  "IMPORT",
  "USER_CREATED",
  "UNKNOWN",
]);
export type DataOrigin = z.infer<typeof dataOriginSchema>;

const originCountsSchema = z.record(dataOriginSchema, z.number());

export const entityOriginAuditSchema = z.object({
  entity: z.string(),
  total: z.number(),
  byOrigin: originCountsSchema,
});
export const productionAuditReportSchema = z.object({
  generatedAt: z.string(),
  entities: z.array(entityOriginAuditSchema),
});
export type ProductionAuditReport = z.infer<typeof productionAuditReportSchema>;

export const cleanupStepSchema = z.object({
  entity: z.string(),
  order: z.number(),
  count: z.number(),
  ids: z.array(z.string()),
  note: z.string(),
});
export const cleanupBlockerSchema = z.object({
  entity: z.string(),
  count: z.number(),
  companyIds: z.array(z.string()),
  note: z.string(),
});
export const cleanupPlanSchema = z.object({
  generatedAt: z.string(),
  totalRecordsToDelete: z.number(),
  steps: z.array(cleanupStepSchema),
  blockers: z.array(cleanupBlockerSchema),
});
export type CleanupPlan = z.infer<typeof cleanupPlanSchema>;

export const duplicateGroupSchema = z.object({
  matchType: z.enum(["name+state", "website", "email", "linkedin", "name+company"]),
  key: z.string(),
  ids: z.array(z.string()),
  count: z.number(),
});
export const duplicatesReportSchema = z.object({
  generatedAt: z.string(),
  companies: z.object({ byNameState: z.array(duplicateGroupSchema), byWebsite: z.array(duplicateGroupSchema) }),
  contacts: z.object({
    byEmail: z.array(duplicateGroupSchema),
    byLinkedin: z.array(duplicateGroupSchema),
    byNameCompany: z.array(duplicateGroupSchema),
  }),
  summary: z.object({ totalDuplicateGroups: z.number(), totalAffectedRecords: z.number() }),
});
export type DuplicatesReport = z.infer<typeof duplicatesReportSchema>;

export const fieldMergeDecisionSchema = z.object({
  field: z.string(),
  chosenValue: z.unknown(),
  chosenFromId: z.string(),
  reason: z.string(),
});
export const reassignmentNeededSchema = z.object({ entity: z.string(), count: z.number(), note: z.string() });
export const mergePlanSchema = z.object({
  entity: z.enum(["Company", "Contact"]),
  matchType: duplicateGroupSchema.shape.matchType,
  matchKey: z.string(),
  primaryId: z.string(),
  primaryReason: z.string(),
  duplicateIds: z.array(z.string()),
  fieldDecisions: z.array(fieldMergeDecisionSchema),
  reassignmentsNeeded: z.array(reassignmentNeededSchema),
});
export const mergePlanReportSchema = z.object({ generatedAt: z.string(), plans: z.array(mergePlanSchema) });
export type MergePlanReport = z.infer<typeof mergePlanReportSchema>;

export const productionReadinessSummarySchema = z.object({
  generatedAt: z.string(),
  productionMode: z.boolean(),
  companies: z.object({ real: z.number(), demo: z.number(), incomplete: z.number(), avgQualityScore: z.number() }),
  contacts: z.object({
    real: z.number(),
    demo: z.number(),
    incomplete: z.number(),
    avgQualityScore: z.number(),
    emailsVerified: z.number(),
  }),
  duplicates: z.object({ groups: z.number(), affectedRecords: z.number() }),
  readiness: z.object({
    dataQualityComponent: z.number(),
    duplicatesComponent: z.number(),
    percentReady: z.number(),
  }),
});
export type ProductionReadinessSummary = z.infer<typeof productionReadinessSummarySchema>;
