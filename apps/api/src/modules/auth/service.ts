import type { CurrentUser, RoleListItem, UserListItem } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";

export async function getCurrentUser(): Promise<CurrentUser> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const user = await scopedDb.user.findUnique({
    where: { id: ctx.userId },
    include: { role: true },
  });
  if (!user) throw AppError.notFound("Current user not found");

  return {
    id: user.id,
    tenantId: user.tenantId,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: { id: user.role.id, name: user.role.name },
    permissions: ctx.permissions,
  };
}

export async function listUsers(): Promise<UserListItem[]> {
  const users = await scopedDb.user.findMany({
    include: { role: true },
    orderBy: { firstName: "asc" },
  });

  return users.map((user) => ({
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    isActive: user.isActive,
    role: { id: user.role.id, name: user.role.name },
  }));
}

export async function listRoles(): Promise<RoleListItem[]> {
  const roles = await scopedDb.role.findMany({
    include: { _count: { select: { permissions: true } } },
    orderBy: { name: "asc" },
  });

  return roles.map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissionCount: role._count.permissions,
  }));
}
