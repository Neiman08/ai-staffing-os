import { Router } from "express";
import {
  createDocumentInputSchema,
  paginationQuerySchema,
  verifyDocumentInputSchema,
} from "@ai-staffing-os/shared";
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

// F5.5: registra un documento (fileUrl externo — storage real sigue
// diferido, plan §7.3). Siempre nace PENDING_REVIEW.
complianceRouter.post("/documents", requirePermission("documents.create"), async (req, res, next) => {
  try {
    const input = createDocumentInputSchema.parse(req.body);
    res.status(201).json(await complianceService.createDocument(input));
  } catch (err) {
    next(err);
  }
});

// F5.5: requiere compliance.verify (no documents.update a secas) — es
// una decisión de juicio de compliance, no una edición cualquiera del
// registro. Un REJECTED acá genera automáticamente una alerta FAILED_CHECK.
complianceRouter.post(
  "/documents/:id/verify",
  requirePermission("compliance.verify"),
  async (req, res, next) => {
    try {
      const input = verifyDocumentInputSchema.parse(req.body);
      res.json(await complianceService.verifyDocument(req.params.id!, input));
    } catch (err) {
      next(err);
    }
  },
);

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

// F5.5: mismo permiso que verificar documentos — resolver una alerta es
// el mismo tipo de juicio de compliance.
complianceRouter.post(
  "/compliance/alerts/:id/resolve",
  requirePermission("compliance.verify"),
  async (req, res, next) => {
    try {
      res.json(await complianceService.resolveComplianceAlert(req.params.id!));
    } catch (err) {
      next(err);
    }
  },
);
