import { Router } from "express";
import { paginationQuerySchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as crmService from "./service";

export const crmRouter = Router();

crmRouter.get("/companies", requirePermission("companies.view"), async (req, res, next) => {
  try {
    const query = paginationQuerySchema.parse(req.query);
    res.json(await crmService.listCompanies(query));
  } catch (err) {
    next(err);
  }
});
