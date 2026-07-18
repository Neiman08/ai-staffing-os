import { z } from "zod";

export const currentUserSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  role: z.object({
    id: z.string(),
    name: z.string(),
  }),
  permissions: z.array(z.string()),
  // F10.1: identidad de portal -- el frontend usa esto para decidir a
  // qué shell/portal enrutar (interno vs. Client/Worker/Candidate
  // Portal), nunca el nombre del rol como string mágico. undefined para
  // todo personal interno.
  companyId: z.string().nullable().optional(),
  workerId: z.string().nullable().optional(),
  candidateId: z.string().nullable().optional(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

export const userListItemSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  isActive: z.boolean(),
  role: z.object({
    id: z.string(),
    name: z.string(),
  }),
  // F4.9 §9 del plan aprobado: el listado también expone esto — ver
  // docs/F4_9_PRODUCTION_AUTH_PLAN.md §4.7. activeSessionCount queda
  // fuera del listado a propósito (exigiría una llamada a Clerk por
  // fila); vive solo en userDetailSchema (GET /auth/users/:id).
  lastLoginAt: z.string().nullable(),
  mfaEnabled: z.boolean(),
  invitationStatus: z.enum(["NOT_INVITED", "PENDING", "ACCEPTED", "REVOKED", "EXPIRED"]),
});
export type UserListItem = z.infer<typeof userListItemSchema>;

export const roleListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissionCount: z.number(),
});
export type RoleListItem = z.infer<typeof roleListItemSchema>;

// F4.9: gestión real de usuarios (invitaciones, activar/desactivar,
// cambiar rol, revocar sesiones) — ver
// docs/F4_9_PRODUCTION_AUTH_PLAN.md §4.7.
export const userDetailSchema = userListItemSchema.extend({
  activeSessionCount: z.number(),
});
export type UserDetail = z.infer<typeof userDetailSchema>;

export const inviteUserInputSchema = z.object({
  email: z.string().email(),
  roleId: z.string().min(1),
});
export type InviteUserInput = z.infer<typeof inviteUserInputSchema>;

export const setUserStatusInputSchema = z.object({
  isActive: z.boolean(),
});
export type SetUserStatusInput = z.infer<typeof setUserStatusInputSchema>;

export const changeUserRoleInputSchema = z.object({
  roleId: z.string().min(1),
});
export type ChangeUserRoleInput = z.infer<typeof changeUserRoleInputSchema>;
