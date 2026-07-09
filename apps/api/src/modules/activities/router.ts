import { Router } from "express";
import { activityQuerySchema, createActivityInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as activitiesService from "./service";

export const activitiesRouter = Router();

activitiesRouter.get("/activities", requirePermission("companies.view"), async (req, res, next) => {
  try {
    const query = activityQuerySchema.parse(req.query);
    res.json(await activitiesService.listActivities(query));
  } catch (err) {
    next(err);
  }
});

activitiesRouter.post("/activities", requirePermission("companies.update"), async (req, res, next) => {
  try {
    const input = createActivityInputSchema.parse(req.body);
    res.status(201).json(await activitiesService.createManualActivity(input));
  } catch (err) {
    next(err);
  }
});
