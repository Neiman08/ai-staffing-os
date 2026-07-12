import type {
  UserJSON,
  UserDeletedJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
} from "@clerk/backend";
import { prisma } from "@ai-staffing-os/db";

/**
 * F4.9: handlers puros — reciben el payload YA verificado (firma/svix
 * chequeada en webhook.router.ts antes de llegar acá) y solo hacen
 * upserts/updates por clave natural (clerkId, slug), nunca `create`
 * ciego. Cada handler puede recibir el mismo evento 2+ veces (Clerk
 * reintenta webhooks fallidos) sin duplicar ni corromper nada — así se
 * pueden testear directo con payloads simulados, sin necesitar una
 * firma svix real.
 */

function primaryEmail(data: UserJSON): string | null {
  const match = data.email_addresses.find((e) => e.id === data.primary_email_address_id);
  return match?.email_address ?? null;
}

/**
 * Nunca autoprovisiona: solo vincula un Clerk user a un User interno que
 * YA existe con invitationStatus=PENDING y ese email (creado por
 * POST /auth/users/invite, ver F4.9-9). Si no hay invitación pendiente
 * con ese email, no se crea nada — incluye el caso de la primera cuenta
 * CEO/Admin real, que se vincula manualmente (ver
 * docs/F4_9_PRODUCTION_AUTH_PLAN.md §5/§6, bootstrap fuera de este
 * webhook).
 */
export async function handleUserCreated(data: UserJSON): Promise<void> {
  const email = primaryEmail(data);
  if (!email) return;

  const pending = await prisma.user.findFirst({
    where: { email, invitationStatus: "PENDING", clerkId: null },
  });
  if (!pending) return;

  await prisma.user.update({
    where: { id: pending.id },
    data: {
      clerkId: data.id,
      firstName: data.first_name ?? pending.firstName,
      lastName: data.last_name ?? pending.lastName,
      mfaEnabled: data.two_factor_enabled,
      invitationStatus: "ACCEPTED",
    },
  });
}

export async function handleUserUpdated(data: UserJSON): Promise<void> {
  const email = primaryEmail(data);
  const before = await prisma.user.findUnique({ where: { clerkId: data.id } });
  if (!before) return; // no-op honesto: nada vinculado a este clerkId todavía

  await prisma.user.update({
    where: { id: before.id },
    data: {
      firstName: data.first_name ?? undefined,
      lastName: data.last_name ?? undefined,
      mfaEnabled: data.two_factor_enabled,
      email: email ?? undefined,
    },
  });

  // F4.9 §12: "activación de MFA" — el único momento en que sabemos con
  // certeza que un usuario activó MFA es esta transición false→true
  // sincronizada desde Clerk (fuente de verdad real de MFA).
  if (!before.mfaEnabled && data.two_factor_enabled) {
    await prisma.auditLog.create({
      data: {
        tenantId: before.tenantId,
        actorType: "HUMAN",
        actorId: before.id,
        action: "auth.mfa_enabled",
        entityType: "user",
        entityId: before.id,
      },
    });
  }
}

/**
 * Nunca borra — Clerk ya no tiene la cuenta, pero Lead/Activity/
 * AuditLog/etc. siguen referenciando este User.id (ver
 * activity-log.ts performedById). Desactivar preserva integridad
 * histórica.
 */
export async function handleUserDeleted(data: UserDeletedJSON): Promise<void> {
  if (!data.id) return;
  await prisma.user.updateMany({ where: { clerkId: data.id }, data: { isActive: false } });
}

/**
 * El único momento en que Tenant.clerkOrganizationId se completa solo:
 * cuando el PO crea la organización real en Clerk con el mismo slug que
 * ya tiene el Tenant sembrado (ver seed.ts, "titan"), este handler la
 * vincula automáticamente — nunca hace falta editar la DB a mano.
 * Nunca sobreescribe un vínculo ya establecido con una organización
 * distinta (evita que un evento fuera de orden secuestre el mapeo).
 */
export async function handleOrganizationCreatedOrUpdated(data: OrganizationJSON): Promise<void> {
  await prisma.tenant.updateMany({
    where: { slug: data.slug, clerkOrganizationId: null },
    data: { clerkOrganizationId: data.id },
  });
}

/**
 * Consistencia, no asignación de rol: el rol interno (CEO/Admin/Sales/
 * ...) es exclusivamente una decisión nuestra (PATCH /auth/users/:id/role,
 * F4.9-9) — Clerk solo conoce "admin"/"member" a nivel de organización,
 * un vocabulario mucho más chico que nuestros 11 roles reales. Este
 * handler no lo toca. Si el User todavía no está vinculado (clerkId
 * null) no hay nada que reconciliar todavía — user.created se encarga.
 */
export async function handleOrganizationMembershipUpsert(data: OrganizationMembershipJSON): Promise<void> {
  const clerkUserId = data.public_user_data.user_id;
  const user = await prisma.user.findUnique({ where: { clerkId: clerkUserId } });
  if (!user) return;

  const tenant = await prisma.tenant.findUnique({ where: { clerkOrganizationId: data.organization.id } });
  if (!tenant || tenant.id !== user.tenantId) {
    // Inconsistencia real de datos (membership de una organización que
    // no es la del tenant del User) — nunca se corrige sola, se deja
    // para revisión manual en vez de mover al usuario de tenant.
    console.error(
      `Clerk organizationMembership mismatch: user ${user.id} tenant ${user.tenantId} vs organization ${data.organization.id}`,
    );
  }
}

/**
 * Perder la membership en Clerk = perder acceso, ya (no solo "la
 * próxima vez que intente entrar"). isActive=false, nunca delete — ver
 * §8 del plan aprobado: "Preferir isActive=false; auditoría append-only".
 */
export async function handleOrganizationMembershipDeleted(data: OrganizationMembershipJSON): Promise<void> {
  const clerkUserId = data.public_user_data.user_id;
  await prisma.user.updateMany({ where: { clerkId: clerkUserId }, data: { isActive: false } });
}
