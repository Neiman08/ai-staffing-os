import { Router } from "express";
import * as reportsService from "./service";

/**
 * F9.11: sin `requirePermission` a nivel de ruta a propósito -- mismo
 * criterio que `dashboard/router.ts` (F6.8): la visibilidad real se
 * decide campo por campo dentro del service contra los permisos que ya
 * gatean cada recurso en su propio módulo (workers.view, documents.view,
 * assignments.view, timeEntries.view, shifts.view, incidents.view).
 * Un usuario sin ninguno de esos permisos simplemente recibe un
 * resumen vacío (solo `generatedAt`), nunca un 403 -- igual que el
 * Dashboard.
 */
export const reportsRouter = Router();

reportsRouter.get("/reports/operational", async (_req, res, next) => {
  try {
    res.json(await reportsService.getOperationalReport());
  } catch (err) {
    next(err);
  }
});
