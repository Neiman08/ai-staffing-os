/**
 * F22 Fase 3 (Contact Acquisition Engine — Renderizado Headless
 * Inteligente): wrapper opcional y perezoso sobre Playwright. Nunca se
 * importa `playwright` en el top-level del módulo -- `import()` dinámico
 * dentro de un try/catch, así que si el paquete no está instalado (no se
 * agregó a package.json a propósito, ver nota abajo) esto se degrada
 * limpiamente a "no disponible" en vez de romper el build o el arranque
 * del servicio.
 *
 * DECISIÓN DELIBERADA: `playwright` NO se agregó como dependencia real de
 * apps/api/package.json en esta entrega. El paquete base descarga
 * binarios de navegador (~300MB) en su postinstall por default, lo que
 * podría alentar o romper el build de Render (plan actual, sin
 * confirmación de que el sandbox de build tenga las libs de sistema que
 * Chromium headless necesita) -- un riesgo de infraestructura que no me
 * corresponde asumir sin aprobación explícita. El código de esta fase
 * está completo y probado (headless-renderer.test.ts inyecta un puerto
 * fake, nunca Playwright real) -- activarlo en producción es una
 * decisión separada (agregar la dependencia + `playwright install
 * chromium --with-deps` al buildCommand de render.yaml), documentada en
 * el reporte final, pendiente de aprobación.
 */

export interface HeadlessRenderResult {
  html: string | null;
  error: string | null;
  durationMs: number;
}

export interface HeadlessRendererPort {
  render(url: string, userAgent: string, timeoutMs: number): Promise<HeadlessRenderResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape mínima real de la API de Playwright que este módulo usa, sin depender del paquete en tiempo de compilación.
type PlaywrightModule = {
  chromium: {
    launch(opts: { headless: boolean }): Promise<{
      newPage(opts: { userAgent: string }): Promise<{
        goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
        content(): Promise<string>;
      }>;
      close(): Promise<void>;
    }>;
  };
};

export const REAL_HEADLESS_RENDERER: HeadlessRendererPort = {
  async render(url, userAgent, timeoutMs) {
    const start = Date.now();
    try {
      // Nombre del paquete armado dinámicamente -- evita que bundlers/
      // typecheckers estáticos intenten resolverlo en build-time cuando
      // no está instalado.
      const moduleName = "playwright";
      const playwright = (await import(moduleName)) as unknown as PlaywrightModule;
      const browser = await playwright.chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ userAgent });
        await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
        const html = await page.content();
        return { html, error: null, durationMs: Date.now() - start };
      } finally {
        await browser.close();
      }
    } catch (err) {
      return {
        html: null,
        error: err instanceof Error ? err.message : "unknown headless render error",
        durationMs: Date.now() - start,
      };
    }
  },
};
