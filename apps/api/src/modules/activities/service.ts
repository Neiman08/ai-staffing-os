import type { ActivityItem, ActivityQuery, CreateActivityInput } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { labelUsers } from "../../core/user-labels";
import { logActivity } from "../../core/activity-log";

export async function listActivities(query: ActivityQuery): Promise<ActivityItem[]> {
  const activities = await scopedDb.activity.findMany({
    where: { entityType: query.entityType, entityId: query.entityId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const actorIds = activities.filter((a) => a.performedById).map((a) => a.performedById!);
  const actorLabels = await labelUsers(actorIds);

  return activities.map((a) => ({
    id: a.id,
    type: a.type,
    subject: a.subject,
    body: a.body,
    performedByLabel: a.performedById ? (actorLabels.get(a.performedById) ?? "Unknown user") : "System",
    createdAt: a.createdAt.toISOString(),
  }));
}

export async function createManualActivity(input: CreateActivityInput) {
  return logActivity({
    entityType: input.entityType,
    entityId: input.entityId,
    type: input.type,
    subject: input.subject,
    body: input.body,
  });
}
