# website-intelligence/

F4.7 §1 — lee únicamente el sitio oficial de una `Company` (`Company.website`), nunca inventa nada, siempre guarda la URL exacta de origen. No es un proveedor pago: es HTTP + parseo de HTML propio, sin API key.

## Límites duros (no configurables por la IA)

- Profundidad máxima 2 (home → página objetivo).
- Máximo 6 páginas **exitosas** por Company; máximo 10 intentos totales de páginas candidatas (éxito o no), para acotar el peor caso cuando se prueban rutas comunes que no existen.
- Timeout 10s por request (15s para renderizado headless), 1 reintento (solo en error 5xx).
- Máximo 2MB por página (se corta el stream, no se descarta la empresa).
- `robots.txt` siempre se respeta (también para `/sitemap.xml`) — si bloquea todo, `blockedByRobots: true` y no se visita nada.
- 1 request concurrente por dominio, 500ms mínimo entre requests al mismo dominio (rate limiter en memoria del proceso).
- Máximo 2 páginas por Company con renderizado headless (F22 Fase 3).
- Sitemap: máximo 500 `<loc>` crudas leídas antes de filtrar a páginas relevantes — nunca se procesa un sitemap gigante completo. Sitemap-index: solo el primer sub-sitemap listado.
- User-Agent identificable (`AIStaffingOS-WebsiteIntelligence/1.0`), con contacto real opcional vía `WEBSITE_INTELLIGENCE_CONTACT_EMAIL` — nunca se hardcodea una marca todavía no decidida.

## Descubrimiento de páginas (F22 — Contact Acquisition Engine)

1. **Si `/sitemap.xml` existe** y aporta URLs relevantes (path matchea `contact/about/team/leadership/careers/jobs/staff/people/company/location`) → se usan esas + los links reales de la home.
2. **Si no hay sitemap útil** → respaldo de rutas comunes conocidas: `/contact`, `/contact-us`, `/contacto`, `/about`, `/about-us`, `/team`, `/staff`, `/careers`, `/jobs`, `/employment`, `/company`, `/locations` — se prueban, nunca se asume que existen (un 404 en una ruta adivinada es información honesta, no un error).

`pageDiscoveryMethod` en el resultado registra, por cada página visitada, si vino de `"home"`, `"sitemap"`, `"home_link"` o `"common_path_guess"` — observabilidad real de qué estrategia aporta.

## Renderizado headless inteligente (F22 Fase 3)

Nunca se lanza un navegador "por si acaso". `assessHeadlessRenderNeed` (extract.ts) evalúa el HTML plano ya descargado y solo dispara headless cuando: el HTML está vacío, el texto visible real es menor a 200 caracteres, hay un root de SPA conocido (`#root`/`#app`/`#__next`/`#___gatsby`/`[data-reactroot]`) con casi nada de contenido, o el sitio declara explícitamente en `<noscript>` que depende de JavaScript.

**Playwright NO está agregado como dependencia real** de `apps/api/package.json` a propósito — el paquete base descarga binarios de navegador (~300MB) en su postinstall, un riesgo de build/deploy en Render que no se asumió sin aprobación explícita. El código (`headless-renderer.ts`) usa `import()` dinámico dentro de un try/catch: si el paquete no está instalado, se degrada limpiamente a "no disponible" (nunca rompe el crawl). Activarlo en producción es una decisión separada, documentada, pendiente de aprobación (agregar la dependencia + `playwright install chromium --with-deps` al build de Render).

## Qué extrae

- Emails públicos: `mailto:` (fuente más confiable) + texto plano (cubre header/footer, texto completo del body) + **JSON-LD/schema.org** (`Organization`/`ContactPoint`/`@graph`, F22) — nunca se desofusca un email en JS/imagen.
- Teléfonos (formato NANP, texto plano + JSON-LD `telephone`).
- **Todos** los formularios de contacto reales (F22): URL, método, `action` resuelto absoluto — se registran aunque la página no traiga ningún email, nunca solo un booleano.
- Página de careers/jobs: por path (`isCareersPath`) **y** por evidencia de contenido real ("we are hiring", "open positions"...) — ambas fuentes registradas con su URL y evidencia (F22).
- **LinkedIn corporativo** (F22): link real `linkedin.com/company/...` en el sitio, o `sameAs` de JSON-LD — nunca una búsqueda externa (Google), siempre el propio dominio de la Company.
- Tarjetas de persona (nombre + cargo + email) — solo cuando los tres están literalmente en el mismo bloque chico de HTML alrededor de un `mailto:` real. Sin ese anclaje, nunca se arma una tarjeta (evita asociar un nombre con un cargo/email que no le corresponde).

Ningún canal inferior se descarta cuando se encuentra uno mejor (F22 Fase 4) — `contactForms`/`careersEvidence` acumulan TODO lo encontrado, no solo el primero.

## Scoring y observabilidad (F22 Fases 4/5)

`resolveBestContactChannel` (`apps/api/src/modules/ceo-intelligence/contact-channel.ts`) resuelve el mejor canal real disponible, en este orden: contacto personal con email verificado → email organizacional verificado → email organizacional sin verificar → formulario de contacto → careers page → LinkedIn (de un Contact o corporativo del sitio) → teléfono principal → ninguno.

`mission-executor.ts` persiste, por Company, un objeto `contactAcquisition` en `discoveryMetadata` con exactamente: `websiteFound`, `sitemapFound`, `pagesVisited`, `emailsFound`, `emailsValid`, `contactFormsFound`, `careersPageFound`, `linkedinFound`, `phoneFound`, `finalChannel`, `reasonWhenPhoneOnly`, `headlessPagesRendered`, `headlessRenderDurationMs`.

## Consumido por

`apps/api/src/modules/agents/tools/email-providers/website-public-email.ts` — envuelve `runWebsiteIntelligence` con el mismo contrato `EmailProviderSearchResult` que usan los proveedores pagos, prioridad #1 (gratis, ya verificado por venir del sitio de la propia empresa).
