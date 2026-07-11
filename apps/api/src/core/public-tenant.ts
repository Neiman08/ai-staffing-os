import { prisma } from "@ai-staffing-os/db";
import { env } from "./env";
import { runWithTenancyContext } from "./tenancy/context";
import { AppError } from "./errors";

/**
 * F4.8: las rutas públicas (apps/api/src/modules/public/) corren SIN
 * tenancyMiddleware — no hay usuario logueado del que derivar
 * tenantId/permissions. Se resuelve el tenant configurado
 * (PUBLIC_TENANT_SLUG, default "titan" — el mismo tenant real de
 * siempre, nunca un id hardcodeado) una sola vez, y un usuario nominal
 * (primer CEO/Admin activo) para satisfacer el tipo de TenancyContext —
 * mismo patrón exacto que scheduler.ts usa para corridas sin un HTTP
 * request detrás. Nunca se le atribuye la acción a ese usuario en el
 * mensaje de la Activity — el campo `source`/`subject` real dice
 * "enviado desde el sitio público".
 */
let cachedTenantId: string | null = null;
let cachedOperatorUserId: string | null = null;

async function resolvePublicTenant(): Promise<{ tenantId: string; operatorUserId: string }> {
  if (cachedTenantId && cachedOperatorUserId) {
    return { tenantId: cachedTenantId, operatorUserId: cachedOperatorUserId };
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug: env.PUBLIC_TENANT_SLUG } });
  if (!tenant) {
    throw AppError.internal(`Tenant público no configurado (PUBLIC_TENANT_SLUG="${env.PUBLIC_TENANT_SLUG}" no existe).`);
  }
  const operator = await prisma.user.findFirst({
    where: { tenantId: tenant.id, isActive: true, role: { name: { in: ["CEO", "Admin"] } } },
    orderBy: { createdAt: "asc" },
  });
  if (!operator) {
    throw AppError.internal("Tenant público sin usuario operador (CEO/Admin) activo.");
  }

  cachedTenantId = tenant.id;
  cachedOperatorUserId = operator.id;
  return { tenantId: tenant.id, operatorUserId: operator.id };
}

/** Envuelve un handler público en el contexto de tenancy del tenant configurado. */
export async function runInPublicTenantContext<T>(fn: () => Promise<T>): Promise<T> {
  const { tenantId, operatorUserId } = await resolvePublicTenant();
  return runWithTenancyContext({ tenantId, userId: operatorUserId, permissions: [] }, fn);
}
