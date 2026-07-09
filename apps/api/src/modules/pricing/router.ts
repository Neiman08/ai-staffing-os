import { Router } from "express";
import { paginationQuerySchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as pricingService from "./service";

export const pricingRouter = Router();

pricingRouter.get(
  "/pricing/scenarios",
  requirePermission("pricingScenarios.view"),
  async (req, res, next) => {
    try {
      const query = paginationQuerySchema.parse(req.query);
      res.json(await pricingService.listPricingScenarios(query));
    } catch (err) {
      next(err);
    }
  },
);
