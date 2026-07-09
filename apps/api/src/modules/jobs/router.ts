import { Router } from "express";
import { paginationQuerySchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as jobsService from "./service";

export const jobsRouter = Router();

jobsRouter.get("/job-orders", requirePermission("jobOrders.view"), async (req, res, next) => {
  try {
    const query = paginationQuerySchema.parse(req.query);
    res.json(await jobsService.listJobOrders(query));
  } catch (err) {
    next(err);
  }
});
