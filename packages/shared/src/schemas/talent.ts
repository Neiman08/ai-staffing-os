import { z } from "zod";
import { paginationQuerySchema } from "./common";

// F5.2: enum real de la base (packages/db/prisma/schema.prisma) — no se
// amplía (decisión del PO 2026-07-14). INTERVIEW/OFFERED se representan
// dentro de QUALIFIED; WITHDRAWN/ARCHIVED dentro de INACTIVE; HIRED es
// PLACED. PLACED solo se asigna dentro de convert-to-worker, nunca vía
// PATCH /candidates/:id/status.
export const candidateStatusSchema = z.enum(["NEW", "SCREENING", "QUALIFIED", "PLACED", "REJECTED", "INACTIVE"]);
export type CandidateStatusValue = z.infer<typeof candidateStatusSchema>;

/**
 * F5.2: matriz de transiciones manuales aprobada por el PO. PLACED nunca es
 * destino de una transición manual — ocurre exclusivamente dentro de
 * convert-to-worker (ver convertCandidateToWorkerInputSchema más abajo).
 * REJECTED/INACTIVE pueden reabrirse a NEW (acción explícita, nunca directo
 * a QUALIFIED/PLACED) — el candidato reabierto vuelve a pasar por el
 * mismo embudo, sin atajos.
 */
export const CANDIDATE_STATUS_TRANSITIONS: Record<CandidateStatusValue, CandidateStatusValue[]> = {
  NEW: ["SCREENING", "REJECTED", "INACTIVE"],
  SCREENING: ["QUALIFIED", "REJECTED", "INACTIVE"],
  QUALIFIED: ["REJECTED", "INACTIVE"], // PLACED excluido a propósito: solo vía convert-to-worker
  PLACED: ["INACTIVE"],
  REJECTED: ["NEW"],
  INACTIVE: ["NEW"],
};

/** Idempotente: pedir el mismo estado ya vigente siempre es válido (no-op), nunca un error. */
export function isValidCandidateStatusTransition(from: CandidateStatusValue, to: CandidateStatusValue): boolean {
  if (from === to) return true;
  return CANDIDATE_STATUS_TRANSITIONS[from].includes(to);
}

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
  status: candidateStatusSchema,
  aiScore: z.number().nullable(),
  isWorker: z.boolean(),
  createdAt: z.string(),
});
export type CandidateListItem = z.infer<typeof candidateListItemSchema>;

// F5.2: se mantiene cursor/limit — misma convención ya usada por
// Companies/Contacts/Leads/JobOrders, no page/pageSize.
export const candidateQuerySchema = paginationQuerySchema.extend({
  search: z.string().optional(), // contains sobre firstName/lastName/email, insensible a mayúsculas
  status: candidateStatusSchema.optional(),
  categoryId: z.string().optional(),
  isWorker: z.coerce.boolean().optional(),
});
export type CandidateQuery = z.infer<typeof candidateQuerySchema>;

export const candidateDetailSchema = candidateListItemSchema.extend({
  categoryIds: z.array(z.string()),
  zip: z.string().nullable(),
  yearsExperience: z.number().nullable(),
  resumeUrl: z.string().nullable(),
  aiSummary: z.string().nullable(),
  source: z.string().nullable(),
  smsOptIn: z.boolean(),
  createdById: z.string().nullable(),
  createdByName: z.string().nullable(),
  workerId: z.string().nullable(),
  updatedAt: z.string(),
});
export type CandidateDetail = z.infer<typeof candidateDetailSchema>;

export const createCandidateInputSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  languages: z.array(z.string()).optional(),
  categoryIds: z.array(z.string()).optional(),
  yearsExperience: z.number().int().nonnegative().optional(),
  resumeUrl: z.string().optional(),
  source: z.string().optional(),
  smsOptIn: z.boolean().optional(),
  // Deliberadamente SIN: status (siempre NEW), createdById, tenantId,
  // aiSummary/aiScore (generados, nunca ingresados a mano) — ninguno se
  // acepta desde el body bajo ninguna forma.
});
export type CreateCandidateInput = z.infer<typeof createCandidateInputSchema>;

export const updateCandidateInputSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  languages: z.array(z.string()).optional(),
  categoryIds: z.array(z.string()).optional(),
  yearsExperience: z.number().int().nonnegative().optional(),
  resumeUrl: z.string().optional(),
  source: z.string().optional(),
  smsOptIn: z.boolean().optional(),
  // Deliberadamente SIN: status, createdById, tenantId, aiSummary/aiScore —
  // el estado se cambia únicamente vía PATCH /candidates/:id/status.
});
export type UpdateCandidateInput = z.infer<typeof updateCandidateInputSchema>;

export const updateCandidateStatusInputSchema = z.object({
  status: candidateStatusSchema,
});
export type UpdateCandidateStatusInput = z.infer<typeof updateCandidateStatusInputSchema>;

export const convertCandidateToWorkerInputSchema = z.object({
  employmentType: z.enum(["W2", "C1099"]),
  defaultPayRate: z.number().positive(),
});
export type ConvertCandidateToWorkerInput = z.infer<typeof convertCandidateToWorkerInputSchema>;

export const convertCandidateToWorkerResultSchema = z.object({
  worker: z.object({
    id: z.string(),
    candidateId: z.string(),
    employmentType: z.enum(["W2", "C1099"]),
    defaultPayRate: z.string(),
    status: z.string(),
    complianceStatus: z.string(),
    createdAt: z.string(),
  }),
  alreadyConverted: z.boolean(), // true cuando la conversión era idempotente (Worker ya existía)
});
export type ConvertCandidateToWorkerResult = z.infer<typeof convertCandidateToWorkerResultSchema>;

// F5.2: superficie mínima aprobada — solo lo necesario para verificar la
// conversión desde la UI. Listado completo/edición/filtros de Worker
// quedan para el bloque siguiente (ver F5_STAFFING_OPERATIONS_PLAN.md §5).
export const workerDetailSchema = z.object({
  id: z.string(),
  candidateId: z.string(),
  candidateName: z.string(),
  employmentType: z.enum(["W2", "C1099"]),
  defaultPayRate: z.string(),
  status: z.string(),
  complianceStatus: z.string(),
  hiredAt: z.string().nullable(),
  createdAt: z.string(),
});
export type WorkerDetail = z.infer<typeof workerDetailSchema>;

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
