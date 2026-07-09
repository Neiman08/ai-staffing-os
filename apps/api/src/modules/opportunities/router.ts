import { Router } from "express";
import {
  createOpportunityInputSchema,
  opportunityQuerySchema,
  updateOpportunityInputSchema,
  updateOpportunityStageInputSchema,
} from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as opportunitiesService from "./service";

export const opportunitiesRouter = Router();

opportunitiesRouter.get("/pipeline", requirePermission("opportunities.view"), async (_req, res, next) => {
  try {
    res.json(await opportunitiesService.getPipeline());
  } catch (err) {
    next(err);
  }
});

opportunitiesRouter.get("/opportunities", requirePermission("opportunities.view"), async (req, res, next) => {
  try {
    const query = opportunityQuerySchema.parse(req.query);
    res.json(await opportunitiesService.listOpportunities(query));
  } catch (err) {
    next(err);
  }
});

opportunitiesRouter.post("/opportunities", requirePermission("opportunities.create"), async (req, res, next) => {
  try {
    const input = createOpportunityInputSchema.parse(req.body);
    res.status(201).json(await opportunitiesService.createOpportunity(input));
  } catch (err) {
    next(err);
  }
});

opportunitiesRouter.get("/opportunities/:id", requirePermission("opportunities.view"), async (req, res, next) => {
  try {
    res.json(await opportunitiesService.getOpportunityDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

opportunitiesRouter.patch(
  "/opportunities/:id",
  requirePermission("opportunities.update"),
  async (req, res, next) => {
    try {
      const input = updateOpportunityInputSchema.parse(req.body);
      res.json(await opportunitiesService.updateOpportunity(req.params.id!, input));
    } catch (err) {
      next(err);
    }
  },
);

opportunitiesRouter.patch(
  "/opportunities/:id/stage",
  requirePermission("opportunities.update"),
  async (req, res, next) => {
    try {
      const { stage } = updateOpportunityStageInputSchema.parse(req.body);
      res.json(await opportunitiesService.updateOpportunityStage(req.params.id!, stage));
    } catch (err) {
      next(err);
    }
  },
);
