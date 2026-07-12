import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { UserJSON, UserDeletedJSON, OrganizationJSON, OrganizationMembershipJSON } from "@clerk/backend";
import { prisma } from "@ai-staffing-os/db";
import {
  handleUserCreated,
  handleUserUpdated,
  handleUserDeleted,
  handleOrganizationCreatedOrUpdated,
  handleOrganizationMembershipDeleted,
} from "./webhook-handlers";

// F4.9: payloads mínimos con solo los campos que los handlers realmente
// leen — no se simula el objeto completo de Clerk, solo lo necesario
// para que el test sea honesto sobre qué se está probando.
function fakeUserJSON(overrides: Partial<UserJSON> = {}): UserJSON {
  return {
    id: "user_fake",
    first_name: "Fake",
    last_name: "User",
    primary_email_address_id: "email_1",
    email_addresses: [{ id: "email_1", email_address: "fake@example.com" }] as UserJSON["email_addresses"],
    two_factor_enabled: false,
    ...overrides,
  } as UserJSON;
}

const TENANT_SLUG = "f49-webhook-test";
let tenantId: string;
let roleId: string;

before(async () => {
  const tenant = await prisma.tenant.create({ data: { name: "F4.9 Webhook Test Tenant", slug: TENANT_SLUG } });
  tenantId = tenant.id;
  const role = await prisma.role.create({ data: { tenantId, name: "F4.9 Webhook Test Role" } });
  roleId = role.id;
});

after(async () => {
  await prisma.user.deleteMany({ where: { tenantId } });
  await prisma.role.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
});

test("user.created: sin invitación PENDING con ese email, no crea ni vincula nada", async () => {
  await handleUserCreated(fakeUserJSON({ id: "user_no_invite", email_addresses: [{ id: "e", email_address: "nobody-invited@example.com" }] as UserJSON["email_addresses"] }));
  const found = await prisma.user.findUnique({ where: { clerkId: "user_no_invite" } });
  assert.equal(found, null);
});

test("user.created: vincula una invitación PENDING real por email, marca ACCEPTED", async () => {
  const invited = await prisma.user.create({
    data: {
      tenantId,
      email: "invited@example.com",
      firstName: "Placeholder",
      lastName: "Name",
      roleId,
      invitationStatus: "PENDING",
    },
  });

  await handleUserCreated(
    fakeUserJSON({
      id: "user_invited_real",
      first_name: "Real",
      last_name: "Name",
      two_factor_enabled: true,
      email_addresses: [{ id: "e", email_address: "invited@example.com" }] as UserJSON["email_addresses"],
      primary_email_address_id: "e",
    }),
  );

  const after1 = await prisma.user.findUnique({ where: { id: invited.id } });
  assert.equal(after1?.clerkId, "user_invited_real");
  assert.equal(after1?.invitationStatus, "ACCEPTED");
  assert.equal(after1?.firstName, "Real");
  assert.equal(after1?.mfaEnabled, true);

  // Idempotencia: procesar el mismo evento otra vez no debe fallar ni
  // duplicar — ya no hay ninguna invitación PENDING con ese email
  // (quedó ACCEPTED), así que el segundo intento es un no-op seguro.
  await handleUserCreated(
    fakeUserJSON({
      id: "user_invited_real",
      email_addresses: [{ id: "e", email_address: "invited@example.com" }] as UserJSON["email_addresses"],
      primary_email_address_id: "e",
    }),
  );
  const count = await prisma.user.count({ where: { email: "invited@example.com", tenantId } });
  assert.equal(count, 1);
});

test("user.updated: sincroniza nombre y mfaEnabled por clerkId, no-op si no existe", async () => {
  const user = await prisma.user.create({
    data: { tenantId, email: "update-me@example.com", firstName: "Old", lastName: "Name", roleId, clerkId: "user_to_update" },
  });

  await handleUserUpdated(
    fakeUserJSON({ id: "user_to_update", first_name: "New", last_name: "Name", two_factor_enabled: true }),
  );

  const updated = await prisma.user.findUnique({ where: { id: user.id } });
  assert.equal(updated?.firstName, "New");
  assert.equal(updated?.mfaEnabled, true);

  // No-op honesto: clerkId inexistente no crea ni lanza.
  await assert.doesNotReject(() => handleUserUpdated(fakeUserJSON({ id: "user_does_not_exist" })));
});

test("user.deleted: nunca borra, solo isActive=false — idempotente", async () => {
  const user = await prisma.user.create({
    data: { tenantId, email: "to-delete@example.com", firstName: "X", lastName: "Y", roleId, clerkId: "user_to_delete", isActive: true },
  });

  const payload: UserDeletedJSON = { object: "user", id: "user_to_delete", deleted: true };
  await handleUserDeleted(payload);
  await handleUserDeleted(payload); // idempotente

  const found = await prisma.user.findUnique({ where: { id: user.id } });
  assert.notEqual(found, null); // sigue existiendo
  assert.equal(found?.isActive, false);
});

test("organization.created: vincula Tenant.clerkOrganizationId por slug, nunca pisa un vínculo existente", async () => {
  const orgPayload = { id: "org_fake_1", slug: TENANT_SLUG } as OrganizationJSON;
  await handleOrganizationCreatedOrUpdated(orgPayload);
  let tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  assert.equal(tenant?.clerkOrganizationId, "org_fake_1");

  // Reintento con un id distinto (evento fuera de orden / reenviado con
  // otro payload) — el vínculo ya establecido no se pisa.
  await handleOrganizationCreatedOrUpdated({ id: "org_fake_2", slug: TENANT_SLUG } as OrganizationJSON);
  tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  assert.equal(tenant?.clerkOrganizationId, "org_fake_1");
});

test("organizationMembership.deleted: desactiva al User por clerkId, nunca borra", async () => {
  const user = await prisma.user.create({
    data: { tenantId, email: "member-removed@example.com", firstName: "X", lastName: "Y", roleId, clerkId: "user_membership_removed", isActive: true },
  });

  const payload = {
    organization: { id: "org_fake_1" },
    public_user_data: { user_id: "user_membership_removed" },
  } as OrganizationMembershipJSON;
  await handleOrganizationMembershipDeleted(payload);

  const found = await prisma.user.findUnique({ where: { id: user.id } });
  assert.equal(found?.isActive, false);
});
