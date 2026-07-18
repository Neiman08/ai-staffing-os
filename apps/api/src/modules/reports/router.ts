import { Router } from "express";
import * as reportsService from "./service";
import { requireInternalIdentity } from "../../core/rbac/require-permission";

/**
 * F9.11: sin `requirePermission` a nivel de ruta a propósito -- mismo
 * criterio que `dashboard/router.ts` (F6.8): la visibilidad real se
 * decide campo por campo dentro del service contra los permisos que ya
 * gatean cada recurso en su propio módulo (workers.view, documents.view,
 * assignments.view, timeEntries.view, shifts.view, incidents.view).
 * Un usuario sin ninguno de esos permisos simplemente recibe un
 * resumen vacío (solo `generatedAt`), nunca un 403 -- igual que el
 * Dashboard.
 *
 * Pre-F11 audit: verificado en vivo que el field-level omission sí
 * funciona (una identidad WORKER recibe solo `{generatedAt}`), pero esto
 * predata F10 y nunca consideró portales -- requireInternalIdentity() es
 * una segunda capa que no depende de que cada campo del service se filtre
 * correctamente, mismo criterio que dashboard/router.ts y revenue/router.ts.
 */
export const reportsRouter = Router();

reportsRouter.get("/reports/operational", requireInternalIdentity(), async (_req, res, next) => {
  try {
    res.json(await reportsService.getOperationalReport());
  } catch (err) {
    next(err);
  }
});
