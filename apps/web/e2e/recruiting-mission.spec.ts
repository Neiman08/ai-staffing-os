import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";

// F8.11: Recruiting Mission UI integrado en JobOrderDetail (mismo
// patrón que job-order-matching.spec.ts, F6.7) -- corre contra
// dev-bypass real (x-dev-user) y datos reales del seed de
// tenant-titan. joborder-01 (Forklift Operators — Night Shift) ya
// tiene candidatos reales de esa categoría en el seed, así que
// matching/shortlist siempre producen al menos un resultado real, sin
// fixtures inventados.
const REAL_JOB_ORDER_ID = "joborder-01";

async function setDevUser(page: Page, role: string) {
  await page.route("**/api/v1/**", (route) => {
    void route.continue({ headers: { ...route.request().headers(), "x-dev-user": `${role}@titan.dev` } });
  });
}

test.describe("Recruiting Mission UI en Job Order Detail", () => {
  // Serial: varios tests corren un POST .../matching y .../shortlist
  // real contra el mismo Job Order -- idempotente por diseño (F8.6/
  // F8.7 hacen upsert), pero mantenerlos serial evita solapar corridas
  // bajo `fullyParallel` (mismo criterio que job-order-matching.spec.ts).
  test.describe.configure({ mode: "serial" });

  test("Recruiter puede calcular matching y ver el ranking real, sin errores de consola", async ({ page }) => {
    await setDevUser(page, "recruiter");
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);
    await expect(page.getByRole("heading", { name: "Candidate Matching & Ranking" })).toBeVisible();

    const runButton = page.getByRole("button", { name: /Calcular Matching|Volver a calcular/ });
    await expect(runButton).toBeVisible();
    await runButton.click();

    await expect(page.getByText(/Matching calculado: \d+ candidato\(s\) recomendado\(s\)/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/RECOMENDADOS \(\d+\)/i)).toBeVisible();

    // El primer 404 esperado de GET .../matching (antes de calcularlo la
    // primera vez) es un log de red de Chromium, no un error real de
    // JS/consola -- se filtra explícitamente, cualquier OTRO error sigue
    // fallando la prueba.
    const unexpectedErrors = errors.filter((e) => !e.includes("404"));
    expect(unexpectedErrors, `console errors: ${unexpectedErrors.join("\n")}`).toHaveLength(0);
  });

  test("un candidato NOT_QUALIFIED nunca aparece en la lista de recomendados", async ({ page }) => {
    await setDevUser(page, "recruiter");
    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);

    const excludedToggle = page.getByRole("button", { name: /Ver no recomendados/ });
    if (await excludedToggle.count() > 0) {
      await excludedToggle.click();
      await expect(page.getByText("Not Qualified").first()).toBeVisible();
    }
    // Independientemente de si hay excluidos, la sección de recomendados
    // nunca debe mostrar el badge "Not Qualified".
    const recommendedSection = page.locator("li", { hasText: /^#\d/ }).first().locator("..");
    await expect(recommendedSection.getByText("Not Qualified")).toHaveCount(0);
  });

  test("Recruiter puede generar la shortlist desde el ranking real", async ({ page }) => {
    await setDevUser(page, "recruiter");
    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);

    await expect(page.getByRole("heading", { name: "Shortlist" })).toBeVisible();
    const generateButton = page.getByRole("button", { name: /Generar Shortlist|Refrescar shortlist/ });
    await generateButton.click();

    await expect(page.getByText(/Shortlist generada: \d+ candidato\(s\)/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Draft").first()).toBeVisible();
  });

  test("abrir el drawer de un candidato y generar screening + interview preview + placement readiness reales", async ({ page }) => {
    await setDevUser(page, "recruiter");
    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);

    await page.getByText("Candidate Matching & Ranking", { exact: false }).scrollIntoViewIfNeeded();
    const firstCandidateButton = page.locator("button", { hasText: /^#1/ }).first();
    await firstCandidateButton.click();

    await expect(page.getByRole("heading", { name: "Pipeline del candidato" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Calificación" })).toBeVisible();

    // Screening -- PREVIEW, nunca una entrevista real.
    const screeningButton = page.getByRole("button", { name: /Generar plan de screening/ });
    if (await screeningButton.count() > 0) {
      await screeningButton.click();
      await expect(page.getByText("Plan de screening generado")).toBeVisible({ timeout: 10_000 });
    }

    // Interview preview -- debe mostrar el aviso explícito de PREVIEW.
    await expect(page.getByText(/Solo PREVIEW/)).toBeVisible();
    const interviewButton = page.getByRole("button", { name: /Generar preview de entrevista/ });
    if (await interviewButton.count() > 0) {
      await interviewButton.click();
      await expect(page.getByText(/Preview de entrevista generado/)).toBeVisible({ timeout: 10_000 });
    }

    // Placement readiness -- nunca debe insinuar una acción automática.
    await expect(page.getByText(/requiere aprobación humana explícita/i)).toBeVisible();
    const readinessButton = page.getByRole("button", { name: /Evaluar placement readiness/ });
    if (await readinessButton.count() > 0) {
      await readinessButton.click();
      await expect(page.getByText(/Readiness:/)).toBeVisible({ timeout: 10_000 });
    }
  });

  test("Payroll no tiene acceso -- ni matching ni shortlist se renderizan, sin errores de consola", async ({ page }) => {
    // Mismo rol que job-order-matching.spec.ts (F6.7) usa para el mismo
    // Job Order real -- ya probado limpio (jobOrders.view sí, matching.view
    // y candidates.view no), evita introducir un 403 no relacionado a
    // F8.11 desde otro panel de la página con un rol distinto.
    await setDevUser(page, "payroll");
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);
    await expect(page.getByRole("heading", { name: "Detalles" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Candidate Matching & Ranking" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Shortlist" })).toHaveCount(0);

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("cero creación de Assignment: la ocupación del Job Order no cambia tras usar el pipeline de reclutamiento", async ({ page }) => {
    await setDevUser(page, "recruiter");
    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);

    const occupancyRow = page.getByText("Ocupación (solo lectura)").locator("..");
    const before = await occupancyRow.textContent();

    await page.getByRole("button", { name: /Volver a calcular|Calcular Matching/ }).click();
    await expect(page.getByText(/Matching calculado/)).toBeVisible({ timeout: 15_000 });

    const after = await occupancyRow.textContent();
    expect(after).toBe(before);
  });

  test("mobile: el panel de Recruiting Mission es utilizable en viewport angosto", async ({ page }) => {
    await setDevUser(page, "recruiter");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/job-orders/${REAL_JOB_ORDER_ID}`);

    await page.getByText("Candidate Matching & Ranking", { exact: false }).scrollIntoViewIfNeeded();
    const runButton = page.getByRole("button", { name: /Calcular Matching|Volver a calcular/ });
    await expect(runButton).toBeVisible();
    await expect(runButton).toBeInViewport();
  });
});
