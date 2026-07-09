import { Router } from "express";
import { decideApprovalInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as approvalsService from "./service";

/**
 * F2 §9: every draftOutreach ends in a PENDING ApprovalRequest here — the
 * only place a human signs off on AI-produced content meant for someone
 * outside the tenant. Deciding never sends anything either; it only marks
 * the draft as usable or not.
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
