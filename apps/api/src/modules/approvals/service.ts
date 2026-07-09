import type { ApprovalRequestListItem, DecideApprovalInput } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { labelUsers } from "../../core/user-labels";
import { AppError } from "../../core/errors";

function toListItem(
  approval: Awaited<ReturnType<typeof scopedDb.approvalRequest.findMany>>[number] & {
    agentTask: { type: string };
  },
  decidedByLabels: Map<string, string>,
): ApprovalRequestListItem {
  return {
    id: approval.id,
    agentTaskId: approval.agentTaskId,
    agentTaskType: approval.agentTask.type,
    summary: approval.summary,
    proposedAction: approval.proposedAction,
    riskLevel: approval.riskLevel,
    status: approval.status,
    decidedByLabel: approval.decidedById ? (decidedByLabels.get(approval.decidedById) ?? "Unknown user") : null,
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    decisionNote: approval.decisionNote,
    createdAt: approval.createdAt.toISOString(),
  };
}

export async function listApprovals(status?: string): Promise<ApprovalRequestListItem[]> {
  const approvals = await scopedDb.approvalRequest.findMany({
    where: { status: status as never },
    include: { agentTask: true },
    orderBy: { createdAt: "desc" },
  });

  const decidedByLabels = await labelUsers(approvals.filter((a) => a.decidedById).map((a) => a.decidedById!));

  return approvals.map((a) => toListItem(a, decidedByLabels));
}

export async function decideApproval(id: string, input: DecideApprovalInput): Promise<ApprovalRequestListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const approval = await scopedDb.approvalRequest.findUnique({ where: { id }, include: { agentTask: true } });
  if (!approval) throw AppError.notFound("Approval request not found");
  if (approval.status !== "PENDING") {
    throw AppError.badRequest(`This approval request was already decided (${approval.status})`);
  }

  const updated = await scopedDb.approvalRequest.update({
    where: { id },
    data: {
      status: input.decision,
      decidedById: ctx.userId,
      decidedAt: new Date(),
      decisionNote: input.note,
    },
    include: { agentTask: true },
  });

  // The task itself ran successfully and produced a draft — its lifecycle
  // ends here regardless of the human's decision. What happened to the
  // *content* is tracked on ApprovalRequest.status, not by leaving the
  // task stuck in AWAITING_APPROVAL forever.
  if (updated.agentTask.status === "AWAITING_APPROVAL") {
    await scopedDb.agentTask.update({ where: { id: updated.agentTaskId }, data: { status: "DONE" } });
  }

  await scopedDb.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorType: "HUMAN",
      actorId: ctx.userId,
      action: "approval.decided",
      entityType: "approvalRequest",
      entityId: id,
      after: { decision: input.decision, note: input.note } as never,
    },
  });

  const decidedByLabels = await labelUsers([ctx.userId]);
  return toListItem(updated, decidedByLabels);
}
