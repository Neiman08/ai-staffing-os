import { Router } from "express";
import { analyticsPeriodQuerySchema } from "@ai-staffing-os/shared";
import { requireInternalIdentity } from "../../core/rbac/require-permission";
import { exportLimiter } from "../../core/rate-limiters";
import * as analyticsService from "./service";
import * as recruitingService from "./recruiting.service";
import * as commercialService from "./commercial.service";
import * as financialService from "./financial.service";

// F11.3: mismo criterio que dashboard/router.ts y reports/router.ts --
// sin un solo permiso de ruta (el executive dashboard es, por diseño,
// visible a cualquier rol interno; la visibilidad real por dominio se
// decide campo por campo dentro del service). requireInternalIdentity()
// (agregado en la auditoría pre-F11) es la única gate de ruta: ninguna
// identidad de portal puede alcanzar este agregado cross-dominio.
export const analyticsRouter = Router();

analyticsRouter.get("/analytics/executive", requireInternalIdentity(), async (_req, res, next) => {
  try {
    res.json(await analyticsService.getExecutiveDashboard());
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get("/analytics/recruiting", requireInternalIdentity(), async (req, res, next) => {
  try {
    const query = analyticsPeriodQuerySchema.parse(req.query);
    res.json(await recruitingService.getRecruitingMetrics(query));
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get("/analytics/commercial", requireInternalIdentity(), async (req, res, next) => {
  try {
    const query = analyticsPeriodQuerySchema.parse(req.query);
    res.json(await commercialService.getCommercialMetrics(query));
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get("/analytics/financial", requireInternalIdentity(), async (req, res, next) => {
  try {
    const query = analyticsPeriodQuerySchema.parse(req.query);
    res.json(await financialService.getFinancialMetrics(query));
  } catch (err) {
    next(err);
  }
});

// F11.8: mismo patrón de descarga que payroll/router.ts (F5.7) --
// Content-Disposition: attachment, text/csv, CSV devuelto directo en la
// respuesta, sin storage. Mismos filtros from/to que la versión JSON, y
// mismo criterio de RBAC de campo (nunca 403 -- un caller sin permiso
// descarga un CSV con solo el header).
analyticsRouter.get("/analytics/recruiting/export", exportLimiter, requireInternalIdentity(), async (req, res, next) => {
  try {
    const query = analyticsPeriodQuerySchema.parse(req.query);
    const { csv, filename } = await recruitingService.exportRecruitingMetricsCsv(query);
    res.status(200).header("Content-Disposition", `attachment; filename="${filename}"`).type("text/csv").send(csv);
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get("/analytics/commercial/export", exportLimiter, requireInternalIdentity(), async (req, res, next) => {
  try {
    const query = analyticsPeriodQuerySchema.parse(req.query);
    const { csv, filename } = await commercialService.exportCommercialMetricsCsv(query);
    res.status(200).header("Content-Disposition", `attachment; filename="${filename}"`).type("text/csv").send(csv);
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get("/analytics/financial/export", exportLimiter, requireInternalIdentity(), async (req, res, next) => {
  try {
    const query = analyticsPeriodQuerySchema.parse(req.query);
    const { csv, filename } = await financialService.exportFinancialMetricsCsv(query);
    res.status(200).header("Content-Disposition", `attachment; filename="${filename}"`).type("text/csv").send(csv);
  } catch (err) {
    next(err);
  }
});
