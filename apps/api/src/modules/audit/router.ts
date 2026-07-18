import { Router } from "express";
import { requirePermission } from "../../core/rbac/require-permission";
import * as auditService from "./service";

// F10.9: tenant completo -- gateado por `auditLogs.view` (deny by
// default; la mayoría de roles operativos internos NO lo tienen, solo
// CEO/Admin/Manager, ver seed.ts ROLE_PERMISSIONS). Distinto del
// widget decorativo `/dashboard/audit-log` (F1, sin gate, solo
// actividad de agentes para el Dashboard) -- ese queda intacto, este
// es la superficie real de auditoría con filtros.
export const auditRouter = Router();

auditRouter.get("/audit-log", requirePermission("auditLogs.view"), async (req, res, next) => {
  try {
    res.json(
      await auditService.listInternalAuditLog({
        cursor: req.query.cursor as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        dateFrom: req.query.dateFrom as string | undefined,
        dateTo: req.query.dateTo as string | undefined,
        actorId: req.query.actorId as string | undefined,
        entityType: req.query.entityType as string | undefined,
        action: req.query.action as string | undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});
