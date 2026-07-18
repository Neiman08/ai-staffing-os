/**
 * F10.3: Client Job Request -- lado INTERNO (revisión y conversión).
 * `convertToJobOrder` es la ÚNICA función que crea un JobOrder real, y
 * SIEMPRE exige categoryId/billRate/payRate explícitos del reviewer --
 * nunca los infiere de `requestedTitle`/`payRateExpectation`/
 * `billBudget` (esos son la expectativa del cliente, no una decisión
 * operativa/comercial real).
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";
import { isValidClientJobRequestTransition, INTERNAL_REVIEW_STATUSES, type ClientJobRequestStatus } from "./client-job-request-rules";
import { createJobOrder } from "../jobs/service";

export interface InternalJobRequestListItem {
  id: string;
  companyId: string;
  companyName: string;
  requestedTitle: string;
  headcount: number;
  desiredStartDate: string;
  urgency: string;
  status: ClientJobRequestStatus;
  createdAt: string;
}

export async function listInternalJobRequests(query: { status?: string; cursor?: string; limit?: number }) {
  const limit = query.limit ?? 20;
  const rows = await scopedDb.clientJobRequest.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: { status: query.status as never },
    include: { company: { select: { name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  const mapped: InternalJobRequestListItem[] = items.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    companyName: r.company.name,
    requestedTitle: r.requestedTitle,
    headcount: r.headcount,
    desiredStartDate: r.desiredStartDate.toISOString(),
    urgency: r.urgency,
    status: r.status as ClientJobRequestStatus,
    createdAt: r.createdAt.toISOString(),
  }));
  return { items: mapped, nextCursor };
}

export async function getInternalJobRequestDetail(id: string) {
  const row = await scopedDb.clientJobRequest.findUnique({ where: { id }, include: { company: { select: { name: true } } } });
  if (!row) throw AppError.notFound("Job request not found");
  return {
    id: row.id,
    companyId: row.companyId,
    companyName: row.company.name,
    requestedTitle: row.requestedTitle,
    location: row.location,
    headcount: row.headcount,
    shift: row.shift,
    schedule: row.schedule,
    payRateExpectation: row.payRateExpectation?.toString() ?? null,
    billBudget: row.billBudget?.toString() ?? null,
    desiredStartDate: row.desiredStartDate.toISOString(),
    duration: row.duration,
    requiredSkills: row.requiredSkills,
    certifications: row.certifications,
    languageRequirements: row.languageRequirements,
    physicalRequirements: row.physicalRequirements,
    notes: row.notes,
    urgency: row.urgency,
    status: row.status as ClientJobRequestStatus,
    reviewNotes: row.reviewNotes,
    convertedJobOrderId: row.convertedJobOrderId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Única vía interna para cambiar status -- nunca alcanza
 * CONVERTED_TO_JOB_ORDER (eso exige `convertToJobOrder`, con datos
 * reales de categoryId/rates). `to` restringido a los 4 estados de
 * revisión real (nunca DRAFT/SUBMITTED, que son del cliente).
 */
export async function reviewClientJobRequest(id: string, to: ClientJobRequestStatus, reviewNotes?: string | null) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  if (!INTERNAL_REVIEW_STATUSES.has(to)) {
    throw AppError.badRequest(`Invalid internal review status: ${to}`, { allowed: [...INTERNAL_REVIEW_STATUSES] });
  }

  const existing = await scopedDb.clientJobRequest.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Job request not found");
  const from = existing.status as ClientJobRequestStatus;

  if (from === to) return getInternalJobRequestDetail(id);
  if (!isValidClientJobRequestTransition(from, to)) {
    throw AppError.badRequest(`Cannot transition job request from ${from} to ${to}`);
  }

  await scopedDb.clientJobRequest.update({
    where: { id },
    data: { status: to, reviewedById: ctx.userId, reviewNotes: reviewNotes ?? undefined },
  });

  await logAuditEvent({
    action: "clientJobRequest.reviewed",
    entityType: "clientJobRequest",
    entityId: id,
    before: { status: from },
    after: { status: to },
  });

  return getInternalJobRequestDetail(id);
}

export interface ConvertJobRequestInput {
  categoryId: string;
  billRate: number;
  payRate: number;
  workersNeeded?: number;
}

/**
 * Única función que crea un JobOrder real a partir de una
 * ClientJobRequest -- exige que ya esté APPROVED (guard del grafo de
 * transiciones), y SIEMPRE recibe categoryId/billRate/payRate
 * explícitos del reviewer (nunca inferidos de la solicitud). Reutiliza
 * `createJobOrder` (jobs/service.ts, F5.1) sin duplicar su lógica --
 * arranca en DRAFT, igual que cualquier otro JobOrder creado
 * manualmente.
 */
export async function convertToJobOrder(id: string, input: ConvertJobRequestInput) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.clientJobRequest.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Job request not found");
  if (existing.status !== "APPROVED") {
    throw AppError.badRequest(`Cannot convert a job request that is ${existing.status} -- must be APPROVED first`);
  }

  const jobOrder = await createJobOrder({
    companyId: existing.companyId,
    categoryId: input.categoryId,
    title: existing.requestedTitle,
    workersNeeded: input.workersNeeded ?? existing.headcount,
    billRate: input.billRate,
    payRate: input.payRate,
    location: existing.location as never,
    shiftType: (existing.shift as never) ?? undefined,
    scheduleNotes: existing.schedule ?? undefined,
    startDate: existing.desiredStartDate.toISOString(),
    urgency: existing.urgency as never,
  });

  await scopedDb.clientJobRequest.update({
    where: { id },
    data: { status: "CONVERTED_TO_JOB_ORDER", convertedJobOrderId: jobOrder.id },
  });

  await logAuditEvent({
    action: "clientJobRequest.converted",
    entityType: "clientJobRequest",
    entityId: id,
    after: { jobOrderId: jobOrder.id },
  });

  return getInternalJobRequestDetail(id);
}
