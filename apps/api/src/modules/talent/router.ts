import { Router } from "express";
import { paginationQuerySchema } from "@ai-staffing-os/shared";
import { requirePermission, requireAnyPermission } from "../../core/rbac/require-permission";
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

// F5.1: catálogos de referencia compartidos (Candidates Y Job Orders los
// usan) — requireAnyPermission en vez de requirePermission("candidates.view")
// a secas, para que Operations (jobOrders.create, sin candidates.view)
// pueda poblar el selector de categoría al crear un Job Order.
talentRouter.get(
  "/industries",
  requireAnyPermission(["candidates.view", "jobOrders.view"]),
  async (_req, res, next) => {
    try {
      res.json(await talentService.listIndustries());
    } catch (err) {
      next(err);
    }
  },
);

talentRouter.get(
  "/job-categories",
  requireAnyPermission(["candidates.view", "jobOrders.view"]),
  async (_req, res, next) => {
    try {
      res.json(await talentService.listJobCategories());
    } catch (err) {
      next(err);
    }
  },
);
