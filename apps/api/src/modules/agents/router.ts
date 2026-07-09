import { Router } from "express";
import { requirePermission } from "../../core/rbac/require-permission";
import * as agentsService from "./service";

/**
 * DESVIACIÓN DOCUMENTADA: 02_F0_PROMPT.md (Paso 1) no lista un módulo
 * `agents` en apps/api/src/modules, pero el Paso 8 exige que AgentsCenter
 * muestre datos reales de las 3 AgentInstance sembradas, y el DoD exige que
 * las 9 páginas naveguen con datos reales. Sin este módulo esa página no
 * tendría fuente de datos. Es de solo lectura (sin ejecución de agentes,
 * sin OpenAI) — no viola "Fuera de alcance en F0".
 */
export const agentsRouter = Router();

agentsRouter.get("/agents", requirePermission("agents.view"), async (_req, res, next) => {
  try {
    res.json(await agentsService.listAgentInstances());
  } catch (err) {
    next(err);
  }
});
