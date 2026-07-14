import { Router } from "express";
import {
  bulkApproveTimeEntriesInputSchema,
  createPayrollRunInputSchema,
  createTimeEntryInputSchema,
  paginationQuerySchema,
  timeEntryQuerySchema,
  updateTimeEntryInputSchema,
} from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as payrollService from "./service";

export const payrollRouter = Router();

payrollRouter.get("/time-entries", requirePermission("timeEntries.view"), async (req, res, next) => {
  try {
    const query = timeEntryQuerySchema.parse(req.query);
    res.json(await payrollService.listTimeEntries(query));
  } catch (err) {
    next(err);
  }
});

payrollRouter.post("/time-entries", requirePermission("timeEntries.create"), async (req, res, next) => {
  try {
    const input = createTimeEntryInputSchema.parse(req.body);
    res.status(201).json(await payrollService.createTimeEntry(input));
  } catch (err) {
    next(err);
  }
});

// F5.6: solo editable mientras el TimeEntry sigue PENDING (verificado en
// el servicio) — updateTimeEntryInputSchema ni siquiera declara status.
payrollRouter.patch("/time-entries/:id", requirePermission("timeEntries.update"), async (req, res, next) => {
  try {
    const input = updateTimeEntryInputSchema.parse(req.body);
    res.json(await payrollService.updateTimeEntry(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

// F5.6 (plan §8.3, aprobado): reutiliza timeEntries.update — no se
// inventa un timeEntries.approve nuevo sin necesidad real.
payrollRouter.post(
  "/time-entries/bulk-approve",
  requirePermission("timeEntries.update"),
  async (req, res, next) => {
    try {
      const input = bulkApproveTimeEntriesInputSchema.parse(req.body);
      res.json(await payrollService.bulkApproveTimeEntries(input));
    } catch (err) {
      next(err);
    }
  },
);

// ================= Payroll Runs (F5.7) =================

payrollRouter.get("/payroll/runs", requirePermission("payrollRuns.view"), async (req, res, next) => {
  try {
    const query = paginationQuerySchema.parse(req.query);
    res.json(await payrollService.listPayrollRuns(query));
  } catch (err) {
    next(err);
  }
});

payrollRouter.get("/payroll/runs/:id", requirePermission("payrollRuns.view"), async (req, res, next) => {
  try {
    res.json(await payrollService.getPayrollRunDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

payrollRouter.post("/payroll/runs", requirePermission("payrollRuns.create"), async (req, res, next) => {
  try {
    const input = createPayrollRunInputSchema.parse(req.body);
    res.status(201).json(await payrollService.createPayrollRun(input));
  } catch (err) {
    next(err);
  }
});

payrollRouter.post("/payroll/runs/:id/submit", requirePermission("payrollRuns.update"), async (req, res, next) => {
  try {
    res.json(await payrollService.submitPayrollRun(req.params.id!));
  } catch (err) {
    next(err);
  }
});

// F5.7 (plan §9.3, aprobado): payroll.approve — el mismo permiso especial
// ya reservado desde F0 para exactamente esta acción, nunca
// payrollRuns.update a secas (aprobar es un juicio distinto de editar).
payrollRouter.post("/payroll/runs/:id/approve", requirePermission("payroll.approve"), async (req, res, next) => {
  try {
    res.json(await payrollService.approvePayrollRun(req.params.id!));
  } catch (err) {
    next(err);
  }
});

payrollRouter.post("/payroll/runs/:id/mark-paid", requirePermission("payroll.approve"), async (req, res, next) => {
  try {
    res.json(await payrollService.markPayrollRunPaid(req.params.id!));
  } catch (err) {
    next(err);
  }
});

payrollRouter.post("/payroll/runs/:id/export", requirePermission("payroll.approve"), async (req, res, next) => {
  try {
    const { csv, filename } = await payrollService.exportPayrollRun(req.params.id!);
    res.status(200).header("Content-Disposition", `attachment; filename="${filename}"`).type("text/csv").send(csv);
  } catch (err) {
    next(err);
  }
});
