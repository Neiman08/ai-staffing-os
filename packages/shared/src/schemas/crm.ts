import { z } from "zod";
import { paginationQuerySchema } from "./common";

export const companySizeSchema = z.enum(["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"]);
// F4.5: procedencia de una Company — nunca debe haber duda entre demo,
// manual, CSV, o descubierta externamente.
export const companyOriginSchema = z.enum([
  "DEMO_SEED",
  "MANUAL",
  "CSV_IMPORT",
  "EXTERNAL_DISCOVERY",
  "API_PROVIDER",
]);
export const companyVerificationStatusSchema = z.enum(["UNVERIFIED", "CONFIRMED", "INFERRED"]);
// F4.6: mismo shape que companyVerificationStatusSchema, enum propio
// (Contact es una entidad distinta con su propio ciclo de vida de
// procedencia) — ver ContactVerificationStatus en el schema de Prisma.
export const contactVerificationStatusSchema = z.enum(["UNVERIFIED", "CONFIRMED", "INFERRED"]);
// F4.7: entregabilidad del EMAIL específicamente — distinto de
// contactVerificationStatusSchema (que describe la procedencia del
// contacto como registro completo). Solo VERIFIED habilita outreach.
export const emailVerificationStatusSchema = z.enum(["NOT_VERIFIED", "VERIFIED", "RISKY", "INVALID", "UNKNOWN"]);
export const contactDecisionRoleSchema = z.enum([
  "OWNER",
  "HR",
  "OPERATIONS_MANAGER",
  "PROJECT_MANAGER",
  "PLANT_MANAGER",
  "RECRUITER",
  "OTHER",
  // F4.6: cargos prioritarios del Contact Intelligence Agent.
  "TALENT_ACQUISITION",
  "WAREHOUSE_MANAGER",
  "GENERAL_MANAGER",
  "PURCHASING_MANAGER",
  "DIRECTOR_OF_OPERATIONS",
]);
// F7.8: espeja ContactRankingTier de contact-ranking.ts (apps/api).
export const contactRankingTierSchema = z.enum(["HIGH_CONFIDENCE", "MEDIUM_CONFIDENCE", "LOW_CONFIDENCE", "REJECTED"]);

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
  // F4.5: transparencia de origen — ver companyOriginSchema.
  origin: companyOriginSchema,
  sourceUrl: z.string().nullable(),
  verificationStatus: companyVerificationStatusSchema,
  confidenceScore: z.number().nullable(),
});
export type CompanyListItem = z.infer<typeof companyListItemSchema>;

// Datos demo/real: excludeDemo oculta origin=DEMO_SEED — datos reales
// visibles por defecto en vistas comerciales (el frontend decide el
// default, acá solo se define el filtro en sí). Deriva de
// companyOriginSchema ya existente, sin campo/modelo nuevo.
export const companyQuerySchema = paginationQuerySchema.extend({
  excludeDemo: z.coerce.boolean().optional(),
});
export type CompanyQuery = z.infer<typeof companyQuerySchema>;

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
  // F4.6: transparencia de procedencia — mismo principio "nunca
  // inventar" que Company desde F4.5.
  source: z.string().nullable(),
  confidenceScore: z.number().nullable(),
  discoveredAt: z.string().nullable(),
  verificationStatus: contactVerificationStatusSchema,
  // F4.7: procedencia y verificación del email — ver
  // docs/F4_7_EMAIL_INTELLIGENCE_PLAN.md §4.
  emailSource: z.string().nullable(),
  emailSourceUrl: z.string().nullable(),
  emailVerificationStatus: emailVerificationStatusSchema,
  emailConfidenceScore: z.number().nullable(),
  emailVerifiedAt: z.string().nullable(),
  doNotContact: z.boolean(),
  // F7.8: Contact Verification and Ranking -- null cuando el Contact no
  // pasó todavía por el ranking determinista (contact-ranking.ts).
  rankingTier: contactRankingTierSchema.nullable(),
  rankingScore: z.number().nullable(),
  rankingReasons: z.array(z.string()),
  rankedAt: z.string().nullable(),
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
  email: z.string().nullable(),
  commercialScoreReason: z.string().nullable(), // F2: explicación auditable del Sales Agent
  notes: z.string().nullable(),
  possibleCategoryNames: z.array(z.string()),
  contacts: z.array(contactSummarySchema),
  opportunities: z.array(opportunitySummarySchema),
  upcomingFollowUps: z.array(followUpSummarySchema),
  recentActivity: z.array(activityItemSchema),
  // F4.5: solo presentes cuando origin es EXTERNAL_DISCOVERY/API_PROVIDER.
  discoveredAt: z.string().nullable(),
  discoveredByAgentTaskId: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
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
  // F4.6: denormalizados de Company para poder filtrar la página
  // Contacts por industria/estado sin un join en el cliente.
  industryName: z.string(),
  companyState: z.string().nullable(),
  // Datos demo/real: denormalizado de Company.origin para el badge/filtro
  // "Solo datos reales" — mismo campo que ya usa Companies, sin duplicar
  // el enum.
  companyOrigin: companyOriginSchema,
});
export type ContactListItem = z.infer<typeof contactListItemSchema>;

// F4.6: filtros de la página Contacts — todos opcionales, se combinan
// con AND. confidenceMin es un piso (>=), no un rango.
export const contactQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  industryName: z.string().optional(),
  companyState: z.string().optional(),
  decisionRole: contactDecisionRoleSchema.optional(),
  verificationStatus: contactVerificationStatusSchema.optional(),
  emailVerificationStatus: emailVerificationStatusSchema.optional(), // F4.7
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  companyId: z.string().optional(),
  companyName: z.string().optional(), // búsqueda parcial, insensible a mayúsculas
  excludeDemo: z.coerce.boolean().optional(), // datos reales por defecto en vistas comerciales
  rankingTier: contactRankingTierSchema.optional(), // F7.8
});
export type ContactQuery = z.infer<typeof contactQuerySchema>;
