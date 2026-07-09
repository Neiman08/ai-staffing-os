import type { ActivityType } from "@ai-staffing-os/db";
import { scopedDb } from "./tenancy/prisma-extension";
import { getTenancyContext } from "./tenancy/context";
import { AppError } from "./errors";

export async function logActivity(params: {
  entityType: string;
  entityId: string;
  type: ActivityType;
  subject: string;
  body?: string;
}) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  return scopedDb.activity.create({
    data: {
      tenantId: ctx.tenantId,
      type: params.type,
      subject: params.subject,
      body: params.body,
      entityType: params.entityType,
      entityId: params.entityId,
      // F2: attribute agent-performed activity to the AgentInstance, never
      // to the human whose context the task-runner borrowed for tenancy.
      performedById: ctx.actor?.type === "AGENT" ? null : ctx.userId,
      performedByAgentId: ctx.actor?.type === "AGENT" ? ctx.actor.agentInstanceId : undefined,
    },
  });
}
