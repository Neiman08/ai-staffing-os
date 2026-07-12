import { test, expect } from "@playwright/test";

test("dashboard carga con datos reales, banner de dev-bypass visible, sin errores de consola", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto("/");
  await expect(page.getByText("DEV-BYPASS auth is active")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // Datos reales del seed, no un placeholder — confirma que la request
  // autenticada (dev-bypass, sin header explícito) efectivamente resolvió.
  await expect(page.getByRole("banner").getByText("Diego Fernández")).toBeVisible();

  expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
});
