import type {
  CandidateDetail,
  CandidateListItem,
  CandidateQuery,
  ConvertCandidateToWorkerInput,
  ConvertCandidateToWorkerResult,
  CreateCandidateInput,
  IndustryListItem,
  JobCategoryListItem,
  Paginated,
  UpdateCandidateInput,
  UpdateCandidateStatusInput,
} from "@ai-staffing-os/shared";
import { CANDIDATE_STATUS_TRANSITIONS, isValidCandidateStatusTransition } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";
import { evaluateCandidateQualification, type QualificationEvaluationResult } from "../recruiting-intelligence/qualification-rules";
import { deriveQualificationStatus, type PersistedQualificationStatus } from "../recruiting-intelligence/qualification-status";
import { sourceCandidatesForJob, type CandidateSourcingResult } from "../recruiting-intelligence/candidate-sourcing";
import {
  computeCandidateMatching,
  type CandidateForMatching,
  type CandidateMatchResult,
  type MatchConfidence,
} from "../recruiting-intelligence/candidate-matching";
import {
  normalizeCandidateEmail as normalizeEmail,
  normalizeCandidatePhone as normalizePhone,
  buildCandidateIdentityKeys,
} from "../recruiting-intelligence/candidate-identity";
import {
  buildShortlistEntries,
  isValidShortlistTransition,
  type ShortlistReviewStatus,
} from "../recruiting-intelligence/candidate-shortlist";
import { buildScreeningPlan } from "../recruiting-intelligence/screening-plan";
import {
  buildInterviewPreview,
  isValidInterviewPreviewTransition,
  type InterviewPreviewInput,
  type InterviewPreviewStatus,
  type InterviewModality,
  type ProposedWindow,
  type InterviewParticipant,
} from "../recruiting-intelligence/interview-preview";
import { computePlacementReadiness, type PlacementReadinessStatus } from "../recruiting-intelligence/placement-readiness";

// ================= Candidates =================

export interface CandidateQualificationRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  status: PersistedQualificationStatus;
  reasons: string[];
  hardDisqualifiers: string[];
  rulesVersion: number;
  evaluatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * F5.2 (aprobado), reforzado en F8.4: dedup a nivel de servicio, dentro del
 * tenant únicamente (scopedDb ya lo garantiza). No hay constraint único en
 * DB sobre email/phone — dos creaciones concurrentes del mismo candidato
 * podrían ambas pasar esta verificación antes de que la primera termine de
 * escribir (race condition real, documentada, no resuelta acá por
 * instrucción explícita del PO: "no agregues un índice único todavía sin
 * proponerlo aparte").
 *
 * F8.4 añade un tercer criterio (normalizedNameState, vía
 * `recruiting-intelligence/candidate-identity.ts`) para atrapar duplicados
 * sin email/phone en común pero con nombre+apellido+estado idénticos — la
 * normalización en sí se movió a ese módulo puro (antes vivía inline acá)
 * para poder testearla de forma aislada y compartirla con futuras
 * utilidades de import/sourcing masivo.
 */
async function findDuplicateCandidate(input: {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  state?: string;
}): Promise<{ id: string } | null> {
  if (input.email) {
    const byEmail = await scopedDb.candidate.findFirst({
      where: { email: { equals: normalizeEmail(input.email), mode: "insensitive" } },
      select: { id: true },
    });
    if (byEmail) return byEmail;
  }

  if (input.phone) {
    const normalizedPhone = normalizePhone(input.phone);
    const withPhone = await scopedDb.candidate.findMany({
      where: { phone: { not: null } },
      select: { id: true, phone: true },
    });
    const match = withPhone.find((c) => c.phone && normalizePhone(c.phone) === normalizedPhone);
    if (match) return { id: match.id };
  }

  const identity = buildCandidateIdentityKeys(input);
  if (identity.normalizedNameState) {
    const candidatesWithState = await scopedDb.candidate.findMany({
      where: { state: { not: null } },
      select: { id: true, firstName: true, lastName: true, state: true },
    });
    const match = candidatesWithState.find(
      (c) => buildCandidateIdentityKeys(c).normalizedNameState === identity.normalizedNameState,
    );
    if (match) return { id: match.id };
  }

  return null;
}

async function assertValidCategoryIds(categoryIds: string[] | undefined): Promise<void> {
  if (!categoryIds || categoryIds.length === 0) return;
  const unique = Array.from(new Set(categoryIds));
  const found = await scopedDb.jobCategory.findMany({ where: { id: { in: unique } } });
  if (found.length !== unique.length) {
    const foundIds = new Set(found.map((c) => c.id));
    const invalid = unique.filter((id) => !foundIds.has(id));
    throw AppError.badRequest(`Unknown job category id(s): ${invalid.join(", ")}`, { invalid });
  }
}

function toListItem(candidate: {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  languages: string[];
  categories: { name: string }[];
  status: string;
  aiScore: number | null;
  worker: { id: string } | null;
  createdAt: Date;
}): CandidateListItem {
  return {
    id: candidate.id,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    email: candidate.email,
    phone: candidate.phone,
    city: candidate.city,
    state: candidate.state,
    languages: candidate.languages,
    categoryNames: candidate.categories.map((c) => c.name),
    status: candidate.status as never,
    aiScore: candidate.aiScore,
    isWorker: !!candidate.worker,
    createdAt: candidate.createdAt.toISOString(),
  };
}

export async function listCandidates(query: CandidateQuery): Promise<Paginated<CandidateListItem>> {
  const rows = await scopedDb.candidate.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit: query.limit ?? 20 }),
    where: {
      OR: query.search
        ? [
            { firstName: { contains: query.search, mode: "insensitive" } },
            { lastName: { contains: query.search, mode: "insensitive" } },
            { email: { contains: query.search, mode: "insensitive" } },
          ]
        : undefined,
      status: query.status,
      categories: query.categoryId ? { some: { id: query.categoryId } } : undefined,
      worker: query.isWorker === undefined ? undefined : query.isWorker ? { isNot: null } : { is: null },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { categories: true, worker: { select: { id: true } } },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit ?? 20);
  return { items: items.map(toListItem), nextCursor };
}

