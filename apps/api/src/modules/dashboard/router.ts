import { Router } from "express";
import * as dashboardService from "./service";
import { requireInternalIdentity } from "../../core/rbac/require-permission";

// Dashboard summary is reachable by every authenticated INTERNAL role (per
// Arquitectura §4.2 "Dashboard completo" row: every role sees at least a
// partial view) — the route itself only requires authentication, but
// F6.8 made getDashboardSummary() omit each field the caller's real
// resource permission doesn't already cover (see dashboard/service.ts),
// so RBAC now applies per metric instead of per endpoint.
//
// Pre-F11 audit finding (P1, confirmed live): this predates F10's portal
// roles, so none of these three routes ever excluded them. /summary and
// (per F9.11) the sibling /reports/operational already come back empty for
// a portal identity thanks to F6.8's field-level omission, but /audit-log
// has no such filtering — it returns the tenant's full internal AuditLog,
// unfiltered, to any authenticated caller. requireInternalIdentity() closes
// that gap for all three at the route layer, so none of them depend solely
// on a service happening to filter every field correctly.
export const dashboardRouter = Router();

dashboardRouter.get("/summary", requireInternalIdentity(), async (_req, res, next) => {
  try {
    res.json(await dashboardService.getDashboardSummary());
  } catch (err) {
    next(err);
  }
});

dashboardRouter.get("/audit-log", requireInternalIdentity(), async (_req, res, next) => {
  try {
    res.json(await dashboardService.getRecentAuditLog());
  } catch (err) {
    next(err);
  }
});

dashboardRouter.get("/notifications", requireInternalIdentity(), async (_req, res, next) => {
  try {
    res.json(await dashboardService.getNotificationsSummary());
  } catch (err) {
    next(err);
  }
});
