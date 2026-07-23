import { Router } from "express";
import { decideApprovalInputSchema, editApprovalDraftInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as approvalsService from "./service";

/**
 * F2 §9: every draftOutreach ends in a PENDING ApprovalRequest here — the
 * only place a human signs off on AI-produced content meant for someone
 * outside the tenant. F17: deciding APPROVED now really sends the email
 * (Microsoft Graph, always from the COMMERCIAL sender profile) — see
 * approvals/service.ts's resolveDraftEmail/sendEmail. REJECTED never
 * sends anything.
 */
export const approvalsRouter = Router();

approvalsRouter.get("/approvals", requirePermission("approvals.decide"), async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(await approvalsService.listApprovals(status));
  } catch (err) {
    next(err);
  }
});

approvalsRouter.post("/approvals/:id/decide", requirePermission("approvals.decide"), async (req, res, next) => {
  try {
    const input = decideApprovalInputSchema.parse(req.body);
    res.json(await approvalsService.decideApproval(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

// F23: edición segura de un borrador (to/subject/body) ANTES de aprobar/
// enviar -- nunca envía nada (ver approvals/service.ts's editApprovalDraft).
// Solo PENDING/READY_TO_SEND/FAILED son editables; editar un READY_TO_SEND
// lo vuelve a PENDING, exigiendo una nueva aprobación humana.
approvalsRouter.patch("/approvals/:id/draft", requirePermission("approvals.decide"), async (req, res, next) => {
  try {
    const input = editApprovalDraftInputSchema.parse(req.body);
    res.json(await approvalsService.editApprovalDraft(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

// F21 Fase 4: acción EXPLÍCITA y separada de /decide -- decidir APPROVED
// nunca envía nada (ver approvals/service.ts), solo este endpoint puede
// disparar un envío real, y solo cuando el ApprovalRequest ya está
// READY_TO_SEND (o FAILED, reintento). Nunca acepta body -- no hay nada
// que un caller pueda parametrizar en un envío real.
approvalsRouter.post("/approvals/:id/send", requirePermission("approvals.decide"), async (req, res, next) => {
  try {
    res.json(await approvalsService.sendApproval(req.params.id!));
  } catch (err) {
    next(err);
  }
});
