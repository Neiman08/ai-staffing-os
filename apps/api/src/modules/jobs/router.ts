import { Router } from "express";
import {
  createJobOrderInputSchema,
  jobOrderQuerySchema,
  updateJobOrderInputSchema,
  updateJobOrderStatusInputSchema,
} from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as jobsService from "./service";

export const jobsRouter = Router();

jobsRouter.get("/job-orders", requirePermission("jobOrders.view"), async (req, res, next) => {
  try {
    const query = jobOrderQuerySchema.parse(req.query);
    res.json(await jobsService.listJobOrders(query));
  } catch (err) {
    next(err);
  }
});

jobsRouter.get("/job-orders/:id", requirePermission("jobOrders.view"), async (req, res, next) => {
  try {
    res.json(await jobsService.getJobOrderDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

jobsRouter.post("/job-orders", requirePermission("jobOrders.create"), async (req, res, next) => {
  try {
    const input = createJobOrderInputSchema.parse(req.body);
    res.status(201).json(await jobsService.createJobOrder(input));
  } catch (err) {
    next(err);
  }
});

// F5.1: nunca permite tocar status/workersFilled/createdById/tenantId —
// updateJobOrderInputSchema ni siquiera los declara, así que un intento
// de enviarlos en el body es simplemente ignorado por Zod (strip por
// default), nunca aplicado.
jobsRouter.patch("/job-orders/:id", requirePermission("jobOrders.update"), async (req, res, next) => {
  try {
    const input = updateJobOrderInputSchema.parse(req.body);
    res.json(await jobsService.updateJobOrder(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

// F5.1: único camino para cambiar el estado — separado del PATCH general
// a propósito, para que quede como una acción propia y auditable (mismo
// patrón que PATCH /opportunities/:id/stage).
jobsRouter.patch("/job-orders/:id/status", requirePermission("jobOrders.update"), async (req, res, next) => {
  try {
    const input = updateJobOrderStatusInputSchema.parse(req.body);
    res.json(await jobsService.updateJobOrderStatus(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});