export async function getCandidateDetail(id: string): Promise<CandidateDetail> {
  const candidate = await scopedDb.candidate.findUnique({
    where: { id },
    include: { categories: true, worker: { select: { id: true } } },
  });
  if (!candidate) throw AppError.notFound("Candidate not found");

  const createdBy = candidate.createdById
    ? await scopedDb.user.findUnique({ where: { id: candidate.createdById } })
    : null;

  return {
    ...toListItem(candidate),
    categoryIds: candidate.categories.map((c) => c.id),
    zip: candidate.zip,
    yearsExperience: candidate.yearsExperience,
    resumeUrl: candidate.resumeUrl,
    aiSummary: candidate.aiSummary,
    source: candidate.source,
    smsOptIn: candidate.smsOptIn,
    createdById: candidate.createdById,
    createdByName: createdBy ? `${createdBy.firstName} ${createdBy.lastName}` : null,
    workerId: candidate.worker?.id ?? null,
    updatedAt: candidate.updatedAt.toISOString(),
  };
}

export async function createCandidate(input: CreateCandidateInput): Promise<CandidateListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const duplicate = await findDuplicateCandidate({
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    state: input.state,
  });
  if (duplicate) {
    throw AppError.conflict("A candidate with this email, phone, or name and state already exists in this tenant", {
      existingCandidateId: duplicate.id,
    });
  }

  await assertValidCategoryIds(input.categoryIds);

  const candidate = await scopedDb.candidate.create({
    data: {
      // F5.2: la extensión de tenancy inyecta tenantId en runtime
      // (STRICT_TENANT_MODELS) — el tipo generado por Prisma no lo
      // refleja, así que hay que pasarlo a mano para que compile (mismo
      // patrón ya documentado en JobOrder.create, F5.1).
      tenantId: ctx.tenantId,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email ? normalizeEmail(input.email) : undefined,
      phone: input.phone,
      city: input.city,
      state: input.state,
      zip: input.zip,
      languages: input.languages ?? [],
      categories: input.categoryIds ? { connect: input.categoryIds.map((id) => ({ id })) } : undefined,
      yearsExperience: input.yearsExperience,
      resumeUrl: input.resumeUrl,
      source: input.source,
      smsOptIn: input.smsOptIn ?? false,
      // F5.2: SIEMPRE NEW al crear — el input no declara `status`.
      status: "NEW",
      // F5.2: del contexto de tenancy (usuario autenticado/dev-bypass
      // validado), nunca del body — createCandidateInputSchema ni
      // siquiera declara este campo.
      createdById: ctx.userId,
    },
    include: { categories: true, worker: { select: { id: true } } },
  });

  await logActivity({
    entityType: "candidate",
    entityId: candidate.id,
    type: "SYSTEM",
    subject: `Candidate created: ${candidate.firstName} ${candidate.lastName}`,
  });
  await logAuditEvent({
    action: "candidate.created",
    entityType: "candidate",
    entityId: candidate.id,
    after: { status: candidate.status },
  });

  return toListItem(candidate);
}

export async function updateCandidate(id: string, input: UpdateCandidateInput): Promise<CandidateListItem> {
  // Verify-then-act: scopedDb.candidate.findUnique ya está tenant-scoped
  // (STRICT_TENANT_MODELS) — si el registro es de otro tenant, esto
  // devuelve null antes de tocar nada.
  const existing = await scopedDb.candidate.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Candidate not found");

  await assertValidCategoryIds(input.categoryIds);

  const updated = await scopedDb.candidate.update({
    where: { id },
    data: {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email ? normalizeEmail(input.email) : undefined,
      phone: input.phone,
      city: input.city,
      state: input.state,
      zip: input.zip,
      languages: input.languages,
      categories: input.categoryIds ? { set: input.categoryIds.map((catId) => ({ id: catId })) } : undefined,
      yearsExperience: input.yearsExperience,
      resumeUrl: input.resumeUrl,
      source: input.source,
      smsOptIn: input.smsOptIn,
      // F5.2: status/createdById/tenantId/aiSummary/aiScore nunca
      // aparecen acá — updateCandidateInputSchema no los declara.
    },
    include: { categories: true, worker: { select: { id: true } } },
  });

  await logActivity({
    entityType: "candidate",
    entityId: id,
    type: "SYSTEM",
    subject: "Candidate updated",
  });
  await logAuditEvent({
    action: "candidate.updated",
    entityType: "candidate",
    entityId: id,
    before: { firstName: existing.firstName, lastName: existing.lastName, email: existing.email },
    after: { firstName: updated.firstName, lastName: updated.lastName, email: updated.email },
  });

  return toListItem(updated);
}

export async function updateCandidateStatus(
  id: string,
  input: UpdateCandidateStatusInput,
): Promise<CandidateListItem> {
  const existing = await scopedDb.candidate.findUnique({
    where: { id },
    include: { categories: true, worker: { select: { id: true } } },
  });
  if (!existing) throw AppError.notFound("Candidate not found");

  const from = existing.status as never;
  const to = input.status;

  // F5.2: idempotente — pedir el estado ya vigente es un no-op exitoso,
  // nunca un error ni una segunda entrada de Activity/AuditLog.
  if (from === to) {
    return toListItem(existing);
  }

  // F5.2: PLACED nunca es un destino válido de este endpoint — la matriz
  // aprobada no lo lista como alcanzable desde ningún estado salvo el
  // idempotente (from === to, ya cubierto arriba). Ocurre exclusivamente
  // dentro de convertCandidateToWorker.
  if (!isValidCandidateStatusTransition(from, to)) {
    throw AppError.badRequest(`Cannot transition Candidate from ${existing.status} to ${to}`, {
      from: existing.status,
      to,
      allowedFromCurrentStatus: CANDIDATE_STATUS_TRANSITIONS[from],
    });
  }

  const updated = await scopedDb.candidate.update({
    where: { id },
    data: { status: to },
    include: { categories: true, worker: { select: { id: true } } },
  });

  // F5.2 (aprobado): la reapertura de REJECTED/INACTIVE a NEW debe quedar
  // claramente visible como tal, no como un cambio de estado genérico.
  const isReopen = (from === "REJECTED" || from === "INACTIVE") && to === "NEW";
  const subject = isReopen
    ? `Candidate reabierto: ${existing.status} → ${to}`
    : `Status changed: ${existing.status} → ${to}`;

  await logActivity({
    entityType: "candidate",
    entityId: id,
    type: "SYSTEM",
    subject,
  });
  await logAuditEvent({
    action: isReopen ? "candidate.reopened" : "candidate.status_changed",
    entityType: "candidate",
    entityId: id,
    before: { status: existing.status },
    after: { status: to },
  });

  return toListItem(updated);
}

