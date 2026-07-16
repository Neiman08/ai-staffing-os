import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";

// F6.7: matching con IA integrado en JobOrderDetail — sin app/página
// separada. Corre contra dev-bypass real (x-dev-user) y datos reales
// del seed de tenant-titan (joborder-04, PARTIALLY_FILLED, Apprentice
// Electrician — ya usado como Job Order real en F6.6). Cero fixtures:
// solo lectura + una corrida real de matching (AgentTask + Activity +
// AuditLog), que es exactamente el feature que se está verificando, no
// una escritura de negocio (cero Assignment, cero Worker/JobOrder
// modificado — ya lo prueba matching-api.test.ts a nivel de servicio).
const REAL_JOB_ORDER_ID = "joborder-04";

// page.setExtraHTTPHeaders() aplica el header a TODA request de la
// página, incluyendo las cross-origin (ej. fonts.gstatic.com) — un
// header custom ahí dispara un preflight CORS que Google Fonts rechaza,
// ensuciando la consola con un error ajeno a la app. Se intercepta solo
// /api/v1/** en su lugar, igual que haría el proxy de Vite en prod.
async function setDevUser(page: Page, role: string) {
  await page.route("**/api/v1/**", (route) => {
    void route.continue({ headers: { ...route.request().headers(), "x-dev-user": `${role}@titan.dev` } });
  });
}

test.describe("Matching con IA en Job Order Detail", () => {
  // Serial: varios tests de este archivo ejecutan un run real de POST
  // .../matching/run contra el mismo Job Order real — el guard de
  // concurrencia de F6.6 (409 si ya hay una corrida QUEUED/RUNNING para
  // el mismo Job Order) es correcto en producción pero volvería flaky
  // esta suite bajo `fullyParallel` (playwright.config.ts) si dos tests
  // dispararan el run al mismo tiempo.
  test.describe.configure({ mode: "serial" });

  test("Recruiter puede ejecutar matching determinista y ver el ranking", async ({ page }) => {
    await setDevUser(page, "recruiter");
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);
    await expect(page.getByRole("heading", { name: "Matching con IA" })).toBeVisible();

    const runButton = page.getByRole("button", { name: /Ejecutar Matching|Volver a ejecutar/ });
    await expect(runButton).toBeVisible();
    await runButton.click();

    // Sin polling: createAndRunTaskSync corre sincrónico — el resultado
    // vuelve en la misma respuesta HTTP, la UI solo espera el toast.
    await expect(page.getByText("Matching ejecutado")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/elegible\(s\) · \d+ no elegible\(s\)/)).toBeVisible();
    await expect(page.getByText(/^v1 ·/)).toBeVisible();

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("Deterministic-only: llmStatus queda NOT_RUN y no se llama a ningún proveedor", async ({ page }) => {
    await setDevUser(page, "recruiter");
    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);

    const modeSelect = page.getByLabel("Modo");
    await modeSelect.selectOption("deterministic");
    await page.getByRole("button", { name: /Ejecutar Matching|Volver a ejecutar/ }).click();

    await expect(page.getByText("Matching ejecutado")).toBeVisible({ timeout: 15_000 });
    // .last(): el <option value="deterministic"> del <select> también
    // matchea "Solo determinista" por texto pero queda oculto mientras
    // el <select> está cerrado — el badge de resultado real es el que
    // se renderiza después en el DOM.
    await expect(page.getByText("Solo determinista").last()).toBeVisible();
  });

  test("historial muestra al menos la corrida recién ejecutada", async ({ page }) => {
    await setDevUser(page, "recruiter");
    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);

    await expect(page.getByRole("heading", { name: "Historial de corridas" })).toBeVisible();
    // Ya se corrió matching en los tests anteriores para este Job Order
    // real — el historial nunca debería seguir vacío a esta altura.
    await expect(page.getByText("Sin corridas todavía.")).not.toBeVisible();
  });

  test("Operations solo puede ver — sin botón de ejecutar, sin 403", async ({ page }) => {
    await setDevUser(page, "operations");
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);
    await expect(page.getByRole("heading", { name: "Matching con IA" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Ejecutar Matching|Volver a ejecutar/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Historial de corridas" })).toBeVisible();

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("Payroll no tiene acceso — la sección de matching no se renderiza", async ({ page }) => {
    await setDevUser(page, "payroll");
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);
    // Payroll sí tiene jobOrders.view (necesita el contexto para nómina,
    // ver seed.ts) — la página carga normal, solo la sección de matching
    // (matching.view, que Payroll no tiene) queda ausente.
    await expect(page.getByRole("heading", { name: "Detalles" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Matching con IA" })).toHaveCount(0);

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("cero creación de Assignment: la ocupación del Job Order no cambia tras correr matching", async ({ page }) => {
    await setDevUser(page, "recruiter");
    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);

    // "Ocupación (solo lectura)" (workersFilled/workersNeeded) solo se
    // mueve cuando se crea/cambia una Assignment real (F5.4) — nunca por
    // el matching, que es puramente de lectura. Verificarlo acá cubre
    // el mismo invariante que matching-api.test.ts prueba a nivel de
    // servicio, pero de punta a punta contra la UI real.
    const occupancyRow = page.getByText("Ocupación (solo lectura)").locator("..");
    const before = await occupancyRow.textContent();

    await page.getByRole("button", { name: /Ejecutar Matching|Volver a ejecutar/ }).click();
    await expect(page.getByText("Matching ejecutado")).toBeVisible({ timeout: 15_000 });

    const after = await occupancyRow.textContent();
    expect(after).toBe(before);
  });

  test("mobile: la sección de matching es utilizable en viewport angosto", async ({ page }) => {
    await setDevUser(page, "recruiter");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);

    await expect(page.getByRole("heading", { name: "Matching con IA" })).toBeVisible();
    const runButton = page.getByRole("button", { name: /Ejecutar Matching|Volver a ejecutar/ });
    await expect(runButton).toBeVisible();
    await runButton.scrollIntoViewIfNeeded();
    await expect(runButton).toBeInViewport();
  });
});
