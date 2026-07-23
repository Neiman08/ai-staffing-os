import { Router } from "express";
import { z } from "zod";
import { HUMAN_REVIEW_TYPES, HUMAN_REVIEW_PRIORITIES } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import * as humanReviewService from "./service";

/**
 * F25.2 Fase 5: endpoints mínimos del Human Review Center -- lista,
 * detalle, crear (usado por agentes/otros módulos, no por humanos vía
 * UI todavía) y resolver. La UI (apps/web) queda fuera de alcance de
 * esta fase (ver el reporte final) -- estos son los mismos endpoints
 * reales que esa UI futura consumiría, sin bloquear su construcción.
 */
export const humanReviewRouter = Router();

const listQuerySchema = z.object({
  status: z.enum(["OPEN", "RESOLVED"]).optional(),
  priority: z.enum(HUMAN_REVIEW_PRIORITIES).optional(),
});

const createBodySchema = z.object({
  type: z.enum(HUMAN_REVIEW_TYPES),
  priority: z.enum(HUMAN_REVIEW_PRIORITIES),
  deadline: z.string().datetime().nullish(),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  summary: z.string().min(1),
  evidence: z.array(z.record(z.string(), z.unknown())),
  requestedDecision: z.string().min(1),
  options: z.array(z.object({ label: z.string().min(1), consequence: z.string().min(1) })),
  recommendation: z.string().nullish(),
  impact: z.string().min(1),
  correlationId: z.string().min(1),
});

const resolveBodySchema = z.object({
  resolution: z.string().min(1),
});

humanReviewRouter.get("/human-review", requirePermission("agents.view"), async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    res.json(await humanReviewService.listHumanReviewRequests(query));
  } catch (err) {
    next(err);
  }
});

humanReviewRouter.get("/human-review/:id", requirePermission("agents.view"), async (req, res, next) => {
  try {
    res.json(await humanReviewService.getHumanReviewRequest(req.params.id!));
  } catch (err) {
    next(err);
  }
});

humanReviewRouter.post("/human-review", requirePermission("agents.execute"), async (req, res, next) => {
  try {
    const body = createBodySchema.parse(req.body);
    const result = await humanReviewService.createOrMergeHumanReviewRequest({
      ...body,
      deadline: body.deadline ? new Date(body.deadline) : null,
      recommendation: body.recommendation ?? null,
    });
    res.status(result.merged ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

humanReviewRouter.post("/human-review/:id/resolve", requirePermission("agents.execute"), async (req, res, next) => {
  try {
    const ctx = getTenancyContext();
    if (!ctx) throw AppError.unauthorized();
    const body = resolveBodySchema.parse(req.body);
    res.json(await humanReviewService.resolveHumanReviewRequest(req.params.id!, ctx.userId, body.resolution));
  } catch (err) {
    next(err);
  }
});
