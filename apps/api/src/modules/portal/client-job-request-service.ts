/**
 * F10.3: Client Job Request -- lado del CLIENTE. Toda función exige
 * `ctx.companyId` y filtra por esa Company; nunca confía en un id que
 * venga del cliente sin verificar ownership (404, nunca 403, mismo
 * criterio ya establecido en F10.2). Nunca convierte a JobOrder por sí
 * sola -- eso vive exclusivamente en `internal-job-request-service.ts`,
 * como una acción humana interna explícita.
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logAuditEvent } from "../../core/audit-log";
import { emitNotification } from "../../core/notifications";
import { AppError } from "../../core/errors";
import { isValidClientJobRequestTransition, CLIENT_EDITABLE_STATUSES, type ClientJobRequestStatus } from "./client-job-request-rules";

function requireClientContext(): { tenantId: string; companyId: string } {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  if (!ctx.companyId) throw AppError.forbidden("This account is not linked to a Company portal identity");
  return { tenantId: ctx.tenantId, companyId: ctx.companyId };
}

export interface ClientJobRequestInput {
  requestedTitle: string;
  location?: unknown;
  headcount: number;
  shift?: string | null;
  schedule?: string | null;
  payRateExpectation?: number | null;
  billBudget?: number | null;
  desiredStartDate: string;
  duration?: string | null;
  requiredSkills?: string[];
  certifications?: string[];
  languageRequirements?: string[];
  physicalRequirements?: string | null;
  notes?: string | null;
  urgency?: string;
}

export interface ClientJobRequestRecord {
  id: string;
  companyId: string;
  requestedTitle: string;
  location: unknown;
  headcount: number;
  shift: string | null;
  schedule: string | null;
  payRateExpectation: string | null;
  billBudget: string | null;
  desiredStartDate: string;
  duration: string | null;
  requiredSkills: string[];
  certifications: string[];
  languageRequirements: string[];
  physicalRequirements: string | null;
  notes: string | null;
  urgency: string;
  status: ClientJobRequestStatus;
  reviewNotes: string | null;
  convertedJobOrderId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: {
  id: string;
  companyId: string;
  requestedTitle: string;
  location: unknown;
  headcount: number;
  shift: string | null;
  schedule: string | null;
  payRateExpectation: { toString(): string } | null;
  billBudget: { toString(): string } | null;
  desiredStartDate: Date;
  duration: string | null;
  requiredSkills: string[];
  certifications: string[];
  languageRequirements: string[];
  physicalRequirements: string | null;
  notes: string | null;
  urgency: string;
  status: string;
  reviewNotes: string | null;
  convertedJobOrderId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ClientJobRequestRecord {
  return {
    id: row.id,
    companyId: row.companyId,
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

export async function listClientJobRequests(query: { cursor?: string; limit?: number }) {
  const { companyId } = requireClientContext();
  const limit = query.limit ?? 20;
  const rows = await scopedDb.clientJobRequest.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit }),
    where: { companyId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, limit);
  return { items: items.map(toRecord), nextCursor };
}

async function getOwnedRequest(id: string, companyId: string) {
  const row = await scopedDb.clientJobRequest.findUnique({ where: { id } });
  if (!row || row.companyId !== companyId) throw AppError.notFound("Job request not found");
  return row;
}

export async function getClientJobRequest(id: string): Promise<ClientJobRequestRecord> {
  const { companyId } = requireClientContext();
  return toRecord(await getOwnedRequest(id, companyId));
}

export async function createClientJobRequest(input: ClientJobRequestInput): Promise<ClientJobRequestRecord> {
  const { tenantId, companyId } = requireClientContext();
  const ctx = getTenancyContext()!;

  const created = await scopedDb.clientJobRequest.create({
    data: {
      tenantId,
      companyId,
      requestedTitle: input.requestedTitle,
      location: (input.location as never) ?? undefined,
      headcount: input.headcount,
      shift: (input.shift as never) ?? undefined,
      schedule: input.schedule ?? undefined,
      payRateExpectation: input.payRateExpectation ?? undefined,
      billBudget: input.billBudget ?? undefined,
      desiredStartDate: new Date(input.desiredStartDate),
      duration: input.duration ?? undefined,
      requiredSkills: input.requiredSkills ?? [],
      certifications: input.certifications ?? [],
      languageRequirements: input.languageRequirements ?? [],
      physicalRequirements: input.physicalRequirements ?? undefined,
      notes: input.notes ?? undefined,
      urgency: (input.urgency as never) ?? "MEDIUM",
      status: "DRAFT",
      createdById: ctx.userId,
    },
  });

  await logAuditEvent({
    action: "clientJobRequest.created",
    entityType: "clientJobRequest",
    entityId: created.id,
    after: { companyId, requestedTitle: input.requestedTitle, status: "DRAFT" },
  });

  return toRecord(created);
}

export async function updateClientJobRequest(id: string, input: Partial<ClientJobRequestInput>): Promise<ClientJobRequestRecord> {
  const { companyId } = requireClientContext();
  const existing = await getOwnedRequest(id, companyId);

  if (!CLIENT_EDITABLE_STATUSES.has(existing.status as ClientJobRequestStatus)) {
    throw AppError.badRequest(`Cannot edit a job request that is ${existing.status} -- only DRAFT/NEEDS_INFORMATION are editable`);
  }

  const updated = await scopedDb.clientJobRequest.update({
    where: { id },
    data: {
      requestedTitle: input.requestedTitle,
      location: (input.location as never) ?? undefined,
      headcount: input.headcount,
      shift: (input.shift as never) ?? undefined,
      schedule: input.schedule ?? undefined,
      payRateExpectation: input.payRateExpectation ?? undefined,
      billBudget: input.billBudget ?? undefined,
      desiredStartDate: input.desiredStartDate ? new Date(input.desiredStartDate) : undefined,
      duration: input.duration ?? undefined,
      requiredSkills: input.requiredSkills,
      certifications: input.certifications,
      languageRequirements: input.languageRequirements,
      physicalRequirements: input.physicalRequirements ?? undefined,
      notes: input.notes ?? undefined,
      urgency: (input.urgency as never) ?? undefined,
    },
  });

  await logAuditEvent({
    action: "clientJobRequest.updated",
    entityType: "clientJobRequest",
    entityId: id,
    after: { requestedTitle: updated.requestedTitle },
  });

  return toRecord(updated);
}

async function transitionOwnedRequest(id: string, to: ClientJobRequestStatus, action: string): Promise<ClientJobRequestRecord> {
  const { companyId } = requireClientContext();
  const existing = await getOwnedRequest(id, companyId);
  const from = existing.status as ClientJobRequestStatus;

  if (from === to) return toRecord(existing);
  if (!isValidClientJobRequestTransition(from, to)) {
    throw AppError.badRequest(`Cannot transition job request from ${from} to ${to}`);
  }

  const updated = await scopedDb.clientJobRequest.update({ where: { id }, data: { status: to } });

  await logAuditEvent({
    action,
    entityType: "clientJobRequest",
    entityId: id,
    before: { status: from },
    after: { status: to },
  });

  return toRecord(updated);
}

export async function submitClientJobRequest(id: string): Promise<ClientJobRequestRecord> {
  const result = await transitionOwnedRequest(id, "SUBMITTED", "clientJobRequest.submitted");
  // F10.8: broadcast a Recruiter (rol interno tenant-wide, seguro --
  // ningún dato de la solicitud cruza tenants, y Recruiter ya ve todos
  // los Job Orders del tenant sin distinción de cliente).
  await emitNotification({
    recipientRole: "Recruiter",
    type: "JOB_REQUEST_SUBMITTED",
    title: `New job request: ${result.requestedTitle}`,
    body: `A client submitted a request for ${result.headcount} worker(s).`,
    entityType: "clientJobRequest",
    entityId: id,
    actionUrl: `/client-job-requests/${id}`,
  });
  return result;
}

export async function cancelClientJobRequest(id: string): Promise<ClientJobRequestRecord> {
  return transitionOwnedRequest(id, "CANCELLED", "clientJobRequest.cancelled");
}
