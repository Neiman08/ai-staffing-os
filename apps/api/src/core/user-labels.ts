import { scopedDb } from "./tenancy/prisma-extension";

export async function labelUsers(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const users = await scopedDb.user.findMany({ where: { id: { in: ids } } });
  return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
}
