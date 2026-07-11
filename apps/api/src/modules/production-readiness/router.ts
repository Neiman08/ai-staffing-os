import { Router } from "express";
import { requirePermission } from "../../core/rbac/require-permission";
import { generateProductionAudit } from "./audit";
import { generateCleanupPlan } from "./cleanup-plan";
import { generateDuplicatesReport } from "./duplicates";
import { generateMergePlans } from "./merge-plan";
import { generateProductionReadinessSummary } from "./summary";

export const productionReadinessRouter = Router();

// F4.7.5: solo lectura, nunca escribe nada — gateado por settings.manage
// (mismo permiso que ya protege configuración de tenant/roles), no se
// crea una permission key nueva.
productionReadinessRouter.get("/production-readiness/audit", requirePermission("settings.manage"), async (_req, res, next) => {
  try {
    res.json(await generateProductionAudit());
  } catch (err) {
    next(err);
  }
});

productionReadinessRouter.get("/production-readiness/cleanup-plan", requirePermission("settings.manage"), async (_req, res, next) => {
  try {
    res.json(await generateCleanupPlan());
  } catch (err) {
    next(err);
  }
});

productionReadinessRouter.get("/production-readiness/duplicates", requirePermission("settings.manage"), async (_req, res, next) => {
  try {
    res.json(await generateDuplicatesReport());
  } catch (err) {
    next(err);
  }
});

productionReadinessRouter.get("/production-readiness/merge-plan", requirePermission("settings.manage"), async (_req, res, next) => {
  try {
    res.json(await generateMergePlans());
  } catch (err) {
    next(err);
  }
});

productionReadinessRouter.get("/production-readiness/summary", requirePermission("settings.manage"), async (_req, res, next) => {
  try {
    res.json(await generateProductionReadinessSummary());
  } catch (err) {
    next(err);
  }
});
