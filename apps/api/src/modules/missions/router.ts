import { Router } from "express";
import { launchMissionInputSchema, missionActionInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as missionsService from "./service";

export const missionsRouter = Router();

missionsRouter.post("/missions", requirePermission("missions.create"), async (req, res, next) => {
  try {
    const input = launchMissionInputSchema.parse(req.body);
    res.status(201).json(await missionsService.createMission(input.instruction));
  } catch (err) {
    next(err);
  }
});

// F7.2: modo solo-planificación — interpreta + arma el Mission Plan,
// nunca ejecuta ninguna herramienta externa. Mismo permiso que crear una
// misión real (missions.create) — sigue siendo "crear una misión", solo
// que en un modo que no gasta ni escribe nada fuera de este AgentTask.
missionsRouter.post("/missions/plan", requirePermission("missions.create"), async (req, res, next) => {
  try {
    const input = launchMissionInputSchema.parse(req.body);
    res.status(201).json(await missionsService.createMissionPlan(input.instruction));
  } catch (err) {
    next(err);
  }
});

missionsRouter.get("/missions", requirePermission("missions.view"), async (_req, res, next) => {
  try {
    res.json(await missionsService.listMissions());
  } catch (err) {
    next(err);
  }
});

missionsRouter.get("/missions/:id", requirePermission("missions.view"), async (req, res, next) => {
  try {
    res.json(await missionsService.getMissionDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

missionsRouter.patch("/missions/:id", requirePermission("missions.update"), async (req, res, next) => {
  try {
    const input = missionActionInputSchema.parse(req.body);
    res.json(await missionsService.decideMissionAction(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});
