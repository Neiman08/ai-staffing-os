import type {
  CreateFollowUpInput,
  FollowUpListItem,
  FollowUpQuery,
  Paginated,
  UpdateFollowUpInput,
} from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { entityLabelKey, labelEntities } from "../../core/entity-labels";
import { labelUsers } from "../../core/user-labels";
import { AppError } from "../../core/errors";

function toListItem(
  f: {
    id: string;
    entityType: string;
    entityId: string;
    type: string;
    dueDate: Date;
    priority: string;
    assignedToId: string | null;
    status: string;
    notes: string | null;
    createdByAgentTaskId: string | null;
    campaignId: string | null;
    createdAt: Date;
  },
  entityLabels: Map<string, string>,
  assigneeLabels: Map<string, string>,
): FollowUpListItem {
  return {
    id: f.id,
    entityType: f.entityType as FollowUpListItem["entityType"],
    entityId: f.entityId,
    entityLabel: entityLabels.get(entityLabelKey(f.entityType, f.entityId)) ?? "Unknown",
    type: f.type as FollowUpListItem["type"],
    dueDate: f.dueDate.toISOString(),
    priority: f.priority as FollowUpListItem["priority"],
    assignedToLabel: f.assignedToId ? (assigneeLabels.get(f.assignedToId) ?? null) : null,
    status: f.status as FollowUpListItem["status"],
    notes: f.notes,
    createdByAgentTaskId: f.createdByAgentTaskId,
    campaignId: f.campaignId,
    overdue: f.status === "PENDING" && f.dueDate < new Date(),
    createdAt: f.createdAt.toISOString(),
  };
}

export async function listFollowUps(query: FollowUpQuery): Promise<Paginated<FollowUpListItem>> {
  const rows = await scopedDb.followUp.findMany({
    ...buildCursorArgs(query),
    where: {
      status: query.status,
      assignedToId: query.assignedToId,
      entityType: query.entityType,
      ...(query.overdue ? { status: "PENDING", dueDate: { lt: new Date() } } : {}),
    },
    orderBy: [{ dueDate: "asc" }, { id: "desc" }],
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);
  const [entityLabels, assigneeLabels] = await Promise.all([
    labelEntities(items),
    labelUsers(items.filter((f) => f.assignedToId).map((f) => f.assignedToId!)),
  ]);

  return { items: items.map((f) => toListItem(f, entityLabels, assigneeLabels)), nextCursor };
}

export async function listUpcomingFollowUps(limit = 10): Promise<FollowUpListItem[]> {
  const rows = await scopedDb.followUp.findMany({
    where: { status: "PENDING" },
    orderBy: { dueDate: "asc" },
    take: limit,
  });

  const [entityLabels, assigneeLabels] = await Promise.all([
    labelEntities(rows),
    labelUsers(rows.filter((f) => f.assignedToId).map((f) => f.assignedToId!)),
  ]);

  return rows.map((f) => toListItem(f, entityLabels, assigneeLabels));
}

export async function createFollowUp(input: CreateFollowUpInput) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  return scopedDb.followUp.create({
    data: {
      tenantId: ctx.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      type: input.type,
      dueDate: new Date(input.dueDate),
      priority: input.priority,
      assignedToId: input.assignedToId ?? ctx.userId,
      reminderAt: input.reminderAt ? new Date(input.reminderAt) : undefined,
      notes: input.notes,
    },
  });
}

export async function updateFollowUp(id: string, input: UpdateFollowUpInput) {
  const existing = await scopedDb.followUp.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Follow-up not found");

  return scopedDb.followUp.update({
    where: { id },
    data: {
      dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
      priority: input.priority,
      assignedToId: input.assignedToId,
      status: input.status,
      notes: input.notes,
      completedAt: input.status === "DONE" ? new Date() : undefined,
    },
  });
}
