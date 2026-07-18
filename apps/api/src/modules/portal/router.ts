import { Router } from "express";
import { requirePermission } from "../../core/rbac/require-permission";
import { AppError } from "../../core/errors";
import * as clientService from "./client-service";
import * as clientJobRequestService from "./client-job-request-service";
import * as internalJobRequestService from "./internal-job-request-service";
import * as workerService from "./worker-service";
import * as candidateService from "./candidate-service";

/**
 * F10.2: Client Portal -- todas las rutas viven bajo /portal/client/*,
 * gateadas por los recursos `portal*` de F10.1 (nunca por assignments.
 * view/timeEntries.view/etc. internos -- ver la decisión de seguridad
 * documentada en docs/F10_PLAN.md §2/§3.5).
 */
export const portalRouter = Router();

portalRouter.get("/portal/client/dashboard", requirePermission("portalAssignments.view"), async (_req, res, next) => {
  try {
    res.json(await clientService.getClientDashboard());
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/job-orders", requirePermission("portalAssignments.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientJobOrders({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/job-orders/:id", requirePermission("portalAssignments.view"), async (req, res, next) => {
  try {
    res.json(await clientService.getClientJobOrderDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/job-orders/:id/shortlist", requirePermission("portalAssignments.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientShortlist(req.params.id!));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/placements", requirePermission("portalAssignments.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientPlacements({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/assignments", requirePermission("portalAssignments.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientAssignments({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/workers", requirePermission("portalAssignments.view"), async (_req, res, next) => {
  try {
    res.json(await clientService.listClientWorkers());
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/time-entries", requirePermission("portalTimeEntries.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientPendingTimeEntries({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});

portalRouter.post("/portal/client/time-entries/:id/approve", requirePermission("portalTimeEntries.update"), async (req, res, next) => {
  try {
    res.json(await clientService.approveClientTimeEntry(req.params.id!));
  } catch (err) {
    next(err);
  }
});

portalRouter.post("/portal/client/time-entries/:id/reject", requirePermission("portalTimeEntries.update"), async (req, res, next) => {
  try {
    const { rejectionReason } = req.body as { rejectionReason?: unknown };
    if (typeof rejectionReason !== "string" || rejectionReason.trim().length === 0) {
      throw AppError.badRequest("rejectionReason is required");
    }
    res.json(await clientService.rejectClientTimeEntry(req.params.id!, rejectionReason));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/incidents", requirePermission("portalIncidents.view"), async (req, res, next) => {
  try {
    res.json(await clientService.listClientIncidents({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});

// ================= F10.3: Client Job Request (lado cliente) =================

function parseJobRequestBody(body: Record<string, unknown>) {
  return {
    requestedTitle: body.requestedTitle as string,
    location: body.location,
    headcount: body.headcount as number,
    shift: (body.shift as string | null | undefined) ?? null,
    schedule: (body.schedule as string | null | undefined) ?? null,
    payRateExpectation: (body.payRateExpectation as number | null | undefined) ?? null,
    billBudget: (body.billBudget as number | null | undefined) ?? null,
    desiredStartDate: body.desiredStartDate as string,
    duration: (body.duration as string | null | undefined) ?? null,
    requiredSkills: (body.requiredSkills as string[] | undefined) ?? [],
    certifications: (body.certifications as string[] | undefined) ?? [],
    languageRequirements: (body.languageRequirements as string[] | undefined) ?? [],
    physicalRequirements: (body.physicalRequirements as string | null | undefined) ?? null,
    notes: (body.notes as string | null | undefined) ?? null,
    urgency: (body.urgency as string | undefined) ?? "MEDIUM",
  };
}

// F10.5: whitelist explícita -- cualquier campo fuera de esta lista
// (employmentType/defaultPayRate/status/complianceStatus/etc, juicio
// interno) queda simplemente ignorado, nunca aceptado silenciosamente.
function parseProfileUpdateBody(body: Record<string, unknown>) {
  const out: {
    phone?: string | null;
    city?: string | null;
    state?: string | null;
    languages?: string[];
    availabilityNotes?: string | null;
    skills?: string[];
  } = {};
  if ("phone" in body) out.phone = (body.phone as string | null) ?? null;
  if ("city" in body) out.city = (body.city as string | null) ?? null;
  if ("state" in body) out.state = (body.state as string | null) ?? null;
  if ("languages" in body) {
    if (!Array.isArray(body.languages) || body.languages.some((v) => typeof v !== "string")) {
      throw AppError.badRequest("languages must be an array of strings");
    }
    out.languages = body.languages as string[];
  }
  if ("availabilityNotes" in body) out.availabilityNotes = (body.availabilityNotes as string | null) ?? null;
  if ("skills" in body) {
    if (!Array.isArray(body.skills) || body.skills.some((v) => typeof v !== "string")) {
      throw AppError.badRequest("skills must be an array of strings");
    }
    out.skills = body.skills as string[];
  }
  return out;
}

function parseDocumentSubmitBody(body: Record<string, unknown>) {
  if (typeof body.fileName !== "string" || body.fileName.trim().length === 0) {
    throw AppError.badRequest("fileName is required");
  }
  return {
    fileName: body.fileName,
    notes: (body.notes as string | null | undefined) ?? null,
  };
}

portalRouter.get("/portal/client/job-requests", requirePermission("clientJobs.view"), async (req, res, next) => {
  try {
    res.json(await clientJobRequestService.listClientJobRequests({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/client/job-requests/:id", requirePermission("clientJobs.view"), async (req, res, next) => {
  try {
    res.json(await clientJobRequestService.getClientJobRequest(req.params.id!));
  } catch (err) {
    next(err);
  }
});

portalRouter.post("/portal/client/job-requests", requirePermission("clientJobs.create"), async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (typeof body.requestedTitle !== "string" || body.requestedTitle.trim().length === 0) {
      throw AppError.badRequest("requestedTitle is required");
    }
    if (typeof body.headcount !== "number" || body.headcount <= 0) {
      throw AppError.badRequest("headcount must be a positive number");
    }
    if (typeof body.desiredStartDate !== "string" || body.desiredStartDate.trim().length === 0) {
      throw AppError.badRequest("desiredStartDate is required");
    }
    res.status(201).json(await clientJobRequestService.createClientJobRequest(parseJobRequestBody(body)));
  } catch (err) {
    next(err);
  }
});

// F10.3: solo CLIENT_ADMIN tiene clientJobs.update (CLIENT_MANAGER puede
// crear pero no editar/cancelar la de otros -- ver ROLE_PERMISSIONS,
// F10.1).
portalRouter.patch("/portal/client/job-requests/:id", requirePermission("clientJobs.update"), async (req, res, next) => {
  try {
    res.json(await clientJobRequestService.updateClientJobRequest(req.params.id!, parseJobRequestBody(req.body as Record<string, unknown>)));
  } catch (err) {
    next(err);
  }
});

// F10.3: gateado por clientJobs.create (no .update) a propósito --
// "enviar" un borrador propio es una extensión natural de crearlo,
// mismo criterio pedido explícito del PO para CLIENT_MANAGER ("puede
// enviar solicitudes, pero no editar/cancelar las de otros").
portalRouter.post("/portal/client/job-requests/:id/submit", requirePermission("clientJobs.create"), async (req, res, next) => {
  try {
    res.json(await clientJobRequestService.submitClientJobRequest(req.params.id!));
  } catch (err) {
    next(err);
  }
});

portalRouter.post("/portal/client/job-requests/:id/cancel", requirePermission("clientJobs.update"), async (req, res, next) => {
  try {
    res.json(await clientJobRequestService.cancelClientJobRequest(req.params.id!));
  } catch (err) {
    next(err);
  }
});

// ================= F10.3: Client Job Request (revisión interna) =================

const INTERNAL_REVIEW_TARGETS = new Set(["UNDER_REVIEW", "NEEDS_INFORMATION", "APPROVED", "REJECTED"]);

portalRouter.get("/client-job-requests", requirePermission("clientJobs.view"), async (req, res, next) => {
  try {
    res.json(
      await internalJobRequestService.listInternalJobRequests({
        status: req.query.status as string | undefined,
        cursor: req.query.cursor as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/client-job-requests/:id", requirePermission("clientJobs.view"), async (req, res, next) => {
  try {
    res.json(await internalJobRequestService.getInternalJobRequestDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

portalRouter.patch("/client-job-requests/:id/status", requirePermission("clientJobs.approve"), async (req, res, next) => {
  try {
    const { status, reviewNotes } = req.body as { status?: unknown; reviewNotes?: unknown };
    if (typeof status !== "string" || !INTERNAL_REVIEW_TARGETS.has(status)) {
      throw AppError.badRequest("Invalid status", { allowed: [...INTERNAL_REVIEW_TARGETS] });
    }
    res.json(await internalJobRequestService.reviewClientJobRequest(req.params.id!, status as never, typeof reviewNotes === "string" ? reviewNotes : undefined));
  } catch (err) {
    next(err);
  }
});

portalRouter.post("/client-job-requests/:id/convert", requirePermission("clientJobs.approve"), async (req, res, next) => {
  try {
    const { categoryId, billRate, payRate, workersNeeded } = req.body as {
      categoryId?: unknown;
      billRate?: unknown;
      payRate?: unknown;
      workersNeeded?: unknown;
    };
    if (typeof categoryId !== "string" || categoryId.trim().length === 0) throw AppError.badRequest("categoryId is required");
    if (typeof billRate !== "number" || billRate <= 0) throw AppError.badRequest("billRate is required");
    if (typeof payRate !== "number" || payRate <= 0) throw AppError.badRequest("payRate is required");
    res.json(
      await internalJobRequestService.convertToJobOrder(req.params.id!, {
        categoryId,
        billRate,
        payRate,
        workersNeeded: typeof workersNeeded === "number" ? workersNeeded : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ================= F10.4: Worker Portal =================

portalRouter.get("/portal/worker/profile", requirePermission("portalProfile.view"), async (_req, res, next) => {
  try {
    res.json(await workerService.getWorkerProfile());
  } catch (err) {
    next(err);
  }
});

// F10.5: PATCH separado del GET, gateado por portalProfile.update (deny by
// default -- ver ROLE_PERMISSIONS, solo WORKER/CANDIDATE lo tienen).
// parseProfileUpdateBody rechaza cualquier campo fuera de la whitelist
// self-service (nunca employmentType/defaultPayRate/status/complianceStatus).
portalRouter.patch("/portal/worker/profile", requirePermission("portalProfile.update"), async (req, res, next) => {
  try {
    res.json(await workerService.updateWorkerProfile(parseProfileUpdateBody(req.body as Record<string, unknown>)));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/worker/onboarding", requirePermission("portalProfile.view"), async (_req, res, next) => {
  try {
    res.json(await workerService.listWorkerOnboarding());
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/worker/documents", requirePermission("portalDocuments.view"), async (_req, res, next) => {
  try {
    res.json(await workerService.listWorkerDocuments());
  } catch (err) {
    next(err);
  }
});

// F10.5: gateado por portalDocuments.update -- distinto de portalDocuments.view
// (leer el checklist no implica poder "subir"/marcar SUBMITTED un item).
portalRouter.post("/portal/worker/documents/:id/submit", requirePermission("portalDocuments.update"), async (req, res, next) => {
  try {
    res.json(await workerService.submitWorkerDocument(req.params.id!, parseDocumentSubmitBody(req.body as Record<string, unknown>)));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/worker/placements", requirePermission("portalAssignments.view"), async (_req, res, next) => {
  try {
    res.json(await workerService.listWorkerPlacements());
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/worker/assignments", requirePermission("portalAssignments.view"), async (_req, res, next) => {
  try {
    res.json(await workerService.listWorkerAssignments());
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/worker/shifts", requirePermission("portalAssignments.view"), async (_req, res, next) => {
  try {
    res.json(await workerService.listWorkerShifts());
  } catch (err) {
    next(err);
  }
});

// F10.6: el Worker nunca activa/pausa/completa/cancela un Assignment --
// esto SOLO crea una solicitud pendiente de revisión interna (ver
// modules/assignments/router.ts, GET/PATCH /schedule-change-requests).
portalRouter.get("/portal/worker/schedule-change-requests", requirePermission("portalAssignments.view"), async (req, res, next) => {
  try {
    res.json(await workerService.listWorkerScheduleChangeRequests(req.query.assignmentId as string | undefined));
  } catch (err) {
    next(err);
  }
});

portalRouter.post(
  "/portal/worker/assignments/:id/schedule-change-requests",
  requirePermission("portalAssignments.create"),
  async (req, res, next) => {
    try {
      const { requestType, requestedChange } = req.body as { requestType?: unknown; requestedChange?: unknown };
      if (typeof requestType !== "string" || requestType.trim().length === 0) throw AppError.badRequest("requestType is required");
      if (typeof requestedChange !== "string" || requestedChange.trim().length === 0) throw AppError.badRequest("requestedChange is required");
      res.status(201).json(await workerService.requestScheduleChange(req.params.id!, { requestType, requestedChange }));
    } catch (err) {
      next(err);
    }
  },
);

portalRouter.get("/portal/worker/time-entries", requirePermission("portalTimeEntries.view"), async (req, res, next) => {
  try {
    res.json(await workerService.listWorkerTimeEntries({ cursor: req.query.cursor as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/worker/incidents", requirePermission("portalIncidents.view"), async (_req, res, next) => {
  try {
    res.json(await workerService.listWorkerIncidents());
  } catch (err) {
    next(err);
  }
});

// ================= F10.4: Candidate Portal =================

portalRouter.get("/portal/candidate/profile", requirePermission("portalProfile.view"), async (_req, res, next) => {
  try {
    res.json(await candidateService.getCandidateProfile());
  } catch (err) {
    next(err);
  }
});

portalRouter.patch("/portal/candidate/profile", requirePermission("portalProfile.update"), async (req, res, next) => {
  try {
    res.json(await candidateService.updateCandidateProfile(parseProfileUpdateBody(req.body as Record<string, unknown>)));
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/candidate/applications", requirePermission("portalProfile.view"), async (_req, res, next) => {
  try {
    res.json(await candidateService.listCandidateApplications());
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/candidate/onboarding", requirePermission("portalProfile.view"), async (_req, res, next) => {
  try {
    res.json(await candidateService.listCandidateOnboarding());
  } catch (err) {
    next(err);
  }
});

portalRouter.get("/portal/candidate/documents", requirePermission("portalDocuments.view"), async (_req, res, next) => {
  try {
    res.json(await candidateService.listCandidateDocuments());
  } catch (err) {
    next(err);
  }
});

portalRouter.post("/portal/candidate/documents/:id/submit", requirePermission("portalDocuments.update"), async (req, res, next) => {
  try {
    res.json(await candidateService.submitCandidateDocument(req.params.id!, parseDocumentSubmitBody(req.body as Record<string, unknown>)));
  } catch (err) {
    next(err);
  }
});
