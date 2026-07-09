import { z } from "zod";
import { companySizeSchema } from "./crm";

// ============================================================
// F3: importación estructurada de empresas (CSV/Excel, parseados en el
// navegador — ver F3_PROSPECTING_ENGINE_PLAN.md §4). El backend nunca
// recibe un archivo, solo el array ya parseado.
// ============================================================

export const importCompanyRowSchema = z.object({
  name: z.string().min(1),
  industryName: z.string().min(1), // se matchea contra Industry.name existente; sin match, la fila se rechaza
  city: z.string().optional(),
  state: z.string().optional(),
  website: z.string().optional(),
  estimatedSize: companySizeSchema.optional(),
  // Datos de contacto: opcionales, y solo se usan literalmente — nunca
  // inventados por IA (F3 §5, regla heredada de F2).
  contactFirstName: z.string().optional(),
  contactLastName: z.string().optional(),
  contactEmail: z.string().optional(),
  contactTitle: z.string().optional(),
});
export type ImportCompanyRow = z.infer<typeof importCompanyRowSchema>;

export const importCompaniesInputSchema = z.object({
  rows: z.array(importCompanyRowSchema).min(1).max(500),
});
export type ImportCompaniesInput = z.infer<typeof importCompaniesInputSchema>;

export const importCompaniesResultSchema = z.object({
  importedCount: z.number(),
  skipped: z.array(z.object({ row: z.number(), reason: z.string() })),
  companyIds: z.array(z.string()),
});
export type ImportCompaniesResult = z.infer<typeof importCompaniesResultSchema>;

// ============================================================
// F3: disparo manual del pipeline del Prospecting Agent para una
// empresa puntual ("Analizar ahora" en CompanyDetail).
// ============================================================

export const processCompanyPipelineInputSchema = z.object({
  companyId: z.string(),
});
export type ProcessCompanyPipelineInput = z.infer<typeof processCompanyPipelineInputSchema>;

// ============================================================
// F3: Dashboard Comercial IA
// ============================================================

export const aiDashboardSummarySchema = z.object({
  companiesAnalyzedToday: z.number(),
  newCompaniesToday: z.number(),
  leadsCreatedByAiToday: z.number(),
  averageScore: z.number().nullable(),
  costUsdThisMonth: z.number(),
  budgetUsd: z.number(),
  // Estimado, no revenue realizado — F3 §12, aprobado explícitamente así.
  roiEstimate: z.object({
    estimatedRevenueUsd: z.number(),
    costUsd: z.number(),
    ratio: z.number().nullable(),
  }),
  pendingProspects: z.number(),
  pendingApprovals: z.number(),
  companiesByIndustry: z.array(z.object({ industryName: z.string(), count: z.number() })),
  companiesByState: z.array(z.object({ state: z.string(), count: z.number() })),
});
export type AiDashboardSummary = z.infer<typeof aiDashboardSummarySchema>;
