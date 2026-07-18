import { Router } from "express";
import {
  createDocumentInputSchema,
  paginationQuerySchema,
  verifyDocumentInputSchema,
} from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import { AppError } from "../../core/errors";
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

// F9.3: Compliance Rules -- configurar una regla es el mismo tipo de
// juicio de compliance que verificar un documento (compliance.verify).
// Leer la lista de reglas usa el mismo permiso que leer documentos.
complianceRouter.post("/compliance/rules", requirePermission("compliance.verify"), async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (typeof body.name !== "string" || body.name.length === 0) {
      throw AppError.badRequest("name is required");
    }
    if (!Array.isArray(body.requiredDocumentTypeKeys)) {
      throw AppError.badRequest("requiredDocumentTypeKeys must be an array");
    }
    res.status(201).json(
      await complianceService.createComplianceRule({
        name: body.name,
        state: (body.state as string | null | undefined) ?? null,
        industryId: (body.industryId as string | null | undefined) ?? null,
        companyId: (body.companyId as string | null | undefined) ?? null,
        jobCategoryId: (body.jobCategoryId as string | null | undefined) ?? null,
        assignmentType: (body.assignmentType as "W2" | "C1099" | null | undefined) ?? null,
        requiredDocumentTypeKeys: body.requiredDocumentTypeKeys as string[],
      }),
    );
  } catch (err) {
    next(err);
  }
});

complianceRouter.get("/compliance/rules", requirePermission("documents.view"), async (_req, res, next) => {
  try {
    res.json(await complianceService.listComplianceRules());
  } catch (err) {
    next(err);
  }
});

// F9.3: evalúa Y persiste (upsert) el resultado de las reglas para UN
// Worker en el contexto de UN JobOrder -- mismo permiso que verificar
// documentos, es un juicio de compliance.
complianceRouter.post(
  "/workers/:workerId/compliance-evaluation/:jobOrderId",
  requirePermission("compliance.verify"),
  async (req, res, next) => {
    try {
      res.status(201).json(
        await complianceService.evaluateComplianceForWorkerJobOrder(req.params.workerId!, req.params.jobOrderId!),
      );
    } catch (err) {
      next(err);
    }
  },
);

complianceRouter.get(
  "/workers/:workerId/compliance-evaluation/:jobOrderId",
  requirePermission("documents.view"),
  async (req, res, next) => {
    try {
      const record = await complianceService.getComplianceRuleEvaluation(req.params.workerId!, req.params.jobOrderId!);
      if (!record) {
        throw AppError.notFound("No compliance rule evaluation found for this worker and job order");
      }
      res.json(record);
    } catch (err) {
      next(err);
    }
  },
);
