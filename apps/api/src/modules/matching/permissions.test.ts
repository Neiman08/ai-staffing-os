// F6.1: tests de RBAC para matching.view/matching.run. Sin router/
// endpoint todavía (F6.1 no lo incluye) — se verifica en dos capas:
// (1) los grants reales sembrados en DB para cada rol coinciden
// exactamente con la matriz aprobada; (2) el middleware genérico
// requirePermission() se comporta correctamente dado el conjunto real
// de permisos de cada rol (mismo patrón de
// core/rbac/require-permission.test.ts, sin necesidad de un servidor
// HTTP real).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { prisma } from "@ai-staffing-os/db";
import { requirePermission } from "../../core/rbac/require-permission";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";

const TENANT_ID = "tenant-titan";

// Matriz aprobada por el PO (F6.1) — CEO/Admin/Recruiter: view+run;
// Operations/Compliance/Manager: solo view; el resto: sin acceso.
const EXPECTED_MATCHING_ACCESS: Record<string, { view: boolean; run: boolean }> = {
  CEO: { view: true, run: true },
  Admin: { view: true, run: true },
  Recruiter: { view: true, run: true },
  Operations: { view: true, run: false },
  Compliance: { view: true, run: false },
  Manager: { view: true, run: false },
  Payroll: { view: false, run: false },
  Accounting: { view: false, run: false },
  Sales: { view: false, run: false },
  Marketing: { view: false, run: false },
  HR: { view: false, run: false },
};

async function loadRolePermissionKeys(roleName: string): Promise<string[]> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: TENANT_ID, name: roleName } },
    include: { permissions: { include: { permission: true } } },
  });
  return role.permissions.map((rp) => rp.permission.key);
}

function runMiddleware(permission: Parameters<typeof requirePermission>[0], permissions: string[]): Promise<unknown> {
  return runWithTenancyContext({ tenantId: TENANT_ID, userId: "u-test", permissions }, () =>
    new Promise((resolve) => {
      requirePermission(permission)({} as Request, {} as Response, (err?: unknown) => resolve(err));
    }),
  );
}

for (const [roleName, expected] of Object.entries(EXPECTED_MATCHING_ACCESS)) {
  test(`RBAC matching — ${roleName}: view=${expected.view} run=${expected.run} (grants reales sembrados)`, async () => {
    const keys = await loadRolePermissionKeys(roleName);
    assert.equal(keys.includes("matching.view"), expected.view, `${roleName}.matching.view esperado=${expected.view}`);
    assert.equal(keys.includes("matching.run"), expected.run, `${roleName}.matching.run esperado=${expected.run}`);

    const viewErr = await runMiddleware("matching.view", keys);
    if (expected.view) {
      assert.equal(viewErr, undefined, `${roleName} debería pasar matching.view`);
    } else {
      assert.ok(viewErr instanceof AppError, `${roleName} debería recibir 403 en matching.view`);
      assert.equal((viewErr as AppError).status, 403);
    }

    const runErr = await runMiddleware("matching.run", keys);
    if (expected.run) {
      assert.equal(runErr, undefined, `${roleName} debería pasar matching.run`);
    } else {
      assert.ok(runErr instanceof AppError, `${roleName} debería recibir 403 en matching.run`);
      assert.equal((runErr as AppError).status, 403);
    }
  });
}

test("ningún rol tiene matching.run sin matching.view (run implica view en la matriz aprobada)", async () => {
  for (const roleName of Object.keys(EXPECTED_MATCHING_ACCESS)) {
    const keys = await loadRolePermissionKeys(roleName);
    if (keys.includes("matching.run")) {
      assert.ok(keys.includes("matching.view"), `${roleName} tiene matching.run pero no matching.view`);
    }
  }
});

test("Operations, Compliance y Manager específicamente NO tienen matching.run (regla explícita del PO)", async () => {
  for (const roleName of ["Operations", "Compliance", "Manager"]) {
    const keys = await loadRolePermissionKeys(roleName);
    assert.equal(keys.includes("matching.run"), false, `${roleName} no debe tener matching.run`);
  }
});
