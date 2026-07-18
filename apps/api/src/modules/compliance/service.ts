import type {
  ComplianceAlertListItem,
  CreateDocumentInput,
  DocumentListItem,
  DocumentTypeListItem,
  Paginated,
  PaginationQuery,
  VerifyDocumentInput,
} from "@ai-staffing-os/shared";
import { prisma } from "@ai-staffing-os/db";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext, runWithTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";
import {
  evaluateComplianceRules,
  selectApplicableRules,
  type ComplianceRuleDefinition,
  type ComplianceEvaluationContext,
  type ComplianceEvaluationStatus,
  type DocumentCheckInput,
  type DocumentCheckStatus,
} from "../operations-intelligence/compliance-rules";

// F5.5 (plan §7.2, aprobado): ventana de días antes del vencimiento real
// para generar una alerta EXPIRING. El plan lo describe como un ejemplo
// de setting configurable (Tenant.settings.complianceAlertWindowDays) —
// se mantiene como constante fija en esta pasada (YAGNI: sin UI de
// configuración todavía, ningún caso de uso real la pidió).
const EXPIRING_WINDOW_DAYS = 30;

function toDocumentListItem(doc: {
  id: string;
  documentType: { name: string };
  candidate: { firstName: string; lastName: string } | null;
  worker: { candidate: { firstName: string; lastName: string } } | null;
  workerId: string | null;
  status: string;
  issuedDate: Date | null;
  expirationDate: Date | null;
  verifiedByAgent: boolean;
}): DocumentListItem {
  const ownerType: "candidate" | "worker" = doc.workerId ? "worker" : "candidate";
  const ownerCandidate = doc.workerId ? doc.worker?.candidate : doc.candidate;
  const ownerLabel = ownerCandidate ? `${ownerCandidate.firstName} ${ownerCandidate.lastName}` : "—";

  return {
    id: doc.id,
    documentTypeName: doc.documentType.name,
    ownerLabel,
    ownerType,
    status: doc.status,
    issuedDate: doc.issuedDate?.toISOString() ?? null,
    expirationDate: doc.expirationDate?.toISOString() ?? null,
    verifiedByAgent: doc.verifiedByAgent,
  };
}

const DOCUMENT_INCLUDE = {
  documentType: true,
  candidate: true,
  worker: { include: { candidate: true } },
} as const;

