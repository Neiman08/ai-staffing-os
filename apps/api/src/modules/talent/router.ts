import { Router } from "express";
import { paginationQuerySchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as talentService from "./service";

export const talentRouter = Router();

talentRouter.get("/candidates", requirePermission("candidates.view"), async (req, res, next) => {
  try {
    const query = paginationQuerySchema.parse(req.query);
    res.json(await talentService.listCandidates(query));
  } catch (err) {
    next(err);
  }
});

talentRouter.get("/industries", requirePermission("candidates.view"), async (_req, res, next) => {
  try {
    res.json(await talentService.listIndustries());
  } catch (err) {
    next(err);
  }
});

talentRouter.get("/job-categories", requirePermission("candidates.view"), async (_req, res, next) => {
  try {
    res.json(await talentService.listJobCategories());
  } catch (err) {
    next(err);
  }
});
