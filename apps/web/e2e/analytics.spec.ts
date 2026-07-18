// F11.11: e2e real (navegador + backend + DB reales, dev-bypass) para la
// sección Analytics/BI (F11.2-F11.9) -- executive dashboard, los 3
// drill-downs, filtros, export CSV, RBAC de campo y tenancy/redirect de
// identidades de portal.

import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";

async function setDevUser(page: Page, email: string) {
  await page.route("**/api/v1/**", (route) => {
    void route.continue({ headers: { ...route.request().headers(), "x-dev-user": email } });
  });
}

test.describe("Analytics / BI", () => {
  test("Executive Dashboard: CEO ve KPIs reales de los 4 dominios, sin errores de consola", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await setDevUser(page, "ceo@titan.dev");

    await page.goto("/analytics");
    await expect(page.getByRole("heading", { name: "Executive Dashboard" })).toBeVisible();
    await expect(page.getByText("ACTIVE WORKERS")).toBeVisible();
    await expect(page.getByText("PIPELINE VALUE")).toBeVisible();
    await expect(page.getByText("WEEKLY GROSS MARGIN")).toBeVisible();

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("Recruiting: funnel real, filtro from/to lo recalcula, export CSV descarga un archivo real", async ({ page }) => {
    await setDevUser(page, "recruiter@titan.dev");
    await page.goto("/analytics/recruiting");

    await expect(page.getByRole("heading", { name: "Recruiting Metrics" })).toBeVisible();
    await expect(page.getByText("SOURCED")).toBeVisible();

    const sourcedBefore = await page.locator("text=SOURCED").locator("xpath=following-sibling::div").first().textContent();
    expect(Number(sourcedBefore)).toBeGreaterThan(0);

    await page.locator("#analytics-from").fill("2010-01-01");
    await page.locator("#analytics-to").fill("2010-01-02");
    await expect(page.locator("text=SOURCED").locator("xpath=following-sibling::div").first()).toHaveText("0");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Export CSV/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^recruiting-metrics-.*\.csv$/);
  });

  test("Commercial: sales ve win-rate real; recruiter (sin permiso comercial) ve el estado vacío, nunca un crash", async ({ page }) => {
    await setDevUser(page, "sales@titan.dev");
    await page.goto("/analytics/commercial");
    await expect(page.getByText("OPPORTUNITIES WON")).toBeVisible();
    await expect(page.getByText("WIN RATE")).toBeVisible();

    await setDevUser(page, "recruiter@titan.dev");
    await page.goto("/analytics/commercial");
    await expect(page.getByText("No commercial metrics available")).toBeVisible();
  });

  test("Financial: accounting ve margin trend, invoice aging y payroll cost reales", async ({ page }) => {
    await setDevUser(page, "accounting@titan.dev");
    await page.goto("/analytics/financial");

    await expect(page.getByRole("heading", { name: "Financial Metrics" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Invoice Aging" })).toBeVisible();
    await expect(page.getByText("TOTAL GROSS")).toBeVisible();
  });

  test("tenancy: ninguna identidad de portal llega al backoffice interno -- redirige a su propio portal", async ({ page }) => {
    await setDevUser(page, "worker-portal@titan.dev");
    await page.goto("/analytics");
    await expect(page).toHaveURL(/\/portal\/worker/);
  });

  test("tenancy: acceso directo por fetch() a un endpoint de analítica desde una identidad de portal devuelve 403, nunca datos reales", async ({ page }) => {
    await setDevUser(page, "candidate-portal@titan.dev");
    await page.goto("/portal/candidate");

    const status = await page.evaluate(async () => {
      const res = await fetch("/api/v1/analytics/commercial", { headers: { "content-type": "application/json" } });
      return res.status;
    });
    expect(status).toBe(403);
  });
});
