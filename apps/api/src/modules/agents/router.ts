import { Router } from "express";
import { agentTaskQuerySchema, invokeSalesAgentInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as agentsService from "./service";

/**
 * DESVIACIÓN DOCUMENTADA: 02_F0_PROMPT.md (Paso 1) no lista un módulo
 * `agents` en apps/api/src/modules, pero el Paso 8 exige que AgentsCenter
 * muestre datos reales de las 3 AgentInstance sembradas, y el DoD exige que
 * las 9 páginas naveguen con datos reales. Sin este módulo esa página no
 * tendría fuente de datos. En F0 era de solo lectura; F2 agrega invocación
 * real del Sales Agent (ver F2 plan §12).
 */
export const agentsRouter = Router();

agentsRouter.get("/agents", requirePermission("agents.view"), async (_req, res, next) => {
  try {
    res.json(await agentsService.listAgentInstances());
  } catch (err) {
    next(err);
  }
});

// F2: invoke a Sales Agent task. Returns immediately (202) with the QUEUED
// task — execution happens in-process, asynchronously; the frontend polls
// GET /agents/tasks/:id (F2 §2's async-without-a-queue decision).
agentsRouter.post("/agents/sales/tasks", requirePermission("agents.execute"), async (req, res, next) => {
  try {
    const input = invokeSalesAgentInputSchema.parse(req.body);
    res.status(202).json(await agentsService.invokeSalesAgentTask(input));
  } catch (err) {
    next(err);
  }
});

agentsRouter.get("/agents/tasks", requirePermission("agents.view"), async (req, res, next) => {
  try {
    const query = agentTaskQuerySchema.parse(req.query);
    res.json(await agentsService.listAgentTasks(query));
  } catch (err) {
    next(err);
  }
});

agentsRouter.get("/agents/tasks/:id", requirePermission("agents.view"), async (req, res, next) => {
  try {
    res.json(await agentsService.getAgentTaskDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});
