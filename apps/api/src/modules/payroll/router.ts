import { Router } from "express";
import {
  bulkApproveTimeEntriesInputSchema,
  createTimeEntryInputSchema,
  timeEntryQuerySchema,
  updateTimeEntryInputSchema,
} from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as payrollService from "./service";

export const payrollRouter = Router();

payrollRouter.get("/time-entries", requirePermission("timeEntries.view"), async (req, res, next) => {
  try {
    const query = timeEntryQuerySchema.parse(req.query);
    res.json(await payrollService.listTimeEntries(query));
  } catch (err) {
    next(err);
  }
});

payrollRouter.post("/time-entries", requirePermission("timeEntries.create"), async (req, res, next) => {
  try {
    const input = createTimeEntryInputSchema.parse(req.body);
    res.status(201).json(await payrollService.createTimeEntry(input));
  } catch (err) {
    next(err);
  }
});

// F5.6: solo editable mientras el TimeEntry sigue PENDING (verificado en
// el servicio) — updateTimeEntryInputSchema ni siquiera declara status.
payrollRouter.patch("/time-entries/:id", requirePermission("timeEntries.update"), async (req, res, next) => {
  try {
    const input = updateTimeEntryInputSchema.parse(req.body);
    res.json(await payrollService.updateTimeEntry(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

// F5.6 (plan §8.3, aprobado): reutiliza timeEntries.update — no se
// inventa un timeEntries.approve nuevo sin necesidad real.
payrollRouter.post(
  "/time-entries/bulk-approve",
  requirePermission("timeEntries.update"),
  async (req, res, next) => {
    try {
      const input = bulkApproveTimeEntriesInputSchema.parse(req.body);
      res.json(await payrollService.bulkApproveTimeEntries(input));
    } catch (err) {
      next(err);
    }
  },
);
