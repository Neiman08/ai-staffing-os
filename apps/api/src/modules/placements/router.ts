import { Router } from "express";
import { requireAllPermissions, requirePermission } from "../../core/rbac/require-permission";
import { AppError } from "../../core/errors";
import * as placementsService from "./service";

// F9.4: Placement -- transición APROBADA entre reclutamiento y
// operaciones. Mismos permisos que Assignments (Operations ya tiene
// assignments.create/update) -- un Placement precede a un Assignment en
// el flujo operativo, tiene sentido compartir el mismo gate de RBAC.
export const placementsRouter = Router();

placementsRouter.post(
  "/candidates/:candidateId/placement/:jobOrderId",
  requireAllPermissions(["assignments.create", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      res.status(201).json(
        await placementsService.createPlacement({
          candidateId: req.params.candidateId!,
          jobOrderId: req.params.jobOrderId!,
          payRate: (body.payRate as number | null | undefined) ?? null,
          billRate: (body.billRate as number | null | undefined) ?? null,
          startDate: (body.startDate as string | null | undefined) ?? null,
          endDate: (body.endDate as string | null | undefined) ?? null,
          shiftType: (body.shiftType as string | null | undefined) ?? null,
          notes: (body.notes as string | null | undefined) ?? null,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

placementsRouter.get(
  "/candidates/:candidateId/placement/:jobOrderId",
  requireAllPermissions(["assignments.view", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      const record = await placementsService.getPlacement(req.params.candidateId!, req.params.jobOrderId!);
      if (!record) throw AppError.notFound("No Placement found for this candidate and job order");
      res.json(record);
    } catch (err) {
      next(err);
    }
  },
);

placementsRouter.get("/placements/:id", requirePermission("assignments.view"), async (req, res, next) => {
  try {
    res.json(await placementsService.getPlacementById(req.params.id!));
  } catch (err) {
    next(err);
  }
});

// F9.4: nunca permite tocar status/candidateId/jobOrderId/tenantId --
// eso vive exclusivamente en PATCH /placements/:id/status.
placementsRouter.patch("/placements/:id", requirePermission("assignments.update"), async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    res.json(
      await placementsService.updatePlacement(req.params.id!, {
        payRate: body.payRate as number | null | undefined,
        billRate: body.billRate as number | null | undefined,
        startDate: body.startDate as string | null | undefined,
        endDate: body.endDate as string | null | undefined,
        shiftType: body.shiftType as string | null | undefined,
        notes: body.notes as string | null | undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

const PLACEMENT_STATUSES = new Set(["DRAFT", "PENDING_APPROVAL", "APPROVED", "READY_FOR_ONBOARDING", "ACTIVE", "COMPLETED", "CANCELLED"]);

placementsRouter.patch("/placements/:id/status", requirePermission("assignments.update"), async (req, res, next) => {
  try {
    const { status } = req.body as { status?: unknown };
    if (typeof status !== "string" || !PLACEMENT_STATUSES.has(status)) {
      throw AppError.badRequest("Invalid placement status", { allowed: [...PLACEMENT_STATUSES] });
    }
    res.json(await placementsService.updatePlacementStatus(req.params.id!, status as never));
  } catch (err) {
    next(err);
  }
});
