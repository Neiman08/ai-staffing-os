import { Router } from "express";
import {
  assignmentQuerySchema,
  createAssignmentInputSchema,
  updateAssignmentInputSchema,
  updateAssignmentStatusInputSchema,
} from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as assignmentsService from "./service";

// F5.4: CRUD completo aprobado (docs/F5_STAFFING_OPERATIONS_PLAN.md §6).
// Sin DELETE físico — COMPLETED/TERMINATED (AssignmentStatus) son los
// estados terminales equivalentes, mismo patrón que JobOrder/Worker.
export const assignmentsRouter = Router();

assignmentsRouter.get("/assignments", requirePermission("assignments.view"), async (req, res, next) => {
  try {
    const query = assignmentQuerySchema.parse(req.query);
    res.json(await assignmentsService.listAssignments(query));
  } catch (err) {
    next(err);
  }
});

assignmentsRouter.get("/assignments/:id", requirePermission("assignments.view"), async (req, res, next) => {
  try {
    res.json(await assignmentsService.getAssignmentDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

assignmentsRouter.post("/assignments", requirePermission("assignments.create"), async (req, res, next) => {
  try {
    const input = createAssignmentInputSchema.parse(req.body);
    res.status(201).json(await assignmentsService.createAssignment(input));
  } catch (err) {
    next(err);
  }
});

// F5.4: nunca permite tocar workerId/jobOrderId/status/tenantId —
// updateAssignmentInputSchema ni siquiera los declara.
assignmentsRouter.patch("/assignments/:id", requirePermission("assignments.update"), async (req, res, next) => {
  try {
    const input = updateAssignmentInputSchema.parse(req.body);
    res.json(await assignmentsService.updateAssignment(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

// F5.4: único camino para cambiar el estado — separado del PATCH general
// a propósito, mismo patrón que Job Orders/Candidates/Workers.
assignmentsRouter.patch(
  "/assignments/:id/status",
  requirePermission("assignments.update"),
  async (req, res, next) => {
    try {
      const input = updateAssignmentStatusInputSchema.parse(req.body);
      res.json(await assignmentsService.updateAssignmentStatus(req.params.id!, input));
    } catch (err) {
      next(err);
    }
  },
);
