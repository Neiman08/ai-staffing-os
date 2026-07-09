import { Router } from "express";
import * as revenueService from "./service";

// Same reasoning as F0's dashboard router: visible to every authenticated
// role, not gated by a single resource permission (it aggregates across
// companies/leads/opportunities/followUps, each with its own view guard).
export const revenueRouter = Router();

revenueRouter.get("/revenue/summary", async (_req, res, next) => {
  try {
    res.json(await revenueService.getRevenueSummary());
  } catch (err) {
    next(err);
  }
});

revenueRouter.get("/revenue/intelligence", async (_req, res, next) => {
  try {
    res.json(await revenueService.getRevenueIntelligence());
  } catch (err) {
    next(err);
  }
});
