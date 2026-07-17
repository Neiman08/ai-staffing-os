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
  normalizeCandidateEmail as normalizeEmail,
  normalizeCandidatePhone as normalizePhone,
  buildCandidateIdentityKeys,
} from "../recruiting-intelligence/candidate-identity";

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
