import { Router } from "express";
import { runInternalAcceptanceTestInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import { runInternalAcceptanceTest } from "./service";

/**
 * F27 (Internal Acceptance Test) -- único endpoint de todo este módulo,
 * a propósito: no expone ninguna variante que acepte companyId/leadId/
 * contactId existentes (siempre crea entidades nuevas, marcadas
 * INTERNAL_TEST), y no acepta ningún parámetro que pueda alterar el
 * comportamiento de evaluateDraftCreationGate/resolveBestContactChannel
 * para una Company/Contact real -- ver comentario extendido en
 * service.ts sobre por qué esto es seguro por diseño.
 */
export const internalTestingRouter = Router();

internalTestingRouter.post("/internal-tests/acceptance", requirePermission("internalTests.run"), async (req, res, next) => {
  try {
    const input = runInternalAcceptanceTestInputSchema.parse(req.body);
    res.status(201).json(await runInternalAcceptanceTest(input));
  } catch (err) {
    next(err);
  }
});
