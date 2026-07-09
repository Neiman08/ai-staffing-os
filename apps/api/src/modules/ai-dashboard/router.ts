import { Router } from "express";
import { requirePermission } from "../../core/rbac/require-permission";
import * as aiDashboardService from "./service";

export const aiDashboardRouter = Router();

aiDashboardRouter.get("/ai-dashboard/summary", requirePermission("agents.view"), async (_req, res, next) => {
  try {
    res.json(await aiDashboardService.getAiDashboardSummary());
  } catch (err) {
    next(err);
  }
});
