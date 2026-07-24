import { Router } from "express";
import { z } from "zod";
import { agentTaskQuerySchema, invokeSalesAgentInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import { missionLaunchLimiter } from "../../core/rate-limiters";
import * as agentsService from "./service";
import { getMissionTimeline, getOrchestratorHealth } from "./observability";
import { pilotMissionInputSchema, createPilotMission } from "./mission-producer";
import { listPilotMissions, pausePilotMission, resumePilotMission, cancelPilotMission } from "./pilot-mission-control";

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

// F25.2 Fase 9: observabilidad -- timeline de una misión/workflow (todas
// las AgentTask + DomainEvent que comparten correlationId, ver
// observability.ts) y salud cross-tenant de la cola/outbox.
agentsRouter.get("/agents/missions/:correlationId/timeline", requirePermission("agents.view"), async (req, res, next) => {
  try {
    res.json(await getMissionTimeline(req.params.correlationId!));
  } catch (err) {
    next(err);
  }
});

agentsRouter.get("/agents/orchestrator/health", requirePermission("agents.view"), async (_req, res, next) => {
  try {
    res.json(await getOrchestratorHealth());
  } catch (err) {
    next(err);
  }
});

// F25.2 (activación controlada, Prioridad 1): productor real de
// AgentTask -- distinto de POST /missions (instrucción en lenguaje
// natural, camino de ejecución directa/viejo). Mismo rate limit que
// el camino viejo (gasta presupuesto real de discovery cuando
// dryRun=false).
agentsRouter.post("/agents/missions", missionLaunchLimiter, requirePermission("missions.create"), async (req, res, next) => {
  try {
    const input = pilotMissionInputSchema.parse(req.body);
    res.status(201).json(await createPilotMission(input));
  } catch (err) {
    next(err);
  }
});

// F25.2 (activación controlada, Prioridad 8): listado + control de
// ciclo de vida de misiones piloto -- ver pilot-mission-control.ts.
agentsRouter.get("/agents/missions", requirePermission("agents.view"), async (_req, res, next) => {
  try {
    res.json(await listPilotMissions());
  } catch (err) {
    next(err);
  }
});

const pilotMissionActionSchema = z.object({ action: z.enum(["pause", "resume", "cancel"]) });

agentsRouter.patch("/agents/missions/:id", requirePermission("missions.create"), async (req, res, next) => {
  try {
    const { action } = pilotMissionActionSchema.parse(req.body);
    const missionTaskId = req.params.id!;
    if (action === "pause") res.json(await pausePilotMission(missionTaskId));
    else if (action === "resume") res.json(await resumePilotMission(missionTaskId));
    else res.json(await cancelPilotMission(missionTaskId));
  } catch (err) {
    next(err);
  }
});