export async function listDocuments(query: PaginationQuery): Promise<Paginated<DocumentListItem>> {
  const rows = await scopedDb.document.findMany({
    ...buildCursorArgs(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: DOCUMENT_INCLUDE,
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);
  return { items: items.map(toDocumentListItem), nextCursor };
}

export async function listComplianceAlerts(
  query: PaginationQuery,
): Promise<Paginated<ComplianceAlertListItem>> {
  const rows = await scopedDb.complianceAlert.findMany({
    ...buildCursorArgs(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { worker: { include: { candidate: true } } },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);

  return {
    items: items.map((alert) => ({
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      workerName: alert.worker?.candidate
        ? `${alert.worker.candidate.firstName} ${alert.worker.candidate.lastName}`
        : null,
      resolvedAt: alert.resolvedAt?.toISOString() ?? null,
      createdAt: alert.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function listDocumentTypes(): Promise<DocumentTypeListItem[]> {
  const types = await scopedDb.documentType.findMany({ orderBy: { name: "asc" } });
  return types.map((type) => ({
    id: type.id,
    key: type.key,
    name: type.name,
    category: type.category,
    requiresExpiration: type.requiresExpiration,
  }));
}

/**
 * F5.5 (plan §5.4, aprobado): "Worker.complianceStatus ya es el campo
 * correcto... se necesita que el módulo de Compliance realmente lo
 * actualice." Se deriva 100% de alertas reales sin resolver — nunca se
 * edita a mano desde ningún otro endpoint. BLOCKED si hay cualquier
 * alerta sin resolver de tipo EXPIRED/MISSING/FAILED_CHECK; PENDING si
 * solo quedan EXPIRING sin resolver; COMPLIANT si no hay ninguna.
 */
export async function recomputeWorkerComplianceStatus(workerId: string): Promise<void> {
  const worker = await scopedDb.worker.findUnique({ where: { id: workerId } });
  if (!worker) return;

  const unresolved = await scopedDb.complianceAlert.findMany({ where: { workerId, resolvedAt: null } });
  const hasBlocking = unresolved.some((a) => a.type === "EXPIRED" || a.type === "MISSING" || a.type === "FAILED_CHECK");
  const hasWarning = unresolved.some((a) => a.type === "EXPIRING");
  const next = hasBlocking ? "BLOCKED" : hasWarning ? "PENDING" : "COMPLIANT";

  if (worker.complianceStatus !== next) {
    await scopedDb.worker.update({ where: { id: workerId }, data: { complianceStatus: next } });
  }
}

async function resolveOwnerWorkerId(doc: { candidateId: string | null; workerId: string | null }): Promise<string | null> {
  if (doc.workerId) return doc.workerId;
  if (!doc.candidateId) return null;
  const worker = await scopedDb.worker.findFirst({ where: { candidateId: doc.candidateId } });
  return worker?.id ?? null;
}

export async function createDocument(input: CreateDocumentInput) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const documentType = await scopedDb.documentType.findUnique({ where: { id: input.documentTypeId } });
  if (!documentType) throw AppError.badRequest("Document type not found");

  if (input.candidateId) {
    const candidate = await scopedDb.candidate.findUnique({ where: { id: input.candidateId } });
    if (!candidate) throw AppError.badRequest("Candidate not found");
  }
  if (input.workerId) {
    const worker = await scopedDb.worker.findUnique({ where: { id: input.workerId } });
    if (!worker) throw AppError.badRequest("Worker not found");
  }

  const document = await scopedDb.document.create({
    data: {
      tenantId: ctx.tenantId,
      documentTypeId: input.documentTypeId,
      candidateId: input.candidateId,
      workerId: input.workerId,
      fileUrl: input.fileUrl,
      issuedDate: input.issuedDate ? new Date(input.issuedDate) : undefined,
      expirationDate: input.expirationDate ? new Date(input.expirationDate) : undefined,
      status: "PENDING_REVIEW",
    },
    include: DOCUMENT_INCLUDE,
  });

  await logActivity({
    entityType: input.workerId ? "worker" : "candidate",
    entityId: input.workerId ?? input.candidateId!,
    type: "SYSTEM",
    subject: `Document uploaded: ${documentType.name}`,
  });
  await logAuditEvent({
    action: "document.created",
    entityType: "document",
    entityId: document.id,
    after: { documentTypeId: input.documentTypeId, status: "PENDING_REVIEW" },
  });

  // F5.5: si el documento pertenece a un Worker con una alerta MISSING
  // sin resolver de este mismo tipo, resolverla acá sería prematuro —
  // sigue PENDING_REVIEW, no VERIFIED todavía. recomputeWorkerComplianceStatus
  // no cambia nada en este punto (MISSING solo se resuelve al verificar).
  return toDocumentListItem(document);
}

export async function verifyDocument(id: string, input: VerifyDocumentInput) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.document.findUnique({ where: { id }, include: DOCUMENT_INCLUDE });
  if (!existing) throw AppError.notFound("Document not found");

  if (input.status === "REJECTED" && !input.rejectionReason) {
    throw AppError.badRequest("rejectionReason is required when rejecting a document");
  }

  const updated = await scopedDb.document.update({
    where: { id },
    data: {
      status: input.status,
      verifiedById: ctx.userId,
      verifiedByAgent: false,
      rejectionReason: input.status === "REJECTED" ? input.rejectionReason : null,
    },
    include: DOCUMENT_INCLUDE,
  });

  await logActivity({
    entityType: "document",
    entityId: id,
    type: "SYSTEM",
    subject: `Document ${input.status === "VERIFIED" ? "verified" : "rejected"}: ${existing.documentType.name}`,
  });
  await logAuditEvent({
    action: "document.verified",
    entityType: "document",
    entityId: id,
    before: { status: existing.status },
    after: { status: input.status },
  });

  const ownerWorkerId = await resolveOwnerWorkerId(existing);
  if (ownerWorkerId) {
    // F5.5 (plan §7.2, aprobado): FAILED_CHECK se genera acá — "cuando un
    // humano marca un Document.status = REJECTED", nunca por el sweep
    // periódico (eso es solo EXPIRING/EXPIRED/MISSING).
    if (input.status === "REJECTED") {
      await scopedDb.complianceAlert.create({
        data: {
          tenantId: ctx.tenantId,
          workerId: ownerWorkerId,
          documentId: id,
          type: "FAILED_CHECK",
          severity: "HIGH",
          message: `${existing.documentType.name} rejected: ${input.rejectionReason}`,
        },
      });
    }
    await recomputeWorkerComplianceStatus(ownerWorkerId);
  }

  return toDocumentListItem(updated);
}

export async function resolveComplianceAlert(id: string) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.complianceAlert.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Compliance alert not found");

  if (existing.resolvedAt) {
    // F5.5: idempotente — resolver una alerta ya resuelta es un no-op
    // exitoso, nunca un error ni una segunda entrada de AuditLog.
    return { id: existing.id, resolvedAt: existing.resolvedAt.toISOString() };
  }

  const updated = await scopedDb.complianceAlert.update({
    where: { id },
    data: { resolvedAt: new Date(), resolvedById: ctx.userId },
  });

  await logAuditEvent({
    action: "complianceAlert.resolved",
    entityType: "complianceAlert",
    entityId: id,
    before: { resolvedAt: null },
    after: { resolvedAt: updated.resolvedAt!.toISOString() },
  });

  if (existing.workerId) {
    await logActivity({
      entityType: "worker",
      entityId: existing.workerId,
      type: "SYSTEM",
      subject: `Compliance alert resolved: ${existing.message}`,
    });
    await recomputeWorkerComplianceStatus(existing.workerId);
  }

  return { id: updated.id, resolvedAt: updated.resolvedAt!.toISOString() };
}

// ================= Sweep periódico (F5.5, plan §7.2) =================

/**
 * EXPIRING: documentos con expirationDate dentro de la ventana (o ya
 * vencidos, ver generateExpiredAlerts) que todavía no tienen una alerta
 * EXPIRING sin resolver. EXPIRED: documentos ya vencidos sin una alerta
 * EXPIRED sin resolver — un documento vencido nunca genera EXPIRING,
 * genera EXPIRED directamente (evita alertar dos veces por lo mismo).
 */
async function generateExpirationAlerts(): Promise<{ expiring: number; expired: number }> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const expiringDocs = await scopedDb.document.findMany({
    where: { expirationDate: { gt: now, lte: windowEnd } },
    include: { documentType: true },
  });
  const expiredDocs = await scopedDb.document.findMany({
    where: { expirationDate: { lte: now } },
    include: { documentType: true },
  });

  let expiring = 0;
  let expired = 0;

  for (const doc of expiringDocs) {
    const workerId = await resolveOwnerWorkerId(doc);
    if (!workerId) continue;
    const already = await scopedDb.complianceAlert.findFirst({
      where: { documentId: doc.id, type: "EXPIRING", resolvedAt: null },
    });
    if (already) continue;
    await scopedDb.complianceAlert.create({
      data: {
        tenantId: (getTenancyContext()!).tenantId,
        workerId,
        documentId: doc.id,
        type: "EXPIRING",
        severity: "MEDIUM",
        message: `${doc.documentType.name} expires on ${doc.expirationDate!.toISOString().slice(0, 10)}`,
      },
    });
    await recomputeWorkerComplianceStatus(workerId);
    expiring += 1;
  }

  for (const doc of expiredDocs) {
    const workerId = await resolveOwnerWorkerId(doc);
    if (!workerId) continue;
    const already = await scopedDb.complianceAlert.findFirst({
      where: { documentId: doc.id, type: "EXPIRED", resolvedAt: null },
    });
    if (already) continue;
    await scopedDb.complianceAlert.create({
      data: {
        tenantId: (getTenancyContext()!).tenantId,
        workerId,
        documentId: doc.id,
        type: "EXPIRED",
        severity: "HIGH",
        message: `${doc.documentType.name} expired on ${doc.expirationDate!.toISOString().slice(0, 10)}`,
      },
    });
    if (doc.status !== "EXPIRED") {
      await scopedDb.document.update({ where: { id: doc.id }, data: { status: "EXPIRED" } });
    }
    await recomputeWorkerComplianceStatus(workerId);
    expired += 1;
  }

  return { expiring, expired };
}

/**
 * MISSING: para cada Worker con al menos una Assignment SCHEDULED/ACTIVE,
 * se compara `JobOrder.requirements` (keys de DocumentType) contra los
 * Document reales del Worker/Candidate de origen — cualquier documento
 * en estado REJECTED o ausente cuenta como "no cubierto". No se compara
 * contra JobCategory.requiredCertifications a propósito: los requisitos
 * ya declarados y editables en cada Job Order (F5.1) son la fuente más
 * específica y real, en vez de duplicar la misma verificación contra dos
 * fuentes distintas.
 */
async function generateMissingDocumentAlerts(): Promise<number> {
  const activeAssignments = await scopedDb.assignment.findMany({
    where: { status: { in: ["SCHEDULED", "ACTIVE"] } },
    include: { jobOrder: true, worker: { include: { candidate: true, documents: { include: { documentType: true } } } } },
  });

  const requirementsByWorker = new Map<string, Set<string>>();
  for (const a of activeAssignments) {
    const requirements = (a.jobOrder.requirements as string[] | null) ?? [];
    if (requirements.length === 0) continue;
    const set = requirementsByWorker.get(a.workerId) ?? new Set<string>();
    for (const key of requirements) set.add(key);
    requirementsByWorker.set(a.workerId, set);
  }

  let created = 0;
  for (const [workerId, requiredKeys] of requirementsByWorker) {
    const assignment = activeAssignments.find((a) => a.workerId === workerId)!;
    const ownedKeys = new Set(
      assignment.worker.documents.filter((d) => d.status !== "REJECTED").map((d) => d.documentType.key),
    );
    // También cuentan los documentos que el Worker tiene vía su Candidate
    // de origen (mismo criterio de "no duplicar" ya aplicado en F5.2/F5.3).
    const candidateOwnDocs = await scopedDb.document.findMany({
      where: { candidateId: assignment.worker.candidateId },
      include: { documentType: true },
    });
    for (const d of candidateOwnDocs) {
      if (d.status !== "REJECTED") ownedKeys.add(d.documentType.key);
    }

    for (const key of requiredKeys) {
      if (ownedKeys.has(key)) continue;
      const already = await scopedDb.complianceAlert.findFirst({
        where: { workerId, type: "MISSING", resolvedAt: null, message: { contains: key } },
      });
      if (already) continue;

      const documentType = await scopedDb.documentType.findFirst({ where: { key } });
      await scopedDb.complianceAlert.create({
        data: {
          tenantId: (getTenancyContext()!).tenantId,
          workerId,
          type: "MISSING",
          severity: "HIGH",
          message: `Missing required document (${key}): ${documentType?.name ?? key}`,
        },
      });
      await recomputeWorkerComplianceStatus(workerId);
      created += 1;
    }
  }

  return created;
}

export interface ComplianceAlertSweepResult {
  expiring: number;
  expired: number;
  missing: number;
}

export async function runComplianceAlertSweepForTenant(tenantId: string): Promise<ComplianceAlertSweepResult> {
  const operator = await prisma.user.findFirst({
    where: { tenantId, isActive: true, role: { name: { in: ["CEO", "Admin"] } } },
    orderBy: { createdAt: "asc" },
  });
  if (!operator) return { expiring: 0, expired: 0, missing: 0 };

  return runWithTenancyContext({ tenantId, userId: operator.id, permissions: [] }, async () => {
    const { expiring, expired } = await generateExpirationAlerts();
    const missing = await generateMissingDocumentAlerts();
    return { expiring, expired, missing };
  });
}

// ================= F9.3: Compliance Rules (configurables) =================

export interface CreateComplianceRuleInput {
  name: string;
  state?: string | null;
  industryId?: string | null;
  companyId?: string | null;
  jobCategoryId?: string | null;
  assignmentType?: "W2" | "C1099" | null;
  requiredDocumentTypeKeys: string[];
}

export interface ComplianceRuleRecord {
  id: string;
  name: string;
  state: string | null;
  industryId: string | null;
  companyId: string | null;
  jobCategoryId: string | null;
  assignmentType: string | null;
  requiredDocumentTypeKeys: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

function toComplianceRuleRecord(rule: {
  id: string;
  name: string;
  state: string | null;
  industryId: string | null;
  companyId: string | null;
  jobCategoryId: string | null;
  assignmentType: string | null;
  requiredDocumentTypeKeys: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ComplianceRuleRecord {
  return {
    id: rule.id,
    name: rule.name,
    state: rule.state,
    industryId: rule.industryId,
    companyId: rule.companyId,
    jobCategoryId: rule.jobCategoryId,
    assignmentType: rule.assignmentType,
    requiredDocumentTypeKeys: rule.requiredDocumentTypeKeys,
    active: rule.active,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

/**
 * F9.3: define una regla de compliance CONFIGURABLE -- todo campo de
 * scope es opcional (null = aplica a cualquier valor, ver
 * `compliance-rules.ts`). `requiredDocumentTypeKeys` se valida contra
 * el catálogo YA existente de `DocumentType` -- nunca acepta una key
 * inventada.
 */
export async function createComplianceRule(input: CreateComplianceRuleInput): Promise<ComplianceRuleRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  if (input.requiredDocumentTypeKeys.length > 0) {
    const found = await scopedDb.documentType.findMany({ where: { key: { in: input.requiredDocumentTypeKeys } } });
    const foundKeys = new Set(found.map((d) => d.key));
    const invalid = input.requiredDocumentTypeKeys.filter((k) => !foundKeys.has(k));
    if (invalid.length > 0) {
      throw AppError.badRequest(`Unknown document type key(s): ${invalid.join(", ")}`, { invalid });
    }
  }

  const rule = await scopedDb.complianceRule.create({
    data: {
      tenantId: ctx.tenantId,
      name: input.name,
      state: input.state ?? null,
      industryId: input.industryId ?? null,
      companyId: input.companyId ?? null,
      jobCategoryId: input.jobCategoryId ?? null,
      assignmentType: input.assignmentType ?? null,
      requiredDocumentTypeKeys: input.requiredDocumentTypeKeys,
      createdById: ctx.userId,
    },
  });

  await logAuditEvent({
    action: "complianceRule.created",
    entityType: "compliance_rule",
    entityId: rule.id,
    after: { name: rule.name, requiredDocumentTypeKeys: rule.requiredDocumentTypeKeys },
  });

  return toComplianceRuleRecord(rule);
}

export async function listComplianceRules(): Promise<ComplianceRuleRecord[]> {
  const rules = await scopedDb.complianceRule.findMany({ orderBy: { createdAt: "desc" } });
  return rules.map(toComplianceRuleRecord);
}

export interface ComplianceRuleEvaluationRecord {
  id: string;
  workerId: string;
  jobOrderId: string;
  requiredChecks: string[];
  satisfiedChecks: string[];
  missingChecks: string[];
  expiredChecks: string[];
  blockers: string[];
  warnings: string[];
  manualReviewFlags: string[];
  complianceStatus: ComplianceEvaluationStatus;
  rulesVersion: number;
  evaluatedAt: string;
  evaluatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

function toComplianceRuleEvaluationRecord(record: {
  id: string;
  workerId: string;
  jobOrderId: string;
  requiredChecks: string[];
  satisfiedChecks: string[];
  missingChecks: string[];
  expiredChecks: string[];
  blockers: string[];
  warnings: string[];
  manualReviewFlags: string[];
  complianceStatus: string;
  rulesVersion: number;
  evaluatedAt: Date;
  evaluatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ComplianceRuleEvaluationRecord {
  return {
    id: record.id,
    workerId: record.workerId,
    jobOrderId: record.jobOrderId,
    requiredChecks: record.requiredChecks,
    satisfiedChecks: record.satisfiedChecks,
    missingChecks: record.missingChecks,
    expiredChecks: record.expiredChecks,
    blockers: record.blockers,
    warnings: record.warnings,
    manualReviewFlags: record.manualReviewFlags,
    complianceStatus: record.complianceStatus as ComplianceEvaluationStatus,
    rulesVersion: record.rulesVersion,
    evaluatedAt: record.evaluatedAt.toISOString(),
    evaluatedById: record.evaluatedById,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Determina el estado de UN documento requerido a partir de los
 * `Document` reales del Worker + los de su Candidate de origen (mismo
 * criterio "no duplicar" ya usado en `generateMissingDocumentAlerts`).
 * Un documento VERIFIED con `expirationDate` ya pasada cuenta como
 * EXPIRED, nunca como VERIFIED -- nunca se inventa un documento.
 */
function computeDocumentCheckStatus(
  key: string,
  documents: Array<{ documentTypeKey: string; status: string; expirationDate: Date | null }>,
  now: Date,
): DocumentCheckStatus {
  const matching = documents.filter((d) => d.documentTypeKey === key);
  if (matching.length === 0) return "MISSING";

  const verifiedCurrent = matching.some(
    (d) => d.status === "VERIFIED" && (!d.expirationDate || d.expirationDate.getTime() > now.getTime()),
  );
  if (verifiedCurrent) return "VERIFIED";

  const expired = matching.some((d) => d.status === "VERIFIED" && d.expirationDate && d.expirationDate.getTime() <= now.getTime());
  if (expired) return "EXPIRED";

  const underReview = matching.some((d) => d.status === "PENDING_REVIEW");
  if (underReview) return "UNDER_REVIEW";

  return "MISSING";
}

/**
 * F9.3: evalúa y PERSISTE (upsert) el resultado de las reglas de
 * compliance aplicables para UN Worker en el contexto de UN JobOrder.
 * El contexto (estado/industria/cliente/categoría/tipo de asignación)
 * se deriva de datos YA reales -- nunca inventado. Reutiliza
 * `Worker.complianceStatus` (F5.5) como señal, nunca lo recalcula.
 * Nunca cambia `Worker.complianceStatus` ni crea un Assignment.
 */
export async function evaluateComplianceForWorkerJobOrder(
  workerId: string,
  jobOrderId: string,
): Promise<ComplianceRuleEvaluationRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const [worker, jobOrder] = await Promise.all([
    scopedDb.worker.findUnique({
      where: { id: workerId },
      include: { candidate: true, documents: { include: { documentType: true } } },
    }),
    scopedDb.jobOrder.findUnique({ where: { id: jobOrderId }, include: { company: true } }),
  ]);
  if (!worker) throw AppError.notFound("Worker not found");
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const evalCtx: ComplianceEvaluationContext = {
    state: worker.candidate.state,
    industryId: jobOrder.company.industryId,
    companyId: jobOrder.companyId,
    jobCategoryId: jobOrder.categoryId,
    assignmentType: worker.employmentType,
  };

  const ruleRows = await scopedDb.complianceRule.findMany({ where: { active: true } });
  const definitions: ComplianceRuleDefinition[] = ruleRows.map((r) => ({
    id: r.id,
    name: r.name,
    scope: {
      state: r.state,
      industryId: r.industryId,
      companyId: r.companyId,
      jobCategoryId: r.jobCategoryId,
      assignmentType: r.assignmentType,
    },
    requiredDocumentTypeKeys: r.requiredDocumentTypeKeys,
    active: r.active,
  }));
  const applicable = selectApplicableRules(definitions, evalCtx);

  const candidateDocs = await scopedDb.document.findMany({
    where: { candidateId: worker.candidateId },
    include: { documentType: true },
  });
  const allDocs = [
    ...worker.documents.map((d) => ({ documentTypeKey: d.documentType.key, status: d.status, expirationDate: d.expirationDate })),
    ...candidateDocs.map((d) => ({ documentTypeKey: d.documentType.key, status: d.status, expirationDate: d.expirationDate })),
  ];

  const now = new Date();
  const requiredKeys = [...new Set(applicable.flatMap((r) => r.requiredDocumentTypeKeys))];
  const documentChecks: DocumentCheckInput[] = requiredKeys.map((key) => ({
    documentTypeKey: key,
    status: computeDocumentCheckStatus(key, allDocs, now),
  }));

  const result = evaluateComplianceRules(applicable, documentChecks, worker.complianceStatus, now);

  const existing = await scopedDb.complianceRuleEvaluation.findFirst({ where: { workerId, jobOrderId } });
  const data = {
    requiredChecks: result.requiredChecks,
    satisfiedChecks: result.satisfiedChecks,
    missingChecks: result.missingChecks,
    expiredChecks: result.expiredChecks,
    blockers: result.blockers,
    warnings: result.warnings,
    manualReviewFlags: result.manualReviewFlags,
    complianceStatus: result.complianceStatus,
    rulesVersion: result.rulesVersion,
    evaluatedAt: new Date(result.evaluatedAt),
    evaluatedById: ctx.userId,
  };

  const record = existing
    ? await scopedDb.complianceRuleEvaluation.update({ where: { id: existing.id }, data })
    : await scopedDb.complianceRuleEvaluation.create({ data: { tenantId: ctx.tenantId, workerId, jobOrderId, ...data } });

  await logAuditEvent({
    action: "worker.compliance_rules_evaluated",
    entityType: "compliance_rule_evaluation",
    entityId: record.id,
    after: { workerId, jobOrderId, complianceStatus: record.complianceStatus },
  });

  return toComplianceRuleEvaluationRecord(record);
}

/** Lee la evaluación YA persistida. Nunca la recalcula. */
export async function getComplianceRuleEvaluation(
  workerId: string,
  jobOrderId: string,
): Promise<ComplianceRuleEvaluationRecord | null> {
  const record = await scopedDb.complianceRuleEvaluation.findFirst({ where: { workerId, jobOrderId } });
  if (!record) return null;
  return toComplianceRuleEvaluationRecord(record);
}
