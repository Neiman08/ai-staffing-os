import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { AppError } from "../../core/errors";
import { resolveIdentityFromClerkSession } from "./clerk-identity";

// F4.9: fixtures reales y aislados — un Tenant + User + Role propios de
// este archivo (nunca se toca el tenant "titan" real) para poder probar
// isActive=false, tenant inactivo y fuga entre tenants sin efectos
// secundarios en el resto de la suite.
const CLERK_ORG_ID = "org_test_f49_clerk_identity";
const CLERK_USER_ID = "user_test_f49_clerk_identity";
const CLERK_USER_ID_DISABLED = "user_test_f49_clerk_identity_disabled";
const CLERK_USER_ID_OTHER_TENANT = "user_test_f49_clerk_identity_other_tenant";

let tenantId: string;
let otherTenantId: string;
let roleId: string;

before(async () => {
  const tenant = await prisma.tenant.create({
    data: { name: "F4.9 Test Tenant", slug: "f49-clerk-identity-test", clerkOrganizationId: CLERK_ORG_ID },
  });
  tenantId = tenant.id;

  const otherTenant = await prisma.tenant.create({
    data: { name: "F4.9 Test Tenant (other)", slug: "f49-clerk-identity-test-other" },
  });
  otherTenantId = otherTenant.id;

  const permission = await prisma.permission.upsert({
    where: { key: "companies.view" },
    update: {},
    create: { key: "companies.view", label: "View Companies" },
  });

  const role = await prisma.role.create({
    data: {
      tenantId,
      name: "F4.9 Test Role",
      permissions: { create: [{ permissionId: permission.id }] },
    },
  });
  roleId = role.id;

  await prisma.user.create({
    data: {
      tenantId,
      clerkId: CLERK_USER_ID,
      email: "f49-clerk-identity-active@example.com",
      firstName: "Active",
      lastName: "User",
      roleId,
      isActive: true,
    },
  });

  await prisma.user.create({
    data: {
      tenantId,
      clerkId: CLERK_USER_ID_DISABLED,
      email: "f49-clerk-identity-disabled@example.com",
      firstName: "Disabled",
      lastName: "User",
      roleId,
      isActive: false,
    },
  });

  const otherRole = await prisma.role.create({ data: { tenantId: otherTenantId, name: "F4.9 Other Role" } });
  await prisma.user.create({
    data: {
      tenantId: otherTenantId,
      clerkId: CLERK_USER_ID_OTHER_TENANT,
      email: "f49-clerk-identity-other@example.com",
      firstName: "Other",
      lastName: "Tenant",
      roleId: otherRole.id,
      isActive: true,
    },
  });
});

after(async () => {
  await prisma.user.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } });
  await prisma.role.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } });
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
});

test("sin orgId en la sesión → 401 unauthorized", async () => {
  await assert.rejects(
    () => resolveIdentityFromClerkSession({ userId: CLERK_USER_ID, orgId: null, mfaVerified: false }),
    (err: unknown) => err instanceof AppError && err.status === 401,
  );
});

test("orgId que no mapea a ningún Tenant → 401 unauthorized", async () => {
  await assert.rejects(
    () => resolveIdentityFromClerkSession({ userId: CLERK_USER_ID, orgId: "org_does_not_exist", mfaVerified: false }),
    (err: unknown) => err instanceof AppError && err.status === 401,
  );
});

test("Tenant inactivo → 401 TENANT_INACTIVE", async () => {
  await prisma.tenant.update({ where: { id: tenantId }, data: { isActive: false } });
  try {
    await assert.rejects(
      () => resolveIdentityFromClerkSession({ userId: CLERK_USER_ID, orgId: CLERK_ORG_ID, mfaVerified: false }),
      (err: unknown) => err instanceof AppError && err.code === "TENANT_INACTIVE",
    );
  } finally {
    await prisma.tenant.update({ where: { id: tenantId }, data: { isActive: true } });
  }
});

test("userId sin User interno vinculado → 401 USER_NOT_PROVISIONED", async () => {
  await assert.rejects(
    () => resolveIdentityFromClerkSession({ userId: "user_never_provisioned", orgId: CLERK_ORG_ID, mfaVerified: false }),
    (err: unknown) => err instanceof AppError && err.code === "USER_NOT_PROVISIONED",
  );
});

test("User desactivado (isActive=false) → 403 USER_DISABLED", async () => {
  await assert.rejects(
    () => resolveIdentityFromClerkSession({ userId: CLERK_USER_ID_DISABLED, orgId: CLERK_ORG_ID, mfaVerified: false }),
    (err: unknown) => err instanceof AppError && err.code === "USER_DISABLED" && err.status === 403,
  );
});

test("fuga entre tenants: User real de OTRO tenant no puede resolver contra este orgId", async () => {
  await assert.rejects(
    () => resolveIdentityFromClerkSession({ userId: CLERK_USER_ID_OTHER_TENANT, orgId: CLERK_ORG_ID, mfaVerified: false }),
    (err: unknown) => err instanceof AppError && err.status === 401,
  );
});

test("camino feliz: resuelve tenantId/userId/permissions reales desde la DB", async () => {
  const identity = await resolveIdentityFromClerkSession({ userId: CLERK_USER_ID, orgId: CLERK_ORG_ID, mfaVerified: false });
  assert.equal(identity.tenantId, tenantId);
  assert.deepEqual(identity.permissions, ["companies.view"]);
  assert.notEqual(identity.userId, CLERK_USER_ID); // es el User.id interno, nunca el clerkId
});

test("mfaEnforced por default es false (Tenant.settings sin política configurada)", async () => {
  const identity = await resolveIdentityFromClerkSession({ userId: CLERK_USER_ID, orgId: CLERK_ORG_ID, mfaVerified: false });
  assert.equal(identity.mfaEnforced, false);
});

test("mfaVerified de la sesión se propaga tal cual (true y false)", async () => {
  const verified = await resolveIdentityFromClerkSession({ userId: CLERK_USER_ID, orgId: CLERK_ORG_ID, mfaVerified: true });
  assert.equal(verified.mfaVerified, true);

  const notVerified = await resolveIdentityFromClerkSession({ userId: CLERK_USER_ID, orgId: CLERK_ORG_ID, mfaVerified: false });
  assert.equal(notVerified.mfaVerified, false);
});

test("Tenant.settings.security.mfaEnforced=true se refleja en la identidad resuelta", async () => {
  await prisma.tenant.update({ where: { id: tenantId }, data: { settings: { security: { mfaEnforced: true } } } });
  try {
    const identity = await resolveIdentityFromClerkSession({ userId: CLERK_USER_ID, orgId: CLERK_ORG_ID, mfaVerified: false });
    assert.equal(identity.mfaEnforced, true);
  } finally {
    await prisma.tenant.update({ where: { id: tenantId }, data: { settings: {} } });
  }
});
