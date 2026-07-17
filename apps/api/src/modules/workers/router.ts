import { Router } from "express";
import {
  createWorkerInputSchema,
  updateWorkerInputSchema,
  updateWorkerStatusInputSchema,
  workerQuerySchema,
} from "@ai-staffing-os/shared";
import { requireAllPermissions, requirePermission } from "../../core/rbac/require-permission";
import { AppError } from "../../core/errors";
import * as workersService from "./service";

// F5.3: CRUD completo aprobado (docs/F5_STAFFING_OPERATIONS_PLAN.md §5).
// Sin DELETE físico — TERMINATED (WorkerStatus) es el estado terminal
// equivalente, mismo patrón ya usado por JobOrder (CLOSED/CANCELLED) y
// Candidate (INACTIVE/REJECTED): nunca se borra, se transiciona.
export const workersRouter = Router();

workersRouter.get("/workers", requirePermission("workers.view"), async (req, res, next) => {
  try {
    const query = workerQuerySchema.parse(req.query);
    res.json(await workersService.listWorkers(query));
  } catch (err) {
    next(err);
  }
});

workersRouter.get("/workers/:id", requirePermission("workers.view"), async (req, res, next) => {
  try {
    res.json(await workersService.getWorkerDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

// F5.3: Worker.candidateId es una FK única y NO nullable — crear un
// Worker es siempre, en la práctica, convertir un Candidate QUALIFIED
// existente. Por eso esta ruta exige el mismo par de permisos que
// POST /candidates/:id/convert-to-worker (F5.2): candidates.update Y
// workers.create a la vez (hoy CEO/Admin) — la misma decisión aprobada
// del PO de restringir esta acción, sin importar por cuál URL se llegue.
workersRouter.post(
  "/workers",
  requireAllPermissions(["workers.create", "candidates.update"]),
  async (req, res, next) => {
    try {
      const input = createWorkerInputSchema.parse(req.body);
      res.status(201).json(await workersService.createWorker(input));
    } catch (err) {
      next(err);
    }
  },
);

// F5.3: nunca permite tocar status/complianceStatus/candidateId/tenantId —
// updateWorkerInputSchema ni siquiera los declara. complianceStatus es
// dominio de Compliance (fuera de alcance de F5.3).
workersRouter.patch("/workers/:id", requirePermission("workers.update"), async (req, res, next) => {
  try {
    const input = updateWorkerInputSchema.parse(req.body);
    res.json(await workersService.updateWorker(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

// F5.3: único camino para cambiar el estado — separado del PATCH general
// a propósito, mismo patrón que Job Orders/Candidates.
workersRouter.patch("/workers/:id/status", requirePermission("workers.update"), async (req, res, next) => {
  try {
    const input = updateWorkerStatusInputSchema.parse(req.body);
    res.json(await workersService.updateWorkerStatus(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

// F9.1: Worker Onboarding -- POST inicia (idempotente) el onboarding de
// un Candidate ya evaluado por Placement Readiness (F8.10, exigida como
// prerequisito, nunca recalculada acá); requiere workers.update (no
// workers.create -- iniciar onboarding nunca crea un Worker por sí
// mismo, ver worker-onboarding.ts). GET solo lee. PATCH es el único
// camino para cambiar el estado -- ACTIVE se rechaza sin un Worker ya
// existente.
workersRouter.post(
  "/candidates/:candidateId/onboarding/:jobOrderId",
  requireAllPermissions(["workers.update", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.status(201).json(await workersService.startWorkerOnboarding(req.params.candidateId!, req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);

workersRouter.get(
  "/candidates/:candidateId/onboarding/:jobOrderId",
  requireAllPermissions(["workers.view", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      const record = await workersService.getWorkerOnboarding(req.params.candidateId!, req.params.jobOrderId!);
      if (!record) throw AppError.notFound("No onboarding found for this candidate and job order");
      res.json(record);
    } catch (err) {
      next(err);
    }
  },
);

const ONBOARDING_STATUSES = new Set([
  "INVITED",
  "IN_PROGRESS",
  "DOCUMENTS_PENDING",
  "COMPLIANCE_REVIEW",
  "READY",
  "ACTIVE",
  "BLOCKED",
  "OFFBOARDED",
]);

workersRouter.patch(
  "/candidates/:candidateId/onboarding/:jobOrderId/status",
  requireAllPermissions(["workers.update", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      const { status } = req.body as { status?: unknown };
      if (typeof status !== "string" || !ONBOARDING_STATUSES.has(status)) {
        throw AppError.badRequest("Invalid onboarding status", { allowed: [...ONBOARDING_STATUSES] });
      }
      res.json(
        await workersService.updateWorkerOnboardingStatus(
          req.params.candidateId!,
          req.params.jobOrderId!,
          status as never,
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

// F9.2: Document Checklist -- POST genera (idempotente, solo agrega
// items faltantes) el checklist real a partir de JobOrder.requirements;
// requiere que el onboarding ya haya sido iniciado (F9.1). GET solo
// lee. PATCH cambia el estado de UN item -- valida la transición,
// nunca crea/modifica el Document real.
workersRouter.post(
  "/candidates/:candidateId/onboarding/:jobOrderId/checklist",
  requireAllPermissions(["workers.update", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.status(201).json(await workersService.generateChecklistForOnboarding(req.params.candidateId!, req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);

workersRouter.get(
  "/candidates/:candidateId/onboarding/:jobOrderId/checklist",
  requireAllPermissions(["workers.view", "jobOrders.view"]),
  async (req, res, next) => {
    try {
      res.json(await workersService.getChecklistForOnboarding(req.params.candidateId!, req.params.jobOrderId!));
    } catch (err) {
      next(err);
    }
  },
);

const CHECKLIST_ITEM_STATUSES = new Set([
  "NOT_REQUESTED",
  "PENDING",
  "SUBMITTED",
  "UNDER_REVIEW",
  "VERIFIED",
  "REJECTED",
  "EXPIRED",
  "WAIVED",
]);

workersRouter.patch(
  "/checklist-items/:itemId/status",
  requirePermission("workers.update"),
  async (req, res, next) => {
    try {
      const { status, expiresAt, rejectionReason, notes } = req.body as {
        status?: unknown;
        expiresAt?: string | null;
        rejectionReason?: string | null;
        notes?: string | null;
      };
      if (typeof status !== "string" || !CHECKLIST_ITEM_STATUSES.has(status)) {
        throw AppError.badRequest("Invalid checklist item status", { allowed: [...CHECKLIST_ITEM_STATUSES] });
      }
      res.json(
        await workersService.updateChecklistItemStatus(req.params.itemId!, {
          status: status as never,
          expiresAt,
          rejectionReason,
          notes,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);