/**
 * F5.3: extraído de convertCandidateToWorker (F5.2) sin cambiar su
 * comportamiento — Worker.candidateId es una FK única y NO nullable
 * (schema.prisma), así que "crear un Worker" siempre significa esto:
 * un Candidate QUALIFIED sin Worker todavía, más employmentType/
 * defaultPayRate provistos por un humano. `POST /workers` (F5.3,
 * workers/service.ts) reutiliza exactamente esta función — nunca
 * reimplementa la regla de negocio ni la transacción por su cuenta,
 * para que no puedan existir dos caminos de creación con reglas
 * divergentes. Los callers son responsables de la idempotencia (si el
 * Candidate ya tiene Worker) y del logging de Activity/AuditLog, cada
 * uno con la semántica que le corresponde a su propio endpoint.
 */
export async function createWorkerFromQualifiedCandidate(
  candidate: { id: string; status: string },
  input: ConvertCandidateToWorkerInput,
) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  if (candidate.status !== "QUALIFIED") {
    throw AppError.badRequest("Candidate must be QUALIFIED to convert to Worker", {
      status: candidate.status,
    });
  }

  return scopedDb.$transaction(async (tx) => {
    const createdWorker = await tx.worker.create({
      data: {
        tenantId: ctx.tenantId,
        candidateId: candidate.id,
        employmentType: input.employmentType,
        defaultPayRate: input.defaultPayRate,
        status: "AVAILABLE",
        complianceStatus: "PENDING",
      },
    });

    // F5.2 (aprobado): única transición manual que lleva a PLACED —
    // ocurre exclusivamente acá, en la misma transacción que crea el
    // Worker. No se copian nombre/email/teléfono/ubicación/categorías —
    // siguen viviendo en Candidate, se consultan por la relación 1:1.
    await tx.candidate.update({ where: { id: candidate.id }, data: { status: "PLACED" } });

    return createdWorker;
  });
}

export async function convertCandidateToWorker(
  id: string,
  input: ConvertCandidateToWorkerInput,
): Promise<ConvertCandidateToWorkerResult> {
  const existing = await scopedDb.candidate.findUnique({
    where: { id },
    include: { worker: true },
  });
  if (!existing) throw AppError.notFound("Candidate not found");

  // F5.2 (aprobado): idempotente — si ya existe un Worker para este
  // Candidate, nunca se crea un segundo. Se registra el intento repetido
  // (Activity + AuditLog) y se devuelve el Worker ya existente.
  if (existing.worker) {
    await logActivity({
      entityType: "candidate",
      entityId: id,
      type: "SYSTEM",
      subject: "Conversion to Worker attempted again — already converted",
    });
    await logAuditEvent({
      action: "candidate.convert_to_worker_duplicate_attempt",
      entityType: "candidate",
      entityId: id,
      after: { existingWorkerId: existing.worker.id },
    });

    return {
      worker: {
        id: existing.worker.id,
        candidateId: existing.worker.candidateId,
        employmentType: existing.worker.employmentType,
        defaultPayRate: existing.worker.defaultPayRate.toString(),
        status: existing.worker.status,
        complianceStatus: existing.worker.complianceStatus,
        createdAt: existing.worker.createdAt.toISOString(),
      },
      alreadyConverted: true,
    };
  }

  const worker = await createWorkerFromQualifiedCandidate(existing, input);

  await logActivity({
    entityType: "candidate",
    entityId: id,
    type: "SYSTEM",
    subject: "Candidate converted to Worker",
  });
  await logAuditEvent({
    action: "candidate.converted_to_worker",
    entityType: "candidate",
    entityId: id,
    // F5.2 (aprobado): "no registrar PII completa en metadata" — solo
    // estados y el workerId nuevo, nunca nombre/email/teléfono.
    before: { status: "QUALIFIED" },
    after: { status: "PLACED", workerId: worker.id },
  });

  return {
    worker: {
      id: worker.id,
      candidateId: worker.candidateId,
      employmentType: worker.employmentType,
      defaultPayRate: worker.defaultPayRate.toString(),
      status: worker.status,
      complianceStatus: worker.complianceStatus,
      createdAt: worker.createdAt.toISOString(),
    },
    alreadyConverted: false,
  };
}

// ================= Reference catalogs (F0/F5.1) =================

export async function listIndustries(): Promise<IndustryListItem[]> {
  const industries = await scopedDb.industry.findMany({ orderBy: { name: "asc" } });
  return industries.map((industry) => ({
    id: industry.id,
    name: industry.name,
    isGlobal: industry.isGlobal,
  }));
}

export async function listJobCategories(): Promise<JobCategoryListItem[]> {
  const categories = await scopedDb.jobCategory.findMany({
    include: { industry: true },
    orderBy: { name: "asc" },
  });
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    industryName: category.industry?.name ?? null,
    requiredCertifications: (category.requiredCertifications as string[]) ?? [],
  }));
}

/**
 * F8.2: Job Requirements and Qualification Rules -- wiring impuro entre
 * `recruiting-intelligence/qualification-rules.ts` (puro) y los datos
 * reales de Candidate/JobOrder. Solo EVALÚA -- nunca cambia
 * Candidate.status ni crea ningún registro (la persistencia del estado
 * de 4 valores QUALIFIED/POSSIBLY_QUALIFIED/NEEDS_REVIEW/NOT_QUALIFIED
 * es F8.5, deliberadamente no implementada acá).
 *
 * Limitación conocida y documentada: `JobOrder` todavía no tiene
 * columnas para experiencia mínima/idiomas requeridos (F8.1 los
 * extrae de la instrucción de intake, pero no se persisten en el
 * schema todavía) -- se evalúan como `null`/`[]` (sin requisito) hasta
 * que exista esa columna, nunca se inventa un valor.
 */
async function runQualificationEvaluation(candidateId: string, jobOrderId: string): Promise<QualificationEvaluationResult> {
  const [candidate, jobOrder] = await Promise.all([
    scopedDb.candidate.findUnique({ where: { id: candidateId }, include: { categories: true, documents: { include: { documentType: true } } } }),
    scopedDb.jobOrder.findUnique({ where: { id: jobOrderId } }),
  ]);
  if (!candidate) throw AppError.notFound("Candidate not found");
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  return evaluateCandidateQualification({
    candidate: {
      candidateId: candidate.id,
      status: candidate.status,
      categoryIds: candidate.categories.map((c) => c.id),
      yearsExperience: candidate.yearsExperience,
      languages: candidate.languages,
      documents: candidate.documents.map((d) => ({
        documentTypeKey: d.documentType.key,
        status: d.status,
        expirationDate: d.expirationDate,
      })),
    },
    job: {
      categoryId: jobOrder.categoryId,
      requiredDocumentTypeKeys: (jobOrder.requirements as string[] | null) ?? [],
      minYearsExperience: null,
      requiredLanguages: [],
    },
  });
}

export async function evaluateCandidateQualificationForJobOrder(
  candidateId: string,
  jobOrderId: string,
): Promise<QualificationEvaluationResult> {
  return runQualificationEvaluation(candidateId, jobOrderId);
}

