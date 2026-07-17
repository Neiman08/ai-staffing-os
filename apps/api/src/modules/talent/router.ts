import { Router } from "express";
import {
  candidateQuerySchema,
  convertCandidateToWorkerInputSchema,
  createCandidateInputSchema,
  updateCandidateInputSchema,
  updateCandidateStatusInputSchema,
} from "@ai-staffing-os/shared";
import { requirePermission, requireAllPermissions, requireAnyPermission } from "../../core/rbac/require-permission";
import { AppError } from "../../core/errors";
import { isShortlistReviewStatus } from "../recruiting-intelligence/candidate-shortlist";
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

// F8.5: Estados de calificación con razones auditables -- POST evalúa Y
// persiste (upsert) el estado de 4 valores; requiere update (no solo
// view) porque escribe un registro nuevo. GET solo lee lo ya persistido,
// sin re-evaluar -- nunca crea nada si no se evaluó antes.
talentRouter.post(
  "/candidates/:id/qualification/:jobOrderId",
  requireAllPermissions(["candidates.update", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.status(201).json(await talentService.persistCandidateQualification(req.params.id!, req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);

talentRouter.get(
  "/candidates/:id/qualification/:jobOrderId/status",
  requireAllPermissions(["candidates.view", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      const record = await talentService.getCandidateQualification(req.params.id!, req.params.jobOrderId!);
      if (!record) throw AppError.notFound("No persisted qualification found for this candidate and job order");
      res.json(record);
    } catch (err) {
      next(err);
    }
  },
);

// F8.6: Matching and Ranking -- POST calcula Y persiste (upsert) el
// ranking completo; requiere update porque escribe. GET solo lee lo ya
// persistido, sin recalcular.
talentRouter.post(
  "/job-orders/:jobOrderId/matching",
  requireAllPermissions(["candidates.update", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.status(201).json(await talentService.computeAndPersistCandidateMatching(req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);

talentRouter.get(
  "/job-orders/:jobOrderId/matching",
  requireAllPermissions(["candidates.view", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.json(await talentService.getPersistedCandidateMatching(req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);

// F8.7: Candidate Shortlist -- POST genera/refresca desde el ranking YA
// persistido de F8.6 (requiere update porque escribe); GET solo lee.
talentRouter.post(
  "/job-orders/:jobOrderId/shortlist",
  requireAllPermissions(["candidates.update", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.status(201).json(await talentService.generateShortlistForJobOrder(req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);

talentRouter.get(
  "/job-orders/:jobOrderId/shortlist",
  requireAllPermissions(["candidates.view", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.json(await talentService.getShortlistForJobOrder(req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);

// F8.7: único camino para cambiar el reviewStatus de una entrada de
// shortlist -- valida la transición antes de escribir (ver
// candidate-shortlist.ts), nunca contacta a nadie, nunca es un rechazo
// permanente (REMOVED siempre puede reabrirse a DRAFT).
talentRouter.patch("/shortlist/:entryId/review-status", requirePermission("candidates.update"), async (req, res, next) => {
  try {
    const { reviewStatus } = req.body as { reviewStatus?: unknown };
    if (!isShortlistReviewStatus(reviewStatus)) {
      throw AppError.badRequest("Invalid reviewStatus", {
        allowed: ["DRAFT", "READY_FOR_REVIEW", "APPROVED", "HOLD", "REMOVED"],
      });
    }
    res.json(await talentService.updateShortlistEntryReviewStatus(req.params.entryId!, reviewStatus));
  } catch (err) {
    next(err);
  }
});

// F8.8: Screening Intelligence -- POST genera Y persiste (upsert) el
// plan; requiere update porque escribe. GET solo lee, nunca regenera.
// Nunca entrevista, nunca contacta al candidato.
talentRouter.post(
  "/candidates/:id/screening-plan/:jobOrderId",
  requireAllPermissions(["candidates.update", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.status(201).json(await talentService.generateAndPersistScreeningPlan(req.params.id!, req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);

talentRouter.get(
  "/candidates/:id/screening-plan/:jobOrderId",
  requireAllPermissions(["candidates.view", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      const record = await talentService.getScreeningPlan(req.params.id!, req.params.jobOrderId!);
      if (!record) throw AppError.notFound("No persisted screening plan found for this candidate and job order");
      res.json(record);
    } catch (err) {
      next(err);
    }
  },
);

const INTERVIEW_MODALITIES = new Set(["PHONE", "VIDEO", "IN_PERSON"]);
const INTERVIEW_PREVIEW_STATUSES = new Set(["DRAFT", "NEEDS_AVAILABILITY", "READY_FOR_APPROVAL", "APPROVED_FOR_SEND", "CANCELLED"]);

/**
 * F8.9: validación mínima de runtime del body (mismo criterio ligero
 * que el type guard de F8.7) -- las ventanas propuestas y participantes
 * son SIEMPRE input humano, nunca inventados, así que acá solo se
 * verifica el SHAPE, nunca se completa un valor faltante.
 */
function parseCreateInterviewPreviewInput(body: unknown): talentService.CreateInterviewPreviewInput {
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b?.proposedWindows) || !b.proposedWindows.every((w) => w && typeof w === "object" && "start" in w && "end" in w)) {
    throw AppError.badRequest("proposedWindows must be an array of { start, end }");
  }
  if (typeof b.durationMinutes !== "number" || b.durationMinutes <= 0) {
    throw AppError.badRequest("durationMinutes must be a positive number");
  }
  if (typeof b.timezone !== "string" || b.timezone.length === 0) {
    throw AppError.badRequest("timezone is required");
  }
  if (typeof b.modality !== "string" || !INTERVIEW_MODALITIES.has(b.modality)) {
    throw AppError.badRequest("modality must be one of PHONE, VIDEO, IN_PERSON");
  }
  if (!Array.isArray(b.participants) || !b.participants.every((p) => p && typeof p === "object" && "role" in p && "name" in p)) {
    throw AppError.badRequest("participants must be an array of { role, name }");
  }
  if (b.restrictions !== undefined && !Array.isArray(b.restrictions)) {
    throw AppError.badRequest("restrictions must be an array of strings");
  }
  if (b.locationOrLink !== undefined && b.locationOrLink !== null && typeof b.locationOrLink !== "string") {
    throw AppError.badRequest("locationOrLink must be a string or null");
  }

  return {
    proposedWindows: b.proposedWindows as talentService.CreateInterviewPreviewInput["proposedWindows"],
    durationMinutes: b.durationMinutes,
    timezone: b.timezone,
    modality: b.modality as talentService.CreateInterviewPreviewInput["modality"],
    locationOrLink: (b.locationOrLink as string | null | undefined) ?? null,
    participants: b.participants as talentService.CreateInterviewPreviewInput["participants"],
    restrictions: (b.restrictions as string[] | undefined) ?? [],
  };
}

// F8.9: Interview Scheduling Preview -- SOLO preparación/preview, nunca
// modifica un calendario real ni envía invitaciones/email. POST
// genera Y persiste (upsert); GET solo lee; PATCH cambia el estado
// (APPROVED_FOR_SEND/CANCELLED son siempre una acción humana explícita,
// nunca automática).
talentRouter.post(
  "/candidates/:id/interview-preview/:jobOrderId",
  requireAllPermissions(["candidates.update", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      const input = parseCreateInterviewPreviewInput(req.body);
      res.status(201).json(await talentService.generateAndPersistInterviewPreview(req.params.id!, req.params.jobOrderId!, input));
    } catch (err) {
      next(err);
    }
  },
);

talentRouter.get(
  "/candidates/:id/interview-preview/:jobOrderId",
  requireAllPermissions(["candidates.view", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      const record = await talentService.getInterviewPreview(req.params.id!, req.params.jobOrderId!);
      if (!record) throw AppError.notFound("No persisted interview preview found for this candidate and job order");
      res.json(record);
    } catch (err) {
      next(err);
    }
  },
);

talentRouter.patch(
  "/candidates/:id/interview-preview/:jobOrderId/status",
  requirePermission("candidates.update"),
  async (req, res, next) => {
    try {
      const { status } = req.body as { status?: unknown };
      if (typeof status !== "string" || !INTERVIEW_PREVIEW_STATUSES.has(status)) {
        throw AppError.badRequest("Invalid status", {
          allowed: ["DRAFT", "NEEDS_AVAILABILITY", "READY_FOR_APPROVAL", "APPROVED_FOR_SEND", "CANCELLED"],
        });
      }
      res.json(
        await talentService.updateInterviewPreviewStatus(
          req.params.id!,
          req.params.jobOrderId!,
          status as talentService.InterviewPreviewRecord["status"],
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

// F8.10: Placement Readiness -- POST calcula Y persiste (upsert),
// agregando lo YA persistido por F8.5/F8.7/F8.8/F8.9. Nunca crea un
// Placement/Assignment ni activa un Worker. GET solo lee.
talentRouter.post(
  "/candidates/:id/placement-readiness/:jobOrderId",
  requireAllPermissions(["candidates.update", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.status(201).json(await talentService.computeAndPersistPlacementReadiness(req.params.id!, req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);

talentRouter.get(
  "/candidates/:id/placement-readiness/:jobOrderId",
  requireAllPermissions(["candidates.view", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      const record = await talentService.getPlacementReadiness(req.params.id!, req.params.jobOrderId!);
      if (!record) throw AppError.notFound("No persisted placement readiness found for this candidate and job order");
      res.json(record);
    } catch (err) {
      next(err);
    }
  },
);
