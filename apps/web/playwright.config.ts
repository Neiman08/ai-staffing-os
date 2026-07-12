import { defineConfig, devices } from "@playwright/test";

/**
 * F4.9-11: primera suite formal de Playwright del proyecto — hasta acá
 * la verificación de UI se hacía con scripts ad-hoc (ver historial de
 * F4.8/F4.9). Corre contra dev-bypass (AUTH_MODE=clerk real se
 * verifica manualmente en F4.9-12, no hay credenciales de Clerk en CI).
 * Requiere el API (puerto 4000) y este dev server ya corriendo, o los
 * levanta el propio webServer si no lo están.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    cwd: "../..",
    timeout: 60_000,
  },
});
