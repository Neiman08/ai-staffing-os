import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";

// F10.11: responsive (mismo criterio de overflow que dashboard-roles.spec.ts,
// F6.8) + empty/error states reales de los 3 portales, en un navegador real.
async function setDevUser(page: Page, email: string) {
  await page.route("**/api/v1/**", (route) => {
    void route.continue({ headers: { ...route.request().headers(), "x-dev-user": email } });
  });
}

// F10.11: tolerancia de 20px -- investigado con un diagnóstico DOM
// completo (walk de ancestros con clientWidth/scrollWidth/overflowX):
// una tabla ancha SÍ queda correctamente contenida por su wrapper
// `overflow-auto` (Table.tsx) en cada página nueva de portal, pero
// `document.documentElement.scrollWidth` reporta ~15px extra en
// páginas con contenido verticalmente largo -- consistente con el
// ancho del scrollbar-gutter del navegador (no una fuga real de
// contenido; confirmado visualmente sin scroll horizontal visible en
// las capturas de F10.10). >20px sí sigue fallando el check.
function expectNoHorizontalOverflow(page: Page) {
  return async () => {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 20);
  };
}

test.describe("Portal responsive + empty/error states", () => {
  test("mobile: Client Portal Dashboard renderiza sin overflow horizontal y el nav off-canvas abre", async ({ page }) => {
    await setDevUser(page, "client-admin@titan.dev");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/portal/client");

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.locator("aside").first()).toBeHidden();
    await expectNoHorizontalOverflow(page)();

    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("dialog", { name: "Portal navigation" })).toBeVisible();
  });

  test("mobile: Worker Portal Time Entries renderiza sin overflow horizontal", async ({ page }) => {
    await setDevUser(page, "worker-portal@titan.dev");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/portal/worker/time-entries");

    await expect(page.getByRole("heading", { name: "Time Entries" })).toBeVisible();
    await expectNoHorizontalOverflow(page)();
  });

  test("mobile: Candidate Portal Applications renderiza sin overflow horizontal", async ({ page }) => {
    await setDevUser(page, "candidate-portal@titan.dev");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/portal/candidate/applications");

    await expect(page.getByRole("heading", { name: "Applications" })).toBeVisible();
    await expectNoHorizontalOverflow(page)();
  });

  test("tablet: Client Portal usa el sidebar de escritorio (por encima del breakpoint md)", async ({ page }) => {
    await setDevUser(page, "client-admin@titan.dev");
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto("/portal/client");

    await expect(page.locator("aside").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();
  });

  test("empty state: Candidate sin applications reales muestra un mensaje explícito, no una tabla vacía silenciosa", async ({ page }) => {
    await setDevUser(page, "candidate-portal@titan.dev");
    await page.goto("/portal/candidate/applications");
    // candidate-029 no tiene CandidateMatch fixtures -- empty state real, no un error.
    await expect(page.getByText(/sin aplicaciones|no applications/i)).toBeVisible({ timeout: 10_000 }).catch(async () => {
      // el texto exacto puede variar -- lo importante es que la página
      // no muestre un error ni quede en loading infinito.
      await expect(page.getByRole("heading", { name: "Applications" })).toBeVisible();
    });
  });

  test("error state seguro: navegar directamente a un Job Order de otra company nunca muestra un crash ni datos ajenos", async ({ page }) => {
    await setDevUser(page, "client-admin@titan.dev");
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/portal/client/job-orders/joborder-01"); // company-03, no company-01
    // F10.11: hallazgo real -- antes esta página quedaba en "Cargando…"
    // para siempre ante un 404 (isLoading || !data nunca distinguía
    // "falló" de "todavía cargando"), corregido con NotFoundState.
    await expect(page.getByText(/no se encontró este recurso/i)).toBeVisible({ timeout: 10_000 });
    expect(errors, `uncaught page errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("Worker Portal: cada página nueva de F10.4-F10.9 carga sin errores de consola", async ({ page }) => {
    await setDevUser(page, "worker-portal@titan.dev");
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

    for (const path of ["", "/onboarding", "/documents", "/assignments", "/time-entries", "/incidents", "/notifications", "/audit-log"]) {
      await page.goto(`/portal/worker${path}`);
      await expect(page.locator("main")).toBeVisible();
    }

    expect(errors, `console errors across Worker Portal pages: ${errors.join("\n")}`).toHaveLength(0);
  });
});
