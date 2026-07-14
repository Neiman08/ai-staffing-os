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

// F5.3: enum real (packages/db/prisma/schema.prisma EmploymentType) —
// factorizado acá porque F5.2 lo repetía inline en 3 lugares distintos
// (convertCandidateToWorkerInputSchema, su result, y workerDetailSchema).
export const workerEmploymentTypeSchema = z.enum(["W2", "C1099"]);
export type WorkerEmploymentTypeValue = z.infer<typeof workerEmploymentTypeSchema>;

export const convertCandidateToWorkerInputSchema = z.object({
  employmentType: workerEmploymentTypeSchema,
  defaultPayRate: z.number().positive(),
});
export type ConvertCandidateToWorkerInput = z.infer<typeof convertCandidateToWorkerInputSchema>;

export const convertCandidateToWorkerResultSchema = z.object({
  worker: z.object({
    id: z.string(),
    candidateId: z.string(),
    employmentType: workerEmploymentTypeSchema,
    defaultPayRate: z.string(),
    status: z.string(),
    complianceStatus: z.string(),
    createdAt: z.string(),
  }),
  alreadyConverted: z.boolean(), // true cuando la conversión era idempotente (Worker ya existía)
});
export type ConvertCandidateToWorkerResult = z.infer<typeof convertCandidateToWorkerResultSchema>;

// F5.3: enum real (packages/db/prisma/schema.prisma WorkerStatus) — no se
// amplía. ASSIGNED nunca es un destino de transición manual (mismo criterio
// ya aplicado a JobOrder.PARTIALLY_FILLED/FILLED en F5.1): en el schema
// actual ya hay Workers seedeados en ASSIGNED desde F0 porque hay
// Assignments de seed reales, pero mientras el módulo de Assignments no
// exista (fuera de alcance de F5.3), nadie debe poder ENTRAR a ASSIGNED a
// mano — solo salir de él hacia ON_LEAVE/TERMINATED. TERMINATED es
// terminal en esta fase: no se pidió reapertura, así que no se inventa una.
export const workerStatusSchema = z.enum(["AVAILABLE", "ASSIGNED", "ON_LEAVE", "TERMINATED"]);
export type WorkerStatusValue = z.infer<typeof workerStatusSchema>;

export const WORKER_STATUS_TRANSITIONS: Record<WorkerStatusValue, WorkerStatusValue[]> = {
  AVAILABLE: ["ON_LEAVE", "TERMINATED"],
  ASSIGNED: ["ON_LEAVE", "TERMINATED"], // nunca se entra acá a mano, pero sí se puede salir
  ON_LEAVE: ["AVAILABLE", "TERMINATED"],
  TERMINATED: [],
};

/** Idempotente: pedir el mismo estado ya vigente siempre es válido (no-op), nunca un error. */
export function isValidWorkerStatusTransition(from: WorkerStatusValue, to: WorkerStatusValue): boolean {
  if (from === to) return true;
  return WORKER_STATUS_TRANSITIONS[from].includes(to);
}

// F5.2 §8 (aprobado): un documento nunca se mueve/duplica en la conversión
// — el detalle de Worker muestra los documentos propios del Worker Y los
// del Candidate de origen (vía la relación 1:1), identificando de dónde
// viene cada uno con `source`, sin alterar su dueño real en la DB.
export const workerDocumentSchema = z.object({
  id: z.string(),
  documentTypeName: z.string(),
  status: z.string(),
  expirationDate: z.string().nullable(),
  source: z.enum(["worker", "candidate"]),
});
export type WorkerDocument = z.infer<typeof workerDocumentSchema>;

// F5.3: CRUD completo aprobado. Worker nunca duplica datos de Candidate —
// city/state/languages/categoryNames se leen por la relación 1:1, igual
// que F5.2 ya decidió para nombre/contacto/categorías.
export const workerListItemSchema = z.object({
  id: z.string(),
  candidateId: z.string(),
  candidateName: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  categoryNames: z.array(z.string()),
  employmentType: workerEmploymentTypeSchema,
  defaultPayRate: z.string(),
  status: workerStatusSchema,
  complianceStatus: z.string(),
  hiredAt: z.string().nullable(),
  createdAt: z.string(),
});
export type WorkerListItem = z.infer<typeof workerListItemSchema>;

export const workerQuerySchema = paginationQuerySchema.extend({
  search: z.string().optional(), // contains sobre candidate.firstName/lastName, insensible a mayúsculas
  status: workerStatusSchema.optional(),
  employmentType: workerEmploymentTypeSchema.optional(),
  complianceStatus: z.enum(["COMPLIANT", "PENDING", "BLOCKED"]).optional(),
  categoryId: z.string().optional(), // filtra por candidate.categories
  state: z.string().optional(), // filtra por candidate.state (no confundir con el status del Worker)
  city: z.string().optional(),
  sortBy: z.enum(["createdAt", "hiredAt", "defaultPayRate"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});
export type WorkerQuery = z.infer<typeof workerQuerySchema>;

// F5.2 original + F5.3: se mantienen los campos ya consumidos por
// WorkerDetail.tsx desde F5.2 (nunca se quitan ni se renombran — solo se
// agregan), más los datos de contacto/ubicación/idiomas/categorías del
// Candidate de origen y `updatedAt` (columna real, nunca expuesta antes).
export const workerDetailSchema = workerListItemSchema.extend({
  email: z.string().nullable(),
  phone: z.string().nullable(),
  languages: z.array(z.string()),
  documents: z.array(workerDocumentSchema),
  updatedAt: z.string(),
});
export type WorkerDetail = z.infer<typeof workerDetailSchema>;

// F5.3: candidateId es obligatorio (Worker.candidateId es una FK única y
// NO nullable en el schema — un Worker no puede existir sin un Candidate).
// Esto significa que "crear un Worker manualmente" es, en la práctica, la
// misma operación que convertCandidateToWorker (F5.2): seleccionar un
// Candidate QUALIFIED sin Worker todavía y proveer employmentType/
// defaultPayRate. Ver apps/api/src/modules/talent/service.ts
// (createWorkerFromQualifiedCandidate) — se reutiliza la misma regla de
// negocio y la misma transacción, nunca se duplica ni se diverge.
export const createWorkerInputSchema = z.object({
  candidateId: z.string().min(1),
  employmentType: workerEmploymentTypeSchema,
  defaultPayRate: z.number().positive(),
  hiredAt: z.string().optional(),
  // Deliberadamente SIN: status (siempre AVAILABLE), complianceStatus
  // (siempre PENDING — es dominio de Compliance, fuera de alcance de
  // F5.3), tenantId — ninguno se acepta desde el body.
});
export type CreateWorkerInput = z.infer<typeof createWorkerInputSchema>;

// F5.3: complianceStatus deliberadamente ausente — pertenece al dominio de
// Compliance (permisos compliance.verify/compliance.block ya reservados
// para eso desde F0), no al CRUD de Workers. status tampoco aparece acá —
// se cambia únicamente vía PATCH /workers/:id/status.
export const updateWorkerInputSchema = z.object({
  employmentType: workerEmploymentTypeSchema.optional(),
  defaultPayRate: z.number().positive().optional(),
  hiredAt: z.string().optional(),
});
export type UpdateWorkerInput = z.infer<typeof updateWorkerInputSchema>;

export const updateWorkerStatusInputSchema = z.object({
  status: workerStatusSchema,
});
export type UpdateWorkerStatusInput = z.infer<typeof updateWorkerStatusInputSchema>;

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
