import { Router } from "express";
import { paginationQuerySchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as complianceService from "./service";

export const complianceRouter = Router();

complianceRouter.get("/documents", requirePermission("documents.view"), async (req, res, next) => {
  try {
    const query = paginationQuerySchema.parse(req.query);
    res.json(await complianceService.listDocuments(query));
  } catch (err) {
    next(err);
  }
});

complianceRouter.get(
  "/compliance/alerts",
  requirePermission("documents.view"),
  async (req, res, next) => {
    try {
      const query = paginationQuerySchema.parse(req.query);
      res.json(await complianceService.listComplianceAlerts(query));
    } catch (err) {
      next(err);
    }
  },
);

complianceRouter.get(
  "/compliance/document-types",
  requirePermission("documents.view"),
  async (_req, res, next) => {
    try {
      res.json(await complianceService.listDocumentTypes());
    } catch (err) {
      next(err);
    }
  },
);
