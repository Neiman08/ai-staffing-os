import { Router } from "express";
import * as revenueService from "./service";
import { requireInternalIdentity } from "../../core/rbac/require-permission";

// Pre-F11 audit finding (P1, confirmed live): the comment this router used
// to carry ("each with its own view guard") was aspirational, not real —
// revenue/service.ts has no permission or ownership check at all, so this
// predates-F10 "visible to every authenticated role" design actually meant
// visible to every authenticated identity, portals included. Confirmed via
// dev-bypass as a WORKER/CANDIDATE/CLIENT_ADMIN: full internal pipeline
// value and named company/opportunity revenue came back. requireInternalIdentity()
// keeps every internal role's existing access unchanged and refuses portal
// identities before the service ever runs.
export const revenueRouter = Router();

revenueRouter.get("/revenue/summary", requireInternalIdentity(), async (_req, res, next) => {
  try {
    res.json(await revenueService.getRevenueSummary());
  } catch (err) {
    next(err);
  }
});

revenueRouter.get("/revenue/intelligence", requireInternalIdentity(), async (_req, res, next) => {
  try {
    res.json(await revenueService.getRevenueIntelligence());
  } catch (err) {
    next(err);
  }
});
