import { Router } from "express";
import { createFollowUpInputSchema, followUpQuerySchema, updateFollowUpInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as followUpsService from "./service";

export const followUpsRouter = Router();

followUpsRouter.get("/follow-ups/upcoming", requirePermission("followUps.view"), async (_req, res, next) => {
  try {
    res.json(await followUpsService.listUpcomingFollowUps());
  } catch (err) {
    next(err);
  }
});

followUpsRouter.get("/follow-ups", requirePermission("followUps.view"), async (req, res, next) => {
  try {
    const query = followUpQuerySchema.parse(req.query);
    res.json(await followUpsService.listFollowUps(query));
  } catch (err) {
    next(err);
  }
});

followUpsRouter.post("/follow-ups", requirePermission("followUps.create"), async (req, res, next) => {
  try {
    const input = createFollowUpInputSchema.parse(req.body);
    res.status(201).json(await followUpsService.createFollowUp(input));
  } catch (err) {
    next(err);
  }
});

followUpsRouter.patch("/follow-ups/:id", requirePermission("followUps.update"), async (req, res, next) => {
  try {
    const input = updateFollowUpInputSchema.parse(req.body);
    res.json(await followUpsService.updateFollowUp(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});
