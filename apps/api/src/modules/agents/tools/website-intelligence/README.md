# website-intelligence/

F4.7 §1 — lee únicamente el sitio oficial de una `Company` (`Company.website`), nunca inventa nada, siempre guarda la URL exacta de origen. No es un proveedor pago: es HTTP + parseo de HTML propio, sin API key.

## Límites duros (no configurables por la IA)

- Profundidad máxima 2 (home → página enlazada desde la home).
- Máximo 6 páginas por Company.
- Timeout 10s por request, 1 reintento (solo en error 5xx).
- Máximo 2MB por página (se corta el stream, no se descarta la empresa).
- `robots.txt` siempre se respeta — si bloquea todo, `blockedByRobots: true` y no se visita nada.
- 1 request concurrente por dominio, 500ms mínimo entre requests al mismo dominio (rate limiter en memoria del proceso).
- User-Agent identificable (`AIStaffingOS-WebsiteIntelligence/1.0`), con contacto real opcional vía `WEBSITE_INTELLIGENCE_CONTACT_EMAIL` — nunca se hardcodea una marca todavía no decidida.

## Qué extrae

- Emails públicos (`mailto:` primero, texto plano como respaldo) — nunca se desofusca un email en JS/imagen.
- Teléfonos (formato NANP, texto plano).
- Presencia de formulario de contacto (nunca se interactúa con él).
- Presencia de página de careers/jobs.
- Tarjetas de persona (nombre + cargo + email) — solo cuando los tres están literalmente en el mismo bloque chico de HTML alrededor de un `mailto:` real. Sin ese anclaje, nunca se arma una tarjeta (evita asociar un nombre con un cargo/email que no le corresponde).

## Consumido por

`apps/api/src/modules/agents/tools/email-providers/website-public-email.ts` — envuelve `runWebsiteIntelligence` con el mismo contrato `EmailProviderSearchResult` que usan los proveedores pagos, prioridad #1 (gratis, ya verificado por venir del sitio de la propia empresa).
