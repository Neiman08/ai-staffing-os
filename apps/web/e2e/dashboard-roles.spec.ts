import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";

// F6.8: el Dashboard ahora oculta tarjetas según el permiso real del rol
// (ver dashboard/service.ts) — verifica en un navegador real que la UI
// respeta lo que el backend ya no envía, para cada uno de los roles
// nombrados en el plan (CEO, Recruiter, Operations, Compliance,
// Accounting), más un chequeo de viewport mobile. Solo lectura.
async function setDevUser(page: Page, role: string) {
  await page.route("**/api/v1/**", (route) => {
    void route.continue({ headers: { ...route.request().headers(), "x-dev-user": `${role}@titan.dev` } });
  });
}

test("CEO ve todas las tarjetas operativas, incluyendo margen financiero", async ({ page }) => {
  await setDevUser(page, "ceo");
  await page.goto("/");

  await expect(page.getByText("Trabajadores activos")).toBeVisible();
  await expect(page.getByText("Job orders abiertas")).toBeVisible();
  await expect(page.getByText("Alertas de compliance")).toBeVisible();
  await expect(page.getByText("Margen bruto (7 días)")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Candidatos por estado" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Workers por compliance" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assignments por estado" })).toBeVisible();
});

test("Recruiter ve candidatos/workers/job orders pero no margen financiero", async ({ page }) => {
  await setDevUser(page, "recruiter");
  await page.goto("/");

  await expect(page.getByText("Trabajadores activos")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Candidatos por estado" })).toBeVisible();
  await expect(page.getByText("Margen bruto (7 días)")).toHaveCount(0);
});

test("Operations ve ocupación operativa pero no candidatos ni compliance ni margen", async ({ page }) => {
  await setDevUser(page, "operations");
  await page.goto("/");

  await expect(page.getByText("Trabajadores activos")).toBeVisible();
  await expect(page.getByText("Job orders abiertas")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assignments por estado" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Candidatos por estado" })).toHaveCount(0);
  await expect(page.getByText("Alertas de compliance")).toHaveCount(0);
  await expect(page.getByText("Margen bruto (7 días)")).toHaveCount(0);
});

test("Compliance ve alertas y breakdown de compliance de Workers", async ({ page }) => {
  await setDevUser(page, "compliance");
  await page.goto("/");

  await expect(page.getByText("Alertas de compliance")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Workers por compliance" })).toBeVisible();
  await expect(page.getByText("Margen bruto (7 días)")).toHaveCount(0);
});

test("Accounting solo ve el margen financiero, sin operativos ni compliance", async ({ page }) => {
  await setDevUser(page, "accounting");
  await page.goto("/");

  await expect(page.getByText("Margen bruto (7 días)")).toBeVisible();
  await expect(page.getByText("Trabajadores activos")).toHaveCount(0);
  await expect(page.getByText("Job orders abiertas")).toHaveCount(0);
  await expect(page.getByText("Alertas de compliance")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Candidatos por estado" })).toHaveCount(0);
});

test("mobile: el Dashboard renderiza sin overflow horizontal para Recruiter", async ({ page }) => {
  await setDevUser(page, "recruiter");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Candidatos por estado" })).toBeVisible();

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
});
