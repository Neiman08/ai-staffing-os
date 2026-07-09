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
