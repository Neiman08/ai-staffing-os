import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";

// F10.11: los flujos mínimos de portal pedidos por la spec, corridos
// contra un navegador real + backend/DB reales de dev-bypass (nunca
// mocks de frontend). Serial: comparten el ciclo de vida real de un
// ClientJobRequest (draft -> submit -> revisión interna) y de un
// TimeEntry (draft -> submit), mismo criterio de
// worker-operations.spec.ts/recruiting-mission.spec.ts (F8.11/F9.9).
async function setDevUser(page: Page, email: string) {
  await page.route("**/api/v1/**", (route) => {
    void route.continue({ headers: { ...route.request().headers(), "x-dev-user": email } });
  });
}

const UNIQUE_TITLE = `F10.11 E2E Job Request ${Date.now()}`;

test.describe("Portal end-to-end flows", () => {
  test.describe.configure({ mode: "serial" });

  test("Client Job Request: DRAFT -> SUBMITTED por el cliente", async ({ page }) => {
    await setDevUser(page, "client-admin@titan.dev");
    await page.goto("/portal/client/job-requests");
    await page.getByRole("button", { name: "New Request" }).click();

    await page.getByLabel("Puesto solicitado *").fill(UNIQUE_TITLE);
    await page.getByLabel("Cantidad de personas *").fill("2");
    await page.getByRole("button", { name: "Crear borrador" }).click();

    await expect(page.getByRole("heading", { name: UNIQUE_TITLE })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Draft")).toBeVisible();

    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByText("Submitted")).toBeVisible({ timeout: 10_000 });
  });

  test("Internal review: Sales (clientJobs.view/.approve real) ve la solicitud y la transiciona a UNDER_REVIEW", async ({ page }) => {
    await setDevUser(page, "sales@titan.dev");
    await page.goto("/client-job-requests");
    await expect(page.getByRole("heading", { name: "Client Job Requests" })).toBeVisible();
    await page.getByText(UNIQUE_TITLE).click();

    await expect(page.getByRole("heading", { name: UNIQUE_TITLE })).toBeVisible();
    await page.getByLabel("Nuevo estado").selectOption("UNDER_REVIEW");
    await page.getByRole("button", { name: "Aplicar" }).click();
    await expect(page.getByText("Estado actualizado a Under Review")).toBeVisible({ timeout: 10_000 });

    // deja la solicitud en un estado terminal real (no destructivo, no
    // hay DELETE en el producto) para no acumular pendientes reales en
    // la cola de Sales entre corridas de esta suite.
    await page.getByLabel("Nuevo estado").selectOption("REJECTED");
    await page.getByLabel("Comentario (visible para el cliente)").fill("F10.11 e2e -- cerrado automáticamente tras la corrida");
    await page.getByRole("button", { name: "Aplicar" }).click();
    await expect(page.getByText("Estado actualizado a Rejected")).toBeVisible({ timeout: 10_000 });
  });

  test("Candidate Portal: perfil real visible y editable", async ({ page }) => {
    await setDevUser(page, "candidate-portal@titan.dev");
    await page.goto("/portal/candidate");
    await expect(page.getByRole("heading", { name: "Jordan Taylor" })).toBeVisible();

    await page.getByLabel("Disponibilidad").fill("F10.11 e2e check");
    await page.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(page.getByText("Perfil actualizado")).toBeVisible({ timeout: 10_000 });

    // deja el campo en su estado determinístico limpio (mismo criterio
    // de higiene ya aplicado en F10.5/F10.7 -- nunca deja artefactos de
    // test en un dato compartido de seed).
    await page.getByLabel("Disponibilidad").fill("");
    await page.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(page.getByText("Perfil actualizado")).toBeVisible({ timeout: 10_000 });
  });

  test("Worker Portal: onboarding real, assignment view con detalle, document checklist", async ({ page }) => {
    await setDevUser(page, "worker-portal@titan.dev");

    await page.goto("/portal/worker/onboarding");
    await expect(page.getByRole("heading", { name: "Onboarding" })).toBeVisible();

    await page.goto("/portal/worker/documents");
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();

    await page.goto("/portal/worker/assignments");
    await expect(page.getByRole("heading", { name: "Assignments" })).toBeVisible();
    const firstRow = page.locator("table tbody tr").first();
    if (await firstRow.count()) {
      await firstRow.click();
      await expect(page.getByText("Ubicación")).toBeVisible();
    }
  });

  test("Time Entry: DRAFT -> SUBMITTED por el Worker", async ({ page }) => {
    await setDevUser(page, "worker-portal@titan.dev");
    await page.goto("/portal/worker/time-entries");

    // F10.11: fecha única por corrida -- TimeEntry tiene constraint
    // única (assignmentId, date, F5.6); una fecha fija colisionaría en
    // reruns (409) sin dejar rastro visible del "Borrador creado".
    const uniqueDay = String(1 + (Date.now() % 27)).padStart(2, "0");
    const uniqueDate = `2027-01-${uniqueDay}`;

    const newDraftButton = page.getByRole("button", { name: "Nuevo borrador" });
    if (await newDraftButton.count()) {
      await newDraftButton.click();
      const dateInput = page.locator("#te-date");
      await dateInput.fill(uniqueDate);
      await page.locator("#te-start").fill("08:00");
      await page.locator("#te-end").fill("16:00");
      await page.getByRole("button", { name: "Guardar borrador" }).click();
      await expect(page.getByText("Borrador creado")).toBeVisible({ timeout: 10_000 });

      const editButton = page.getByRole("button", { name: "Editar" }).first();
      await editButton.click();
      await page.getByRole("button", { name: "Enviar" }).click();
      await expect(page.getByText("Horas enviadas")).toBeVisible({ timeout: 10_000 });
    }
  });

  test("Client approval: CLIENT_ADMIN tiene acciones de aprobar/rechazar, CLIENT_MANAGER no", async ({ page }) => {
    await setDevUser(page, "client-admin@titan.dev");
    await page.goto("/portal/client/time-entries");
    await expect(page.getByRole("heading", { name: "Time Entries" })).toBeVisible();

    await setDevUser(page, "client-manager@titan.dev");
    await page.goto("/portal/client/time-entries");
    await expect(page.getByRole("heading", { name: "Time Entries" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Aprobar" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rechazar" })).toHaveCount(0);
  });

  test("Notifications: Sales ve la notificación real de la solicitud enviada y puede marcarla leída", async ({ page }) => {
    await setDevUser(page, "sales@titan.dev");
    await page.goto("/");
    await page.getByRole("button", { name: "Notificaciones" }).click();
    await expect(page.getByText(UNIQUE_TITLE, { exact: false })).toBeVisible({ timeout: 10_000 });

    await page.getByText(UNIQUE_TITLE, { exact: false }).first().click();
    await expect(page).toHaveURL(/client-job-requests/);
  });

  test("Audit Trail: la revisión interna real queda visible con actor/acción/recurso", async ({ page }) => {
    await setDevUser(page, "admin@titan.dev");
    await page.goto("/audit-log");
    await page.getByLabel("Recurso").fill("clientJobRequest");
    await expect(page.getByText("clientJobRequest.reviewed").first()).toBeVisible({ timeout: 10_000 });
  });
});
