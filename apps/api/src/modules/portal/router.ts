import { Router } from "express";
import { requirePermission } from "../../core/rbac/require-permission";
import { AppError } from "../../core/errors";
import * as clientService from "./client-service";

/**
 * F10.2: Client Portal -- todas las rutas viven bajo /portal/client/*,
 * gateadas por los recursos `portal*` de F10.1 (nunca por assignments.
 * view/timeEntries.view/etc. internos -- ver la decisión de seguridad
 * documentada en docs/F10_PLAN.md §2/§3.5).
 */
export const portalRouter = Router();

portalRouter.get("/portal/client/dashboard", requirePermission("portalAssignments.view"), async (_req, res, next) => {
  try {
    res.json(await clientService.getClientDashboard());
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/job-orders", requirePermission("portalAssignments.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientJobOrders({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/job-orders/:id", requirePermission("portalAssignments.view"), async (req, res, next) => {
  try {
    res.json(await clientService.getClientJobOrderDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/job-orders/:id/shortlist", requirePermission("portalAssignments.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientShortlist(req.params.id!));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/placements", requirePermission("portalAssignments.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientPlacements({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/assignments", requirePermission("portalAssignments.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientAssignments({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/workers", requirePermission("portalAssignments.view"), async (_req, res, next) => {
  try {
    res.json(await clientService.listClientWorkers());
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/time-entries", requirePermission("portalTimeEntries.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientPendingTimeEntries({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});

portalRouter.post("/portal/client/time-entries/:id/approve", requirePermission("portalTimeEntries.update"), async (req, res, next) => {
  try {
    res.json(await clientService.approveClientTimeEntry(req.params.id!));
  } catch (err) {
    next(err);
  }
});

portalRouter.post("/portal/client/time-entries/:id/reject", requirePermission("portalTimeEntries.update"), async (req, res, next) => {
  try {
    const { rejectionReason } = req.body as { rejectionReason?: unknown };
    if (typeof rejectionReason !== "string" || rejectionReason.trim().length === 0) {
      throw AppError.badRequest("rejectionReason is required");
    }
    res.json(await clientService.rejectClientTimeEntry(req.params.id!, rejectionReason));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/incidents", requirePermission("portalIncidents.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientIncidents({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});
