import { test as base, expect } from "@playwright/test";

/**
 * RequireAuth.tsx gatea todo el frontend detrás de una pantalla de mock
 * login (ver src/lib/mock-auth.ts, introducido en 333b8cf) que exige
 * sessionStorage["dreistaff_mock_auth"] === "true" antes de siquiera
 * llamar a GET /auth/me. Un browser context de Playwright arranca
 * siempre limpio, así que sin esto todo test caía en /login y nunca
 * llegaba al dashboard real (ver el trace.zip / error-context.md que
 * lo confirmó -- cero requests a la API).
 *
 * addInitScript corre en CADA documento nuevo de este context, antes
 * de que se ejecute el JS de la app -- exactamente lo que hace falta
 * para que RequireAuth vea sessionStorage ya seteado en la primera
 * carga. No usa storageState porque Playwright (confirmado en 1.61.1)
 * solo persiste cookies + localStorage en ese mecanismo, nunca
 * sessionStorage.
 *
 * Esta clave debe seguir coincidiendo con STORAGE_KEY en
 * src/lib/mock-auth.ts. No afecta el switching de persona (x-dev-user
 * vía page.route en cada spec) -- son dos mecanismos independientes.
 */
const MOCK_AUTH_STORAGE_KEY = "dreistaff_mock_auth";

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript((key) => {
      window.sessionStorage.setItem(key, "true");
    }, MOCK_AUTH_STORAGE_KEY);
    await use(context);
  },
});

export { expect };
