import { Router } from "express";
import { importCompaniesInputSchema, processCompanyPipelineInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as prospectingService from "./service";

export const prospectingRouter = Router();

// F3 §4/§11: importar es carga de datos (sin IA) — mismo permiso que
// crear una Company a mano.
prospectingRouter.post("/prospecting/import", requirePermission("companies.create"), async (req, res, next) => {
  try {
    const input = importCompaniesInputSchema.parse(req.body);
    res.status(201).json(await prospectingService.importCompanies(input));
  } catch (err) {
    next(err);
  }
});

// "Analizar ahora" — dispara processCompanyPipeline para una empresa puntual.
prospectingRouter.post("/prospecting/tasks", requirePermission("agents.execute"), async (req, res, next) => {
  try {
    const input = processCompanyPipelineInputSchema.parse(req.body);
    res.status(202).json(await prospectingService.triggerCompanyPipeline(input));
  } catch (err) {
    next(err);
  }
});
