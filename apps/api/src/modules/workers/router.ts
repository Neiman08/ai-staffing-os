import { Router } from "express";
import { requirePermission } from "../../core/rbac/require-permission";
import * as workersService from "./service";

// F5.2: módulo mínimo aprobado — únicamente GET /workers/:id, para
// verificar que la conversión desde Candidate funcionó. Listado, edición,
// filtros y disponibilidad quedan para el bloque siguiente.
export const workersRouter = Router();

workersRouter.get("/workers/:id", requirePermission("workers.view"), async (req, res, next) => {
  try {
    res.json(await workersService.getWorkerDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});
