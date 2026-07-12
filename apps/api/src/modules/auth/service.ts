import { clerkClient } from "@clerk/express";
import type {
  ChangeUserRoleInput,
  CurrentUser,
  InviteUserInput,
  RoleListItem,
  SetUserStatusInput,
  UserDetail,
  UserListItem,
} from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";

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
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    mfaEnabled: user.mfaEnabled,
    invitationStatus: user.invitationStatus,
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

async function activeSessionCountFor(clerkId: string | null): Promise<number> {
  if (!clerkId || env.AUTH_MODE !== "clerk") return 0;
  const sessions = await clerkClient.sessions.getSessionList({ userId: clerkId, status: "active" });
  return sessions.data.length;
}

export async function getUserDetail(userId: string): Promise<UserDetail> {
  const user = await scopedDb.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!user) throw AppError.notFound("User not found");

  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    isActive: user.isActive,
    role: { id: user.role.id, name: user.role.name },
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    mfaEnabled: user.mfaEnabled,
    invitationStatus: user.invitationStatus,
    activeSessionCount: await activeSessionCountFor(user.clerkId),
  };
}

/**
 * F4.9 §4.7/§5: nunca autoprovisiona un login — crea el User interno en
 * PENDING (sin clerkId) y, si hay una organización de Clerk vinculada,
 * envía la invitación real vía Clerk (rol de Clerk fijo "org:member":
 * el rol de negocio real es roleId, nunca se sincroniza desde Clerk,
 * ver webhook-handlers.ts). El caller (router) es responsable de exigir
 * confirmación explícita antes de invocar esto con AUTH_MODE=clerk —
 * "no enviar invitaciones reales sin aprobación" es una decisión de
 * producto, no algo que esta función pueda saber por sí sola.
 */
export async function inviteUser(input: InviteUserInput): Promise<{ userId: string }> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const role = await scopedDb.role.findFirst({ where: { id: input.roleId } });
  if (!role) throw AppError.badRequest("Invalid role for this tenant");

  const existing = await scopedDb.user.findFirst({ where: { email: input.email } });
  if (existing) throw AppError.badRequest("A user with this email already exists in this tenant");

  const created = await scopedDb.user.create({
    data: {
      tenantId: ctx.tenantId,
      email: input.email,
      firstName: "Invited",
      lastName: "User",
      roleId: input.roleId,
      isActive: true,
      invitationStatus: "PENDING",
    },
  });

  if (env.AUTH_MODE === "clerk") {
    const tenant = await scopedDb.tenant.findUnique({ where: { id: ctx.tenantId } });
    if (!tenant?.clerkOrganizationId) {
      throw AppError.badRequest("This tenant is not linked to a Clerk organization yet");
    }
    const inviter = await scopedDb.user.findUnique({ where: { id: ctx.userId } });
    await clerkClient.organizations.createOrganizationInvitation({
      organizationId: tenant.clerkOrganizationId,
      emailAddress: input.email,
      role: "org:member",
      inviterUserId: inviter?.clerkId ?? undefined,
    });
  }

  return { userId: created.id };
}

export async function setUserStatus(userId: string, input: SetUserStatusInput): Promise<void> {
  const user = await scopedDb.user.update({ where: { id: userId }, data: { isActive: input.isActive } });

  // Desactivar = perder acceso ya, no "la próxima vez que expire el
  // token" — revoca cualquier sesión activa de Clerk en el mismo paso.
  if (!input.isActive) {
    await revokeUserSessions(userId, user.clerkId);
  }
}

export async function changeUserRole(userId: string, input: ChangeUserRoleInput): Promise<void> {
  const role = await scopedDb.role.findFirst({ where: { id: input.roleId } });
  if (!role) throw AppError.badRequest("Invalid role for this tenant");

  await scopedDb.user.update({ where: { id: userId }, data: { roleId: input.roleId } });
}

export async function revokeUserSessions(userId: string, knownClerkId?: string | null): Promise<void> {
  if (env.AUTH_MODE !== "clerk") return;

  const clerkId = knownClerkId ?? (await scopedDb.user.findUnique({ where: { id: userId } }))?.clerkId;
  if (!clerkId) return;

  const sessions = await clerkClient.sessions.getSessionList({ userId: clerkId, status: "active" });
  await Promise.all(sessions.data.map((s) => clerkClient.sessions.revokeSession(s.id)));
}
