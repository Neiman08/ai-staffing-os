import { Router } from "express";
import { requireInternalIdentity } from "../../core/rbac/require-permission";
import * as analyticsService from "./service";

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
