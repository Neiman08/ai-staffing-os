import { Router } from "express";
import * as dashboardService from "./service";

// Dashboard summary is reachable by every authenticated role (per
// Arquitectura §4.2 "Dashboard completo" row: every role sees at least a
// partial view) — the route itself only requires authentication, but
// F6.8 made getDashboardSummary() omit each field the caller's real
// resource permission doesn't already cover (see dashboard/service.ts),
// so RBAC now applies per metric instead of per endpoint.
export const dashboardRouter = Router();

dashboardRouter.get("/summary", async (_req, res, next) => {
  try {
    res.json(await dashboardService.getDashboardSummary());
  } catch (err) {
    next(err);
  }
});

dashboardRouter.get("/audit-log", async (_req, res, next) => {
  try {
    res.json(await dashboardService.getRecentAuditLog());
  } catch (err) {
    next(err);
  }
});

dashboardRouter.get("/notifications", async (_req, res, next) => {
  try {
    res.json(await dashboardService.getNotificationsSummary());
  } catch (err) {
    next(err);
  }
});
