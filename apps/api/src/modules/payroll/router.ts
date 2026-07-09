import { Router } from "express";
import { paginationQuerySchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as payrollService from "./service";

export const payrollRouter = Router();

payrollRouter.get("/time-entries", requirePermission("timeEntries.view"), async (req, res, next) => {
  try {
    const query = paginationQuerySchema.parse(req.query);
    res.json(await payrollService.listTimeEntries(query));
  } catch (err) {
    next(err);
  }
});
