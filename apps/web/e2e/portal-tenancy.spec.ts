import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";

// F10.11: la lista mínima de tenancy/IDOR de la spec, verificada en un
// navegador real contra el backend/DB reales (dev-bypass, tenant-titan
// + tenant-acme, ambos ya seedeados). Nunca mocks de frontend.
//
// Fixtures reales usadas (confirmadas contra la DB de dev):
// - client-admin@titan.dev -> company-01, cuyo único Job Order real es joborder-03.
// - joborder-01 pertenece a company-03 (MISMO tenant, OTRA company) -- el caso de
//   IDOR "misma organización, otro cliente" que la spec pide explícito.
// - client-admin@acme.dev -> tenant-acme, company-acme-01 -- el caso de
//   aislamiento de TENANT completo.
async function setDevUser(page: Page, email: string) {
  await page.route("**/api/v1/**", (route) => {
    void route.continue({ headers: { ...route.request().headers(), "x-dev-user": email } });
  });
}

test.describe("Portal tenancy / IDOR", () => {
  test("un CLIENT_ADMIN nunca ve el Job Order de OTRA company del mismo tenant, ni por navegación ni por URL directa", async ({ page }) => {
    await setDevUser(page, "client-admin@titan.dev");

    await page.goto("/portal/client/job-orders");
    await expect(page.getByRole("heading", { name: "Job Orders" })).toBeVisible();
    // joborder-01 (company-03) nunca debe listarse para company-01.
    await expect(page.getByText("Forklift Operators — Night Shift")).toHaveCount(0);

    // Acceso directo por URL a un Job Order de otra company -- debe
    // fallar de forma segura (nunca mostrar los datos reales de company-03).
    await page.goto("/portal/client/job-orders/joborder-01");
    await expect(page.getByText("Forklift Operators — Night Shift")).toHaveCount(0);
  });

  test("un CLIENT_ADMIN nunca ve pay rate interno ni margen -- solo lo que el DTO de F10.2 expone", async ({ page }) => {
    await setDevUser(page, "client-admin@titan.dev");
    await page.goto("/portal/client/job-orders/joborder-03");
    await expect(page.getByRole("heading", { name: "Journeyman Electricians — Data Center Buildout" })).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/pay rate/i);
    expect(bodyText).not.toMatch(/margin|margen/i);
  });

  test("client-admin@acme.dev (tenant-acme) nunca ve datos de tenant-titan, ni siquiera manipulando la URL", async ({ page }) => {
    await setDevUser(page, "client-admin@acme.dev");

    await page.goto("/portal/client");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    await page.goto("/portal/client/job-orders/joborder-03");
    await expect(page.getByText("Journeyman Electricians")).toHaveCount(0);

    await page.goto("/portal/client/job-requests");
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("Journeyman Electricians");
  });

  test("un WORKER nunca ve bill rate, y la app lo redirige lejos del backoffice interno", async ({ page }) => {
    await setDevUser(page, "worker-portal@titan.dev");

    await page.goto("/");
    await expect(page).toHaveURL(/\/portal\/worker/);

    await page.goto("/portal/worker/assignments");
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/bill rate/i);
  });

  test("una CANDIDATE nunca ve rank/score/reasons de scoring interno en sus applications", async ({ page }) => {
    await setDevUser(page, "candidate-portal@titan.dev");

    await page.goto("/");
    await expect(page).toHaveURL(/\/portal\/candidate/);

    await page.goto("/portal/candidate/applications");
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/\bscore\b/i);
    expect(bodyText).not.toMatch(/\brank\b/i);
  });

  test("acceso directo a un endpoint interno prohibido (vía fetch en el navegador) devuelve 403, nunca datos reales", async ({ page }) => {
    await setDevUser(page, "worker-portal@titan.dev");
    await page.goto("/portal/worker");

    const status = await page.evaluate(async () => {
      const res = await fetch("/api/v1/workers?limit=100", { headers: { "content-type": "application/json" } });
      return res.status;
    });
    expect(status).toBe(403);
  });

  test("un CLIENT_MANAGER (sin auditLogs.view) recibe 403 real al pedir el audit trail directamente, la UI no es la única barrera", async ({ page }) => {
    await setDevUser(page, "client-manager@titan.dev");
    await page.goto("/portal/client");

    const status = await page.evaluate(async () => {
      const res = await fetch("/api/v1/portal/client/audit-log", { headers: { "content-type": "application/json" } });
      return res.status;
    });
    expect(status).toBe(403);
  });
});
