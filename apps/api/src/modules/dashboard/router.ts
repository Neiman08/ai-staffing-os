import { Router } from "express";
import * as dashboardService from "./service";

// Dashboard summary is visible to every authenticated role (per Arquitectura
// §4.2 "Dashboard completo" row: every role sees at least a partial view;
// F0 does not implement per-widget filtering, so it is gated only by
// authentication, not by a specific resource permission).
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
