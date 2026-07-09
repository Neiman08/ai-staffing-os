import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedDb } from "./prisma-extension";
import { runWithTenancyContext } from "./context";

test("findMany on a tenant-scoped model without context throws instead of returning all rows", async () => {
  await assert.rejects(() => scopedDb.candidate.findMany(), /Tenancy context missing/);
});

test("findUnique on a tenant-scoped model without context throws", async () => {
  await assert.rejects(
    () => scopedDb.user.findUnique({ where: { id: "irrelevant" } }),
    /Tenancy context missing/,
  );
});

test("with context, hybrid global models (Industry) are visible regardless of tenant", async () => {
  await runWithTenancyContext({ tenantId: "tenant-titan", userId: "irrelevant", permissions: [] }, async () => {
    const industries = await scopedDb.industry.findMany();
    assert.equal(industries.length, 4);
  });
});

test("an unrelated tenant sees zero strict-model rows (no cross-tenant leak)", async () => {
  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      const candidates = await scopedDb.candidate.findMany();
      assert.equal(candidates.length, 0);
    },
  );
});

test("an unrelated tenant still sees hybrid global rows (Industry), but no tenant-specific ones", async () => {
  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      const industries = await scopedDb.industry.findMany();
      assert.equal(industries.length, 4);
      assert.ok(industries.every((i) => i.isGlobal));
    },
  );
});

// F1: verify-then-act coverage for update/delete on a real seeded row
// (company-01, from the F0 seed) — the row genuinely exists, so a naive
// implementation that skips the ownership check would happily update it
// from an unrelated tenant's context.
test("update on a strict model from an unrelated tenant is refused (no cross-tenant write)", async () => {
  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      await assert.rejects(
        () => scopedDb.company.update({ where: { id: "company-01" }, data: { notes: "hijacked" } }),
        /not found/i,
      );
    },
  );

  await runWithTenancyContext({ tenantId: "tenant-titan", userId: "irrelevant", permissions: [] }, async () => {
    const company = await scopedDb.company.findUnique({ where: { id: "company-01" } });
    assert.notEqual(company?.notes, "hijacked");
  });
});

test("update on a strict model from the owning tenant succeeds", async () => {
  await runWithTenancyContext({ tenantId: "tenant-titan", userId: "irrelevant", permissions: [] }, async () => {
    const before = await scopedDb.company.findUnique({ where: { id: "company-01" } });
    const updated = await scopedDb.company.update({
      where: { id: "company-01" },
      data: { notes: "verify-then-act test" },
    });
    assert.equal(updated.notes, "verify-then-act test");

    // Revert so the test is side-effect free on rerun.
    await scopedDb.company.update({ where: { id: "company-01" }, data: { notes: before?.notes ?? null } });
  });
});

test("delete on a strict model from an unrelated tenant is refused", async () => {
  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: [] },
    async () => {
      // Contact belonging to company-01 (tenant-titan) — pick any contact
      // that exists but don't actually delete it: assert the rejection only.
      await assert.rejects(
        () => scopedDb.contact.delete({ where: { id: "contact-company-01-1" } }),
        /not found/i,
      );
    },
  );
});
