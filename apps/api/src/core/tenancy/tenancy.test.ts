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
