import { Router } from "express";
import { runMatchingInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as matchingService from "./service";

// F6.6: módulo propio (Convención B, plan §12.1) — nunca reutiliza la
// ruta genérica POST /agents/:key/tasks (esa sigue gateada por el
// permiso especial único agents.execute, compartido por los 9 agentes
// ya graduados). matching.run/matching.view son permisos dedicados,
// aprobados explícitamente en F6.1.
export const matchingRouter = Router();

matchingRouter.post("/job-orders/:id/matching/run", requirePermission("matching.run"), async (req, res, next) => {
  try {
    const input = runMatchingInputSchema.parse(req.body ?? {});
    res.json(await matchingService.runMatchingForJobOrder(req.params.id!, input.withLlm));
  } catch (err) {
    next(err);
  }
});

matchingRouter.get("/job-orders/:id/matching/latest", requirePermission("matching.view"), async (req, res, next) => {
  try {
    res.json(await matchingService.getLatestMatchingRun(req.params.id!));
  } catch (err) {
    next(err);
  }
});

matchingRouter.get("/job-orders/:id/matching/history", requirePermission("matching.view"), async (req, res, next) => {
  try {
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    res.json(await matchingService.getMatchingHistory(req.params.id!, { cursor, limit }));
  } catch (err) {
    next(err);
  }
});
