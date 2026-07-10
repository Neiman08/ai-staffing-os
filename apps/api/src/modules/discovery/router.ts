import { Router } from "express";
import { discoverySummaryQuerySchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as discoveryService from "./service";

export const discoveryRouter = Router();

discoveryRouter.get("/discovery/summary", requirePermission("agents.view"), async (req, res, next) => {
  try {
    const query = discoverySummaryQuerySchema.parse(req.query);
    res.json(await discoveryService.getDiscoverySummary(query.missionId));
  } catch (err) {
    next(err);
  }
});
