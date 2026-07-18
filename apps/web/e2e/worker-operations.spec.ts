import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";

// F9.9: Worker Operations UI -- Onboarding/Checklist embebidos en el
// mismo drawer de F8.11 (mismo par candidateId/jobOrderId que Placement
// Readiness), y Shifts/Timesheets/Readiness embebidos en las páginas
// reales de Payroll/Invoices. Corre contra dev-bypass real (x-dev-user)
// y datos reales del seed de tenant-titan.
const REAL_JOB_ORDER_ID = "joborder-01";

async function setDevUser(page: Page, role: string) {
  await page.route("**/api/v1/**", (route) => {
    void route.continue({ headers: { ...route.request().headers(), "x-dev-user": `${role}@titan.dev` } });
  });
}

test.describe("Worker Operations UI", () => {
  // Serial: el flujo de onboarding/checklist es idempotente pero
  // depende de un matching/shortlist ya calculado en el mismo Job
  // Order -- mismo criterio que recruiting-mission.spec.ts (F8.11).
  test.describe.configure({ mode: "serial" });

  test("Recruiter puede iniciar onboarding y generar el checklist real de un candidato, sin errores de consola", async ({ page }) => {
    await setDevUser(page, "recruiter");
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);
    await page.getByRole("button", { name: /Calcular Matching|Volver a calcular/ }).click();
    await expect(page.getByText(/Matching calculado/)).toBeVisible({ timeout: 15_000 });

    const firstCandidateButton = page.locator("button", { hasText: /^#1/ }).first();
    // La sección de Onboarding hace su GET inicial apenas se abre el
    // drawer -- se espera esa respuesta ANTES de leer el texto del botón
    // (que depende de si ya existe un registro previo en la misma base
    // de dev, reusada entre corridas de esta suite) para evitar la
    // condición de carrera clásica de Playwright: el texto del botón
    // cambia de "Iniciar onboarding" a "Onboarding ya iniciado" en
    // cuanto la query resuelve, y un locator por texto exacto pierde el
    // elemento a mitad de un click() si no se espera antes.
    const onboardingGetPromise = page.waitForResponse(
      (resp) => resp.url().includes("/onboarding/") && !resp.url().includes("checklist") && resp.request().method() === "GET",
      { timeout: 15_000 },
    );
    await firstCandidateButton.click();
    await expect(page.getByRole("heading", { name: "Pipeline del candidato" })).toBeVisible();

    // Placement readiness es prerequisito real de Onboarding (F9.1
    // consume su readinessStatus, nunca lo recalcula) -- evaluarlo es
    // idempotente (F8.10), así que se dispara siempre con el mismo
    // botón sin importar si dice "Evaluar" o "Re-evaluar".
    const readinessButton = page.getByRole("button", { name: /Evaluar placement readiness|Re-evaluar/ });
    await readinessButton.click();
    await expect(page.getByText(/Readiness:/)).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("heading", { name: "Onboarding" })).toBeVisible();
    await onboardingGetPromise.catch(() => {});
    const startButton = page.getByRole("button", { name: /Iniciar onboarding|Onboarding ya iniciado/ });
    await expect(startButton).toBeVisible();
    if (!(await startButton.isDisabled())) {
      await startButton.click();
      await expect(page.getByText(/Onboarding iniciado:/)).toBeVisible({ timeout: 10_000 });
    }
    await expect(page.getByText(/Progreso \d+%/)).toBeVisible();

    await expect(page.getByRole("heading", { name: "Document Checklist" })).toBeVisible();
    const generateChecklistButton = page.getByRole("button", { name: /Generar checklist|Refrescar checklist/ });
    await generateChecklistButton.click();
    await expect(page.getByText(/Checklist generado: \d+ documento\(s\)/)).toBeVisible({ timeout: 10_000 });

    const unexpectedErrors = errors.filter((e) => !e.includes("404") && !e.includes("400"));
    expect(unexpectedErrors, `console errors: ${unexpectedErrors.join("\n")}`).toHaveLength(0);
  });

  test("un item del checklist puede cambiar de estado vía el selector real", async ({ page }) => {
    await setDevUser(page, "recruiter");
    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);
    await page.getByRole("button", { name: /Calcular Matching|Volver a calcular/ }).click();
    await expect(page.getByText(/Matching calculado/)).toBeVisible({ timeout: 15_000 });

    const firstCandidateButton = page.locator("button", { hasText: /^#1/ }).first();
    await firstCandidateButton.click();
    await expect(page.getByRole("heading", { name: "Document Checklist" })).toBeVisible();

    const itemSelect = page.getByLabel(/Cambiar estado del documento/).first();
    if ((await itemSelect.count()) > 0) {
      await itemSelect.selectOption("SUBMITTED");
      await expect(page.getByText("Estado del documento actualizado")).toBeVisible({ timeout: 10_000 });
    }
  });

  test("Payroll no tiene acceso a onboarding (sin workers.update en el drawer)", async ({ page }) => {
    // Mismo criterio ya probado limpio por F8.11 para este Job Order --
    // Payroll no ve matching/shortlist en absoluto, así que el drawer
    // jamás se abre; esto solo confirma que la página sigue renderizando
    // sin el panel de reclutamiento (regresión general, no específica de F9.9).
    await setDevUser(page, "payroll");
    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);
    await expect(page.getByRole("heading", { name: "Detalles" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Onboarding" })).toHaveCount(0);
  });

  test("Operations puede programar un Shift real desde la pestaña Shifts de Payroll", async ({ page }) => {
    await setDevUser(page, "operations");
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/payroll");
    await page.getByRole("button", { name: "Shifts" }).click();
    await expect(page.getByText(/Turnos programados por Assignment/)).toBeVisible();

    const scheduleButton = page.getByRole("button", { name: "Programar Shift" }).first();
    await scheduleButton.click();
    await expect(page.getByRole("heading", { name: "Programar Shift" })).toBeVisible();

    const assignmentSelect = page.getByLabel("Assignment *");
    const optionCount = await assignmentSelect.locator("option").count();
    if (optionCount > 1) {
      await assignmentSelect.selectOption({ index: 1 });
      await page.getByLabel("Fecha *").fill("2033-06-01");
      await page.getByRole("button", { name: "Programar Shift", exact: true }).last().click();
      await expect(page.getByText("Shift programado")).toBeVisible({ timeout: 10_000 });
    }

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("Payroll puede consultar Payroll Readiness de un Worker real desde la pestaña Readiness", async ({ page }) => {
    await setDevUser(page, "payroll");
    await page.goto("/payroll");
    await page.getByRole("button", { name: "Readiness" }).click();
    await expect(page.getByText(/Evalúa si un Worker está listo/)).toBeVisible();

    await page.getByLabel("Worker ID").fill("worker-does-not-exist");
    await page.getByRole("button", { name: "Evaluar Readiness" }).click();
    // Worker inexistente -> 404 real del backend, mostrado como error legible.
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });
  });

  test("Accounting puede consultar Billing Readiness real desde Invoices, sin errores de consola", async ({ page }) => {
    await setDevUser(page, "accounting");
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/invoices");
    await expect(page.getByText("Billing Readiness")).toBeVisible();

    await page.getByLabel("Empresa").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Evaluar" }).click();
    await expect(page.getByText(/Ingreso estimado:/)).toBeVisible({ timeout: 10_000 });

    const unexpectedErrors = errors.filter((e) => !e.includes("404"));
    expect(unexpectedErrors, `console errors: ${unexpectedErrors.join("\n")}`).toHaveLength(0);
  });
});
