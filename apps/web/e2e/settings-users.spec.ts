import { test, expect } from "@playwright/test";

// F4.9-11: email único por corrida — inviteUser bloquea duplicados por
// email (correcto: ver user-management.test.ts), así que reusar un
// email fijo rompería la re-ejecución de la suite (la segunda corrida
// siempre fallaría con 400). Se desactiva al final en vez de borrar —
// apps/web no depende de @ai-staffing-os/db (frontera de paquetes a
// propósito, ver docs/F4_9_PRODUCTION_AUTH_PLAN.md), así que la
// limpieza pasa por la misma API que usaría un Admin real.
const TEST_EMAIL = `playwright-e2e-invite-${Date.now()}@example.com`;

test.afterAll(async () => {
  const res = await fetch("http://localhost:4000/api/v1/auth/users", {
    headers: { "x-dev-user": "admin@titan.dev" },
  });
  const users = (await res.json()) as Array<{ id: string; email: string }>;
  const created = users.find((u) => u.email === TEST_EMAIL);
  if (created) {
    await fetch(`http://localhost:4000/api/v1/auth/users/${created.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-dev-user": "admin@titan.dev" },
      body: JSON.stringify({ isActive: false }),
    });
  }
});

test("invitar un usuario real desde la UI crea el registro y se ve con estado Invitation pending", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Usuarios" })).toBeVisible();

  await page.getByRole("button", { name: "Invite user" }).click();
  await page.getByLabel("Email").fill(TEST_EMAIL);
  await page.getByRole("button", { name: "Send invitation" }).click();

  await expect(page.getByText("Invitation sent")).toBeVisible();

  const row = page.getByRole("row", { name: TEST_EMAIL });
  await expect(row).toBeVisible();
  await expect(row.getByText("Invitation pending")).toBeVisible();

  expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
});