/**
 * F8.5: Estados de calificación con razones auditables -- wiring impuro
 * entre `recruiting-intelligence/qualification-status.ts` (puro) y la
 * nueva tabla `CandidateQualification`. A diferencia de F8.2 (que solo
 * evalúa), esta función SÍ persiste: hace upsert de un registro por par
 * (candidateId, jobOrderId) con el estado de 4 valores derivado y sus
 * razones auditables. Nunca cambia `Candidate.status` -- son conceptos
 * distintos (ver comentario del enum `QualificationStatus` en el
 * schema): esto es el estado de calificación PARA UN JOB ORDER
 * específico, no el ciclo de vida general del candidato.
 */
export async function persistCandidateQualification(
  candidateId: string,
  jobOrderId: string,
): Promise<CandidateQualificationRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const evaluation = await runQualificationEvaluation(candidateId, jobOrderId);
  const derived = deriveQualificationStatus(evaluation);

  // F8.5: mismo constraint único ya declarado en el schema
  // (@@unique([candidateId, jobOrderId])) -- se busca con un findFirst
  // (WhereInput admite candidateId/jobOrderId como campos planos; el
  // nombre compuesto candidateId_jobOrderId solo existe para
  // WhereUniqueInput, que scopedDb.findUnique/upsert ya redirige a
  // findFirst tenant-scoped y no lo reconocería -- mismo criterio que
  // TimeEntry en payroll/service.ts, F5.6) y luego se hace update/create
  // por `id`, que sí es un campo simple soportado.
  const existing = await scopedDb.candidateQualification.findFirst({ where: { candidateId, jobOrderId } });

  const data = {
    status: derived.status,
    reasons: derived.reasons,
    hardDisqualifiers: derived.hardDisqualifiers,
    rulesVersion: derived.rulesVersion,
    evaluatedById: ctx.userId,
  };

  const record = existing
    ? await scopedDb.candidateQualification.update({ where: { id: existing.id }, data })
    : await scopedDb.candidateQualification.create({
        data: { tenantId: ctx.tenantId, candidateId, jobOrderId, ...data },
      });

  await logAuditEvent({
    action: "candidate.qualification_evaluated",
    entityType: "candidate_qualification",
    entityId: record.id,
    after: { candidateId, jobOrderId, status: record.status },
  });

  return {
    id: record.id,
    candidateId: record.candidateId,
    jobOrderId: record.jobOrderId,
    status: record.status,
    reasons: record.reasons,
    hardDisqualifiers: record.hardDisqualifiers,
    rulesVersion: record.rulesVersion,
    evaluatedById: record.evaluatedById,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function getCandidateQualification(
  candidateId: string,
  jobOrderId: string,
): Promise<CandidateQualificationRecord | null> {
  const record = await scopedDb.candidateQualification.findFirst({ where: { candidateId, jobOrderId } });
  if (!record) return null;

  return {
    id: record.id,
    candidateId: record.candidateId,
    jobOrderId: record.jobOrderId,
    status: record.status,
    reasons: record.reasons,
    hardDisqualifiers: record.hardDisqualifiers,
    rulesVersion: record.rulesVersion,
    evaluatedById: record.evaluatedById,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export interface CandidateMatchRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  qualificationStatus: PersistedQualificationStatus;
  recommendable: boolean;
  needsReview: boolean;
  hardConstraints: string[];
  softPreferences: unknown;
  score: number;
  normalizedScore: number;
  rank: number | null;
  explanation: string;
  confidence: MatchConfidence;
  missingData: string[];
  risks: string[];
  evidence: string[];
  rulesVersion: number;
  calculatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateMatchingApiResult {
  jobOrderId: string;
  ranked: CandidateMatchRecord[];
  excluded: CandidateMatchRecord[];
  rulesVersion: number;
  calculatedAt: string;
}

function toCandidateMatchRecord(record: {
  id: string;
  candidateId: string;
  jobOrderId: string;
  qualificationStatus: string;
  recommendable: boolean;
  needsReview: boolean;
  hardConstraints: string[];
  softPreferences: unknown;
  score: number;
  normalizedScore: number;
  rank: number | null;
  explanation: string;
  confidence: string;
  missingData: string[];
  risks: string[];
  evidence: string[];
  rulesVersion: number;
  calculatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): CandidateMatchRecord {
  return {
    id: record.id,
    candidateId: record.candidateId,
    jobOrderId: record.jobOrderId,
    qualificationStatus: record.qualificationStatus as PersistedQualificationStatus,
    recommendable: record.recommendable,
    needsReview: record.needsReview,
    hardConstraints: record.hardConstraints,
    softPreferences: record.softPreferences,
    score: record.score,
    normalizedScore: record.normalizedScore,
    rank: record.rank,
    explanation: record.explanation,
    confidence: record.confidence as MatchConfidence,
    missingData: record.missingData,
    risks: record.risks,
    evidence: record.evidence,
    rulesVersion: record.rulesVersion,
    calculatedAt: record.calculatedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * F8.6: Matching and Ranking -- wiring impuro entre
 * `recruiting-intelligence/candidate-matching.ts` (puro) y los datos
 * reales del tenant. Reutiliza DIRECTAMENTE `runQualificationEvaluation`
 * (F8.2/F8.5, sin duplicar su lógica) para cada candidato de la misma
 * categoría del Job Order -- mismo filtro de categoría que F8.3
 * (candidate-sourcing) para no evaluar el pool completo del tenant.
 *
 * Limitación conocida y documentada: `runQualificationEvaluation` vuelve
 * a leer el JobOrder desde la DB en cada llamada (una por candidato) --
 * redundante pero deliberado: reutilizar la función tal cual (en vez de
 * duplicar su lógica de evaluación acá) es más seguro que optimizar
 * prematuramente, dado el volumen bajo de candidatos por categoría en
 * este CRM.
 *
 * Persiste un `CandidateMatch` por par (candidateId, jobOrderId) --
 * mismo patrón de upsert-vía-findFirst que `persistCandidateQualification`
 * (F8.5), por el mismo límite de la extensión de tenancy con claves
 * únicas compuestas. Nunca cambia `Candidate.status`.
 */
export async function computeAndPersistCandidateMatching(jobOrderId: string): Promise<CandidateMatchingApiResult> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const candidates = await scopedDb.candidate.findMany({
    where: { categories: { some: { id: jobOrder.categoryId } } },
  });

  const requiredDocumentCount = Array.isArray(jobOrder.requirements) ? jobOrder.requirements.length : 0;
  const jobLocation = jobOrder.location as { state?: string | null } | null;

  const forMatching: CandidateForMatching[] = [];
  for (const candidate of candidates) {
    const evaluation = await runQualificationEvaluation(candidate.id, jobOrderId);
    const derived = deriveQualificationStatus(evaluation);
    forMatching.push({
      candidateId: candidate.id,
      qualification: evaluation,
      qualificationStatus: derived.status,
      yearsExperience: candidate.yearsExperience,
      state: candidate.state,
      languages: candidate.languages,
      candidateUpdatedAt: candidate.updatedAt,
    });
  }

  const matching = computeCandidateMatching(forMatching, {
    jobOrderId,
    state: jobLocation?.state ?? null,
    requiredDocumentCount,
  });

  const allResults: CandidateMatchResult[] = [...matching.ranked, ...matching.excluded];
  const records: CandidateMatchRecord[] = [];
  for (const r of allResults) {
    const existing = await scopedDb.candidateMatch.findFirst({ where: { candidateId: r.candidateId, jobOrderId } });
    const data = {
      qualificationStatus: r.qualificationStatus,
      recommendable: r.recommendable,
      needsReview: r.needsReview,
      hardConstraints: r.hardConstraints,
      softPreferences: r.softPreferences as never,
      score: r.score,
      normalizedScore: r.normalizedScore,
      rank: r.rank,
      explanation: r.explanation,
      confidence: r.confidence,
      missingData: r.missingData,
      risks: r.risks,
      evidence: r.evidence,
      rulesVersion: r.rulesVersion,
      calculatedAt: new Date(r.calculatedAt),
    };
    const record = existing
      ? await scopedDb.candidateMatch.update({ where: { id: existing.id }, data })
      : await scopedDb.candidateMatch.create({ data: { tenantId: ctx.tenantId, candidateId: r.candidateId, jobOrderId, ...data } });
    records.push(toCandidateMatchRecord(record));
  }

  await logAuditEvent({
    action: "candidate.matching_computed",
    entityType: "job_order_matching",
    entityId: jobOrderId,
    after: {
      jobOrderId,
      rankedCount: matching.ranked.length,
      excludedCount: matching.excluded.length,
      rulesVersion: matching.rulesVersion,
    },
  });

  return {
    jobOrderId,
    ranked: records.filter((r) => r.rank !== null).sort((a, b) => a.rank! - b.rank!),
    excluded: records.filter((r) => r.rank === null),
    rulesVersion: matching.rulesVersion,
    calculatedAt: matching.calculatedAt,
  };
}

/**
 * Lee el matching YA persistido para un Job Order -- nunca recalcula.
 * 404 si nunca se corrió `computeAndPersistCandidateMatching`.
 */
export async function getPersistedCandidateMatching(jobOrderId: string): Promise<CandidateMatchingApiResult> {
  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId }, select: { id: true } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const records = await scopedDb.candidateMatch.findMany({ where: { jobOrderId } });
  if (records.length === 0) throw AppError.notFound("No matching run found for this Job Order");

  const mapped = records.map(toCandidateMatchRecord);
  const ranked = mapped.filter((r) => r.rank !== null).sort((a, b) => a.rank! - b.rank!);
  const excluded = mapped.filter((r) => r.rank === null);
  const rulesVersion = mapped[0]?.rulesVersion ?? 0;
  const calculatedAt = mapped.reduce((latest, r) => (r.calculatedAt > latest ? r.calculatedAt : latest), mapped[0]!.calculatedAt);

  return { jobOrderId, ranked, excluded, rulesVersion, calculatedAt };
}

export interface ShortlistEntryRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  rank: number;
  score: number;
  normalizedScore: number;
  qualificationStatus: PersistedQualificationStatus;
  confidence: MatchConfidence;
  reasons: string[];
  gaps: string[];
  risks: string[];
  reviewStatus: ShortlistReviewStatus;
  addedById: string | null;
  addedAt: string;
  updatedAt: string;
}

function toShortlistEntryRecord(record: {
  id: string;
  candidateId: string;
  jobOrderId: string;
  rank: number;
  score: number;
  normalizedScore: number;
  qualificationStatus: string;
  confidence: string;
  reasons: string[];
  gaps: string[];
  risks: string[];
  reviewStatus: string;
  addedById: string | null;
  addedAt: Date;
  updatedAt: Date;
}): ShortlistEntryRecord {
  return {
    id: record.id,
    candidateId: record.candidateId,
    jobOrderId: record.jobOrderId,
    rank: record.rank,
    score: record.score,
    normalizedScore: record.normalizedScore,
    qualificationStatus: record.qualificationStatus as PersistedQualificationStatus,
    confidence: record.confidence as MatchConfidence,
    reasons: record.reasons,
    gaps: record.gaps,
    risks: record.risks,
    reviewStatus: record.reviewStatus as ShortlistReviewStatus,
    addedById: record.addedById,
    addedAt: record.addedAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * F8.7: Candidate Shortlist -- wiring impuro entre
 * `recruiting-intelligence/candidate-shortlist.ts` (puro) y el ranking
 * YA persistido por F8.6 (nunca recalcula matching acá -- si no hay una
 * corrida de matching, `getPersistedCandidateMatching` ya lanza 404,
 * forzando el orden correcto del pipeline). Regenerar la shortlist
 * actualiza el snapshot (rank/score/qualificationStatus/confidence/
 * reasons/gaps/risks) de entradas YA existentes pero NUNCA toca su
 * `reviewStatus` -- una decisión humana ya tomada (APPROVED/HOLD/
 * REMOVED) nunca se revierte automáticamente al refrescar.
 */
export async function generateShortlistForJobOrder(jobOrderId: string): Promise<ShortlistEntryRecord[]> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const matching = await getPersistedCandidateMatching(jobOrderId);
  const drafts = buildShortlistEntries(
    matching.ranked.map((r) => ({
      candidateId: r.candidateId,
      rank: r.rank!,
      score: r.score,
      normalizedScore: r.normalizedScore,
      qualificationStatus: r.qualificationStatus,
      confidence: r.confidence,
      explanation: r.explanation,
      risks: r.risks,
      missingData: r.missingData,
    })),
  );

  const records: ShortlistEntryRecord[] = [];
  for (const draft of drafts) {
    const existing = await scopedDb.candidateShortlistEntry.findFirst({
      where: { candidateId: draft.candidateId, jobOrderId },
    });

    const snapshot = {
      rank: draft.rank,
      score: draft.score,
      normalizedScore: draft.normalizedScore,
      qualificationStatus: draft.qualificationStatus,
      confidence: draft.confidence,
      reasons: draft.reasons,
      gaps: draft.gaps,
      risks: draft.risks,
    };

    const record = existing
      ? await scopedDb.candidateShortlistEntry.update({ where: { id: existing.id }, data: snapshot })
      : await scopedDb.candidateShortlistEntry.create({
          data: { tenantId: ctx.tenantId, candidateId: draft.candidateId, jobOrderId, addedById: ctx.userId, ...snapshot },
        });
    records.push(toShortlistEntryRecord(record));
  }

  await logAuditEvent({
    action: "candidate.shortlist_generated",
    entityType: "job_order_shortlist",
    entityId: jobOrderId,
    after: { jobOrderId, entryCount: records.length },
  });

  return records.sort((a, b) => a.rank - b.rank);
}

/** Lee la shortlist YA persistida, ordenada por rank. Nunca regenera. */
export async function getShortlistForJobOrder(jobOrderId: string): Promise<ShortlistEntryRecord[]> {
  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId }, select: { id: true } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const records = await scopedDb.candidateShortlistEntry.findMany({ where: { jobOrderId }, orderBy: { rank: "asc" } });
  return records.map(toShortlistEntryRecord);
}

/**
 * Único camino para cambiar `reviewStatus` -- valida la transición
 * (`isValidShortlistTransition`, F8.7) antes de escribir. `id` es la PK
 * simple de la tabla, no una clave compuesta -- `findUnique`/`update`
 * funcionan normalmente acá (a diferencia de `findFirst`-por-campos-
 * planos que usan las búsquedas por (candidateId, jobOrderId)).
 */
export async function updateShortlistEntryReviewStatus(
  entryId: string,
  reviewStatus: ShortlistReviewStatus,
): Promise<ShortlistEntryRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.candidateShortlistEntry.findUnique({ where: { id: entryId } });
  if (!existing) throw AppError.notFound("Shortlist entry not found");

  const currentStatus = existing.reviewStatus as ShortlistReviewStatus;
  if (!isValidShortlistTransition(currentStatus, reviewStatus)) {
    throw AppError.badRequest(`Invalid shortlist review status transition: ${currentStatus} -> ${reviewStatus}`);
  }

  const updated = await scopedDb.candidateShortlistEntry.update({ where: { id: entryId }, data: { reviewStatus } });

  await logAuditEvent({
    action: "candidate.shortlist_review_status_changed",
    entityType: "candidate_shortlist_entry",
    entityId: entryId,
    before: { reviewStatus: currentStatus },
    after: { reviewStatus },
  });

  return toShortlistEntryRecord(updated);
}

export interface ScreeningPlanRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  questions: unknown;
  allowedDisqualifiers: string[];
  manualReviewFlags: string[];
  missingInformation: string[];
  riskFlags: string[];
  rulesVersion: number;
  calculatedAt: string;
  generatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

function toScreeningPlanRecord(record: {
  id: string;
  candidateId: string;
  jobOrderId: string;
  questions: unknown;
  allowedDisqualifiers: string[];
  manualReviewFlags: string[];
  missingInformation: string[];
  riskFlags: string[];
  rulesVersion: number;
  calculatedAt: Date;
  generatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ScreeningPlanRecord {
  return {
    id: record.id,
    candidateId: record.candidateId,
    jobOrderId: record.jobOrderId,
    questions: record.questions,
    allowedDisqualifiers: record.allowedDisqualifiers,
    manualReviewFlags: record.manualReviewFlags,
    missingInformation: record.missingInformation,
    riskFlags: record.riskFlags,
    rulesVersion: record.rulesVersion,
    calculatedAt: record.calculatedAt.toISOString(),
    generatedById: record.generatedById,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * F8.8: Screening Intelligence -- wiring impuro entre
 * `recruiting-intelligence/screening-plan.ts` (puro) y los datos reales
 * del tenant. Reutiliza DIRECTAMENTE `runQualificationEvaluation`
 * (F8.2/F8.5/F8.6, sin duplicar) y la categoría real del Job Order para
 * el texto de las preguntas. Nunca entrevista, nunca contacta al
 * candidato, nunca inventa respuestas ni aprueba/rechaza -- solo genera
 * y persiste el PLAN. Upsert por (candidateId, jobOrderId), mismo
 * workaround de `findFirst`-por-campos-planos ya documentado en F8.5.
 */
export async function generateAndPersistScreeningPlan(candidateId: string, jobOrderId: string): Promise<ScreeningPlanRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId }, include: { category: true } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const evaluation = await runQualificationEvaluation(candidateId, jobOrderId);
  const derived = deriveQualificationStatus(evaluation);

  const plan = buildScreeningPlan({
    candidateId,
    jobOrderId,
    categoryName: jobOrder.category.name,
    qualification: evaluation,
    qualificationStatus: derived.status,
  });

  const existing = await scopedDb.screeningPlan.findFirst({ where: { candidateId, jobOrderId } });
  const data = {
    questions: plan.questions as never,
    allowedDisqualifiers: plan.allowedDisqualifiers,
    manualReviewFlags: plan.manualReviewFlags,
    missingInformation: plan.missingInformation,
    riskFlags: plan.riskFlags,
    rulesVersion: plan.rulesVersion,
    calculatedAt: new Date(plan.calculatedAt),
    generatedById: ctx.userId,
  };

  const record = existing
    ? await scopedDb.screeningPlan.update({ where: { id: existing.id }, data })
    : await scopedDb.screeningPlan.create({ data: { tenantId: ctx.tenantId, candidateId, jobOrderId, ...data } });

  await logAuditEvent({
    action: "candidate.screening_plan_generated",
    entityType: "screening_plan",
    entityId: record.id,
    after: { candidateId, jobOrderId, questionCount: (plan.questions as unknown[]).length, rulesVersion: plan.rulesVersion },
  });

  return toScreeningPlanRecord(record);
}

/** Lee el plan de screening YA persistido. Nunca regenera. */
export async function getScreeningPlan(candidateId: string, jobOrderId: string): Promise<ScreeningPlanRecord | null> {
  const record = await scopedDb.screeningPlan.findFirst({ where: { candidateId, jobOrderId } });
  if (!record) return null;
  return toScreeningPlanRecord(record);
}

export interface CreateInterviewPreviewInput {
  proposedWindows: ProposedWindow[];
  durationMinutes: number;
  timezone: string;
  modality: InterviewModality;
  locationOrLink?: string | null;
  participants: InterviewParticipant[];
  restrictions?: string[];
}

export interface InterviewPreviewRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  status: InterviewPreviewStatus;
  proposedWindows: unknown;
  durationMinutes: number;
  timezone: string;
  modality: InterviewModality;
  locationOrLink: string | null;
  participants: unknown;
  restrictions: string[];
  conflicts: unknown;
  availabilityConfirmed: boolean;
  missingInformation: string[];
  rulesVersion: number;
  calculatedAt: string;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

function toInterviewPreviewRecord(record: {
  id: string;
  candidateId: string;
  jobOrderId: string;
  status: string;
  proposedWindows: unknown;
  durationMinutes: number;
  timezone: string;
  modality: string;
  locationOrLink: string | null;
  participants: unknown;
  restrictions: string[];
  conflicts: unknown;
  availabilityConfirmed: boolean;
  missingInformation: string[];
  rulesVersion: number;
  calculatedAt: Date;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): InterviewPreviewRecord {
  return {
    id: record.id,
    candidateId: record.candidateId,
    jobOrderId: record.jobOrderId,
    status: record.status as InterviewPreviewStatus,
    proposedWindows: record.proposedWindows,
    durationMinutes: record.durationMinutes,
    timezone: record.timezone,
    modality: record.modality as InterviewModality,
    locationOrLink: record.locationOrLink,
    participants: record.participants,
    restrictions: record.restrictions,
    conflicts: record.conflicts,
    availabilityConfirmed: record.availabilityConfirmed,
    missingInformation: record.missingInformation,
    rulesVersion: record.rulesVersion,
    calculatedAt: record.calculatedAt.toISOString(),
    createdById: record.createdById,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * F8.9: Interview Scheduling Preview -- wiring impuro entre
 * `recruiting-intelligence/interview-preview.ts` (puro) y los datos
 * reales del tenant. `proposedWindows`/`participants`/`restrictions`
 * son SIEMPRE input humano (nunca inventados acá). Para detectar
 * conflictos, se leen otras previews YA persistidas del MISMO
 * candidato en OTROS Job Orders -- nunca se inventa disponibilidad.
 * Nunca modifica un calendario real, nunca envía invitaciones/email.
 * Upsert por (candidateId, jobOrderId), mismo workaround de
 * `findFirst`-por-campos-planos ya documentado en F8.5.
 */
export async function generateAndPersistInterviewPreview(
  candidateId: string,
  jobOrderId: string,
  input: CreateInterviewPreviewInput,
): Promise<InterviewPreviewRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const [candidate, jobOrder] = await Promise.all([
    scopedDb.candidate.findUnique({ where: { id: candidateId }, select: { id: true } }),
    scopedDb.jobOrder.findUnique({ where: { id: jobOrderId }, select: { id: true } }),
  ]);
  if (!candidate) throw AppError.notFound("Candidate not found");
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const otherPreviews = await scopedDb.interviewPreview.findMany({
    where: { candidateId, jobOrderId: { not: jobOrderId } },
    select: { id: true, proposedWindows: true },
  });
  const existingWindows = otherPreviews.flatMap((p) =>
    (p.proposedWindows as unknown as ProposedWindow[]).map((w) => ({ interviewPreviewId: p.id, start: w.start, end: w.end })),
  );

  const preview: InterviewPreviewInput = {
    candidateId,
    jobOrderId,
    proposedWindows: input.proposedWindows,
    durationMinutes: input.durationMinutes,
    timezone: input.timezone,
    modality: input.modality,
    locationOrLink: input.locationOrLink ?? null,
    participants: input.participants,
    restrictions: input.restrictions ?? [],
    existingWindows,
  };

  const result = buildInterviewPreview(preview);

  const existing = await scopedDb.interviewPreview.findFirst({ where: { candidateId, jobOrderId } });
  const data = {
    status: result.status,
    proposedWindows: result.proposedWindows as never,
    durationMinutes: result.durationMinutes,
    timezone: result.timezone,
    modality: result.modality,
    locationOrLink: result.locationOrLink,
    participants: result.participants as never,
    restrictions: result.restrictions,
    conflicts: result.conflicts as never,
    availabilityConfirmed: result.availabilityConfirmed,
    missingInformation: result.missingInformation,
    rulesVersion: result.rulesVersion,
    calculatedAt: new Date(result.calculatedAt),
  };

  const record = existing
    ? await scopedDb.interviewPreview.update({ where: { id: existing.id }, data })
    : await scopedDb.interviewPreview.create({ data: { tenantId: ctx.tenantId, candidateId, jobOrderId, createdById: ctx.userId, ...data } });

  await logAuditEvent({
    action: "candidate.interview_preview_generated",
    entityType: "interview_preview",
    entityId: record.id,
    after: { candidateId, jobOrderId, status: record.status, conflictCount: result.conflicts.length },
  });

  return toInterviewPreviewRecord(record);
}

/** Lee el preview YA persistido. Nunca recalcula. */
export async function getInterviewPreview(candidateId: string, jobOrderId: string): Promise<InterviewPreviewRecord | null> {
  const record = await scopedDb.interviewPreview.findFirst({ where: { candidateId, jobOrderId } });
  if (!record) return null;
  return toInterviewPreviewRecord(record);
}

/**
 * Único camino para cambiar `status` manualmente -- `APPROVED_FOR_SEND`
 * y `CANCELLED` son SIEMPRE una acción humana explícita (nunca
 * derivadas automáticamente, ver `interview-preview.ts`). Nunca envía
 * nada real -- "APPROVED_FOR_SEND" es solo una aprobación humana
 * registrada, no una invitación enviada.
 */
export async function updateInterviewPreviewStatus(
  candidateId: string,
  jobOrderId: string,
  status: InterviewPreviewStatus,
): Promise<InterviewPreviewRecord> {
  const existing = await scopedDb.interviewPreview.findFirst({ where: { candidateId, jobOrderId } });
  if (!existing) throw AppError.notFound("Interview preview not found");

  const currentStatus = existing.status as InterviewPreviewStatus;
  if (!isValidInterviewPreviewTransition(currentStatus, status)) {
    throw AppError.badRequest(`Invalid interview preview status transition: ${currentStatus} -> ${status}`);
  }

  const updated = await scopedDb.interviewPreview.update({ where: { id: existing.id }, data: { status } });

  await logAuditEvent({
    action: "candidate.interview_preview_status_changed",
    entityType: "interview_preview",
    entityId: existing.id,
    before: { status: currentStatus },
    after: { status },
  });

  return toInterviewPreviewRecord(updated);
}

export interface PlacementReadinessRecord {
  id: string;
  candidateId: string;
  jobOrderId: string;
  readinessStatus: PlacementReadinessStatus;
  score: number;
  blockers: string[];
  warnings: string[];
  completedChecks: string[];
  pendingChecks: string[];
  missingInformation: string[];
  nextBestAction: string;
  requiresApproval: boolean;
  evaluatedAt: string;
  rulesVersion: number;
  evaluatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPlacementReadinessRecord(record: {
  id: string;
  candidateId: string;
  jobOrderId: string;
  readinessStatus: string;
  score: number;
  blockers: string[];
  warnings: string[];
  completedChecks: string[];
  pendingChecks: string[];
  missingInformation: string[];
  nextBestAction: string;
  requiresApproval: boolean;
  evaluatedAt: Date;
  rulesVersion: number;
  evaluatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): PlacementReadinessRecord {
  return {
    id: record.id,
    candidateId: record.candidateId,
    jobOrderId: record.jobOrderId,
    readinessStatus: record.readinessStatus as PlacementReadinessStatus,
    score: record.score,
    blockers: record.blockers,
    warnings: record.warnings,
    completedChecks: record.completedChecks,
    pendingChecks: record.pendingChecks,
    missingInformation: record.missingInformation,
    nextBestAction: record.nextBestAction,
    requiresApproval: record.requiresApproval,
    evaluatedAt: record.evaluatedAt.toISOString(),
    rulesVersion: record.rulesVersion,
    evaluatedById: record.evaluatedById,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * F8.10: Placement Readiness -- wiring impuro entre
 * `recruiting-intelligence/placement-readiness.ts` (puro) y el estado
 * YA persistido por F8.5/F8.7/F8.8/F8.9 -- reutiliza cada uno tal cual
 * (nunca los recalcula). Nunca crea Placement/Assignment, nunca activa
 * un Worker, nunca cambia `Candidate.status`. Upsert por (candidateId,
 * jobOrderId), mismo workaround de `findFirst`-por-campos-planos ya
 * documentado en F8.5.
 */
export async function computeAndPersistPlacementReadiness(candidateId: string, jobOrderId: string): Promise<PlacementReadinessRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const [candidate, jobOrder] = await Promise.all([
    scopedDb.candidate.findUnique({ where: { id: candidateId }, select: { id: true, state: true } }),
    scopedDb.jobOrder.findUnique({ where: { id: jobOrderId }, select: { id: true, location: true, startDate: true } }),
  ]);
  if (!candidate) throw AppError.notFound("Candidate not found");
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const [evaluation, shortlistEntry, screeningPlan, interviewPreview] = await Promise.all([
    runQualificationEvaluation(candidateId, jobOrderId),
    scopedDb.candidateShortlistEntry.findFirst({ where: { candidateId, jobOrderId }, select: { reviewStatus: true } }),
    scopedDb.screeningPlan.findFirst({ where: { candidateId, jobOrderId }, select: { manualReviewFlags: true } }),
    scopedDb.interviewPreview.findFirst({ where: { candidateId, jobOrderId }, select: { status: true } }),
  ]);
  const derived = deriveQualificationStatus(evaluation);
  const jobLocation = jobOrder.location as { state?: string | null } | null;

  const readiness = computePlacementReadiness({
    candidateId,
    jobOrderId,
    qualificationStatus: derived.status,
    qualification: evaluation,
    shortlistReviewStatus: (shortlistEntry?.reviewStatus as ShortlistReviewStatus | undefined) ?? null,
    screeningPlanExists: !!screeningPlan,
    screeningManualReviewFlags: screeningPlan?.manualReviewFlags ?? [],
    interviewPreviewStatus: (interviewPreview?.status as InterviewPreviewStatus | undefined) ?? null,
    candidateState: candidate.state,
    jobOrderState: jobLocation?.state ?? null,
    jobOrderStartDate: jobOrder.startDate,
  });

  const existing = await scopedDb.placementReadiness.findFirst({ where: { candidateId, jobOrderId } });
  const data = {
    readinessStatus: readiness.readinessStatus,
    score: readiness.score,
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    completedChecks: readiness.completedChecks,
    pendingChecks: readiness.pendingChecks,
    missingInformation: readiness.missingInformation,
    nextBestAction: readiness.nextBestAction,
    requiresApproval: readiness.requiresApproval,
    evaluatedAt: new Date(readiness.evaluatedAt),
    rulesVersion: readiness.rulesVersion,
    evaluatedById: ctx.userId,
  };

  const record = existing
    ? await scopedDb.placementReadiness.update({ where: { id: existing.id }, data })
    : await scopedDb.placementReadiness.create({ data: { tenantId: ctx.tenantId, candidateId, jobOrderId, ...data } });

  await logAuditEvent({
    action: "candidate.placement_readiness_evaluated",
    entityType: "placement_readiness",
    entityId: record.id,
    after: { candidateId, jobOrderId, readinessStatus: record.readinessStatus, score: record.score },
  });

  return toPlacementReadinessRecord(record);
}

/** Lee la evaluación de placement readiness YA persistida. Nunca recalcula. */
export async function getPlacementReadiness(candidateId: string, jobOrderId: string): Promise<PlacementReadinessRecord | null> {
  const record = await scopedDb.placementReadiness.findFirst({ where: { candidateId, jobOrderId } });
  if (!record) return null;
  return toPlacementReadinessRecord(record);
}

/**
 * F8.3: Candidate Sourcing -- wiring impuro entre
 * `recruiting-intelligence/candidate-sourcing.ts` (puro) y los
 * Candidate REALES ya existentes en el tenant. Única fuente permitida:
 * el CRM propio (nunca scraping externo, nunca un candidato inventado)
 * -- se consulta `scopedDb.candidate` filtrado por la categoría exacta
 * del Job Order (mismo criterio "nunca traer de más" que el resto de
 * F7/F8). Solo lectura -- nunca crea, contacta, ni cambia el estado de
 * ningún Candidate.
 */
export async function sourceCandidatesForJobOrder(jobOrderId: string, limit = 20): Promise<CandidateSourcingResult> {
  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id: jobOrderId } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const jobLocation = jobOrder.location as { state?: string } | null;
  const candidates = await scopedDb.candidate.findMany({
    where: { categories: { some: { id: jobOrder.categoryId } } },
    include: { categories: true },
    take: Math.min(limit, 100) * 3, // margen para lo que se excluya por status, sin traer todo el tenant
    orderBy: { createdAt: "desc" },
  });

  const result = sourceCandidatesForJob({
    candidates: candidates.map((c) => ({
      candidateId: c.id,
      status: c.status,
      categoryIds: c.categories.map((cat) => cat.id),
      yearsExperience: c.yearsExperience,
      state: c.state,
      createdAt: c.createdAt,
    })),
    job: { categoryId: jobOrder.categoryId, state: jobLocation?.state ?? null },
  });

  return { ...result, sourced: result.sourced.slice(0, limit) };
}
