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

  await scopedDb.activity.create({
    data: {
      tenantId: ctx.tenantId,
      type: params.type,
      subject: params.subject,
      body: params.body,
      entityType: params.entityType,
      entityId: params.entityId,
      performedById: ctx.userId,
    },
  });
}
