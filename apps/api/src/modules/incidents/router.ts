import { Router } from "express";
import { requirePermission } from "../../core/rbac/require-permission";
import { AppError } from "../../core/errors";
import * as incidentsService from "./service";

// F9.10: Exceptions and Incidents -- recurso RBAC propio (incidents.*),
// nunca reutiliza assignments.*/workers.* -- reportar un incidente es
// una acción distinta de editar la Assignment/Worker que referencia.
export const incidentsRouter = Router();

const INCIDENT_TYPES = new Set([
  "NO_SHOW",
  "LATE_ARRIVAL",
  "EARLY_DEPARTURE",
  "ATTENDANCE",
  "SAFETY",
  "CLIENT_COMPLAINT",
  "WORKER_COMPLAINT",
  "TIME_DISCREPANCY",
  "DOCUMENT_ISSUE",
  "COMPLIANCE_ISSUE",
  "OTHER",
]);

const INCIDENT_STATUSES = new Set(["OPEN", "UNDER_REVIEW", "ACTION_REQUIRED", "RESOLVED", "CLOSED"]);

incidentsRouter.get("/incidents", requirePermission("incidents.view"), async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    if (q.status && !INCIDENT_STATUSES.has(q.status)) throw AppError.badRequest("Invalid status filter");
    if (q.type && !INCIDENT_TYPES.has(q.type)) throw AppError.badRequest("Invalid type filter");
    res.json(
      await incidentsService.listIncidents({
        status: q.status as never,
        type: q.type as never,
        workerId: q.workerId,
        companyId: q.companyId,
        jobOrderId: q.jobOrderId,
        cursor: q.cursor,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

incidentsRouter.get("/incidents/:id", requirePermission("incidents.view"), async (req, res, next) => {
  try {
    res.json(await incidentsService.getIncidentById(req.params.id!));
  } catch (err) {
    next(err);
  }
});

incidentsRouter.post("/incidents", requirePermission("incidents.create"), async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const { type, description, occurredAt } = body;
    if (typeof type !== "string" || !INCIDENT_TYPES.has(type)) {
      throw AppError.badRequest("Invalid incident type", { allowed: [...INCIDENT_TYPES] });
    }
    if (typeof description !== "string" || description.trim().length === 0) {
      throw AppError.badRequest("description is required");
    }
    if (typeof occurredAt !== "string" || occurredAt.trim().length === 0) {
      throw AppError.badRequest("occurredAt is required");
    }
    res.status(201).json(
      await incidentsService.createIncident({
        type: type as never,
        description,
        occurredAt,
        workerId: (body.workerId as string | null | undefined) ?? null,
        assignmentId: (body.assignmentId as string | null | undefined) ?? null,
        companyId: (body.companyId as string | null | undefined) ?? null,
        jobOrderId: (body.jobOrderId as string | null | undefined) ?? null,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// F9.10: nunca permite tocar type/status/relaciones -- eso vive
// exclusivamente en PATCH /incidents/:id/status (relaciones no son
// editables en absoluto, mismo criterio que Placement/Assignment).
incidentsRouter.patch("/incidents/:id", requirePermission("incidents.update"), async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    res.json(
      await incidentsService.updateIncident(req.params.id!, {
        description: body.description as string | undefined,
        occurredAt: body.occurredAt as string | undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

incidentsRouter.patch("/incidents/:id/status", requirePermission("incidents.update"), async (req, res, next) => {
  try {
    const { status, resolutionNotes } = req.body as { status?: unknown; resolutionNotes?: unknown };
    if (typeof status !== "string" || !INCIDENT_STATUSES.has(status)) {
      throw AppError.badRequest("Invalid incident status", { allowed: [...INCIDENT_STATUSES] });
    }
    res.json(
      await incidentsService.updateIncidentStatus(
        req.params.id!,
        status as never,
        typeof resolutionNotes === "string" ? resolutionNotes : undefined,
      ),
    );
  } catch (err) {
    next(err);
  }
});
