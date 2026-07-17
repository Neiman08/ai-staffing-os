import { Router } from "express";
import {
  candidateQuerySchema,
  convertCandidateToWorkerInputSchema,
  createCandidateInputSchema,
  updateCandidateInputSchema,
  updateCandidateStatusInputSchema,
} from "@ai-staffing-os/shared";
import { requirePermission, requireAllPermissions, requireAnyPermission } from "../../core/rbac/require-permission";
import * as talentService from "./service";

export const talentRouter = Router();

talentRouter.get("/candidates", requirePermission("candidates.view"), async (req, res, next) => {
  try {
    const query = candidateQuerySchema.parse(req.query);
    res.json(await talentService.listCandidates(query));
  } catch (err) {
    next(err);
  }
});

talentRouter.get("/candidates/:id", requirePermission("candidates.view"), async (req, res, next) => {
  try {
    res.json(await talentService.getCandidateDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

talentRouter.post("/candidates", requirePermission("candidates.create"), async (req, res, next) => {
  try {
    const input = createCandidateInputSchema.parse(req.body);
    res.status(201).json(await talentService.createCandidate(input));
  } catch (err) {
    next(err);
  }
});

// F5.2: nunca permite tocar status/createdById/tenantId/aiSummary/aiScore —
// updateCandidateInputSchema ni siquiera los declara.
talentRouter.patch("/candidates/:id", requirePermission("candidates.update"), async (req, res, next) => {
  try {
    const input = updateCandidateInputSchema.parse(req.body);
    res.json(await talentService.updateCandidate(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

// F5.2: único camino para cambiar el estado (incl. reapertura REJECTED/
// INACTIVE → NEW) — nunca puede establecer PLACED (ver service.ts).
talentRouter.patch("/candidates/:id/status", requirePermission("candidates.update"), async (req, res, next) => {
  try {
    const input = updateCandidateStatusInputSchema.parse(req.body);
    res.json(await talentService.updateCandidateStatus(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

// F5.2 (aprobado por el PO): requiere candidates.update Y workers.create a
// la vez — hoy solo CEO/Admin, deliberadamente distinto de quien puede
// crear/editar Candidates (Recruiter). Ver auditoría F5.2 punto 2.
talentRouter.post(
  "/candidates/:id/convert-to-worker",
  requireAllPermissions(["candidates.update", "workers.create"]),
  async (req, res, next) => {
    try {
      const input = convertCandidateToWorkerInputSchema.parse(req.body);
      res.status(201).json(await talentService.convertCandidateToWorker(req.params.id!, input));
    } catch (err) {
      next(err);
    }
  },
);

// F5.1: catálogos de referencia compartidos (Candidates Y Job Orders los
// usan) — requireAnyPermission en vez de requirePermission("candidates.view")
// a secas, para que Operations (jobOrders.create, sin candidates.view)
// pueda poblar el selector de categoría al crear un Job Order.
talentRouter.get(
  "/industries",
  requireAnyPermission(["candidates.view", "jobOrders.view"]),
  async (_req, res, next) => {
    try {
      res.json(await talentService.listIndustries());
    } catch (err) {
      next(err);
    }
  },
);

talentRouter.get(
  "/job-categories",
  requireAnyPermission(["candidates.view", "jobOrders.view"]),
  async (_req, res, next) => {
    try {
      res.json(await talentService.listJobCategories());
    } catch (err) {
      next(err);
    }
  },
);

// F8.2: Job Requirements and Qualification Rules -- SOLO evalúa, nunca
// cambia Candidate.status ni crea nada. Requiere ambos permisos porque
// lee tanto Candidate como JobOrder.
talentRouter.get(
  "/candidates/:id/qualification/:jobOrderId",
  requireAllPermissions(["candidates.view", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.json(await talentService.evaluateCandidateQualificationForJobOrder(req.params.id!, req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);

// F8.3: Candidate Sourcing -- SOLO lee del pool de Candidate ya
// existente en el tenant, nunca contacta a nadie ni crea nada.
talentRouter.get(
  "/job-orders/:jobOrderId/source-candidates",
  requireAllPermissions(["candidates.view", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.json(await talentService.sourceCandidatesForJobOrder(req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);
