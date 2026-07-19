# Variables de entorno — referencia completa

F12.2. Fuente de verdad única para qué variable existe, quién la valida, y qué vale en cada entorno. La validación real vive en `apps/api/src/core/env.ts` (Zod, `envSchema`) — este documento es la explicación legible para humanos de esa misma fuente, nunca una segunda definición que pueda desincronizarse (cualquier variable nueva debe agregarse primero en `env.ts`, después acá).

## Cómo funciona la validación

`core/env.ts` parsea `process.env` completo contra un `z.object` al arrancar el proceso. Si falta una variable **requerida** (hoy, la única sin default ni `.optional()`: `DATABASE_URL`), el proceso hace `console.error` + `process.exit(1)` de inmediato — nunca arranca en un estado parcialmente inválido. Dos guardas adicionales, también fatales al arrancar:

1. `NODE_ENV=production` + `AUTH_MODE=dev-bypass` → el proceso se niega a arrancar. Esta es la protección real contra "production con auth falsa" — no depende de que nadie recuerde configurar Render correctamente.
2. `AUTH_MODE=clerk` sin `CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY` → el proceso se niega a arrancar, en vez de fallar de forma impredecible en el primer request real.

Ninguna variable se imprime nunca por consola (ni siquiera en el error de arranque, que solo lista **nombres** de campos inválidos vía `flatten().fieldErrors`, nunca valores).

## Los 4 entornos

| Entorno | `NODE_ENV` | `AUTH_MODE` | Base de datos | Notas |
|---|---|---|---|---|
| **development** | `development` | `dev-bypass` | Postgres local (Docker, `docker-compose.yml`, puerto 5433) | El entorno de todo este proyecto hasta ahora. `x-dev-user` resuelve la identidad, sin verificación criptográfica. |
| **test** | `development` (default; ningún script de test fija `NODE_ENV=test` hoy — ver nota) | `dev-bypass` | Misma Postgres local que development (`DATABASE_URL` compartida vía `.env`) | La suite (`npm test`) usa dev-bypass real contra datos reales sembrados — nunca mocks del motor de auth. `RUN_REAL_PROVIDER_TESTS` (ver `apps/api/src/modules/prospecting`) gatea aparte las pruebas que llaman a un proveedor externo real. |
| **staging** | `production` | `clerk` | Postgres gestionada separada (Render, plan/región a elección) | Mismo blueprint de `render.yaml` que producción, apuntando a una base y un dominio distintos — nunca comparte `DATABASE_URL` con producción. Sirve para probar el flujo real de Clerk/CORS/Render antes de tocar datos reales de la agencia. |
| **production** | `production` | `clerk` | Postgres gestionada de Render (blueprint `ai-staffing-os-db`) | `AUTH_MODE=dev-bypass` es físicamente imposible acá (guard de arranque). Requiere las 3 claves de Clerk reales. |

**Nota sobre `NODE_ENV` en test**: hoy `apps/api/package.json`'s `test` script no fija `NODE_ENV=test` explícitamente — corre con el default (`development`). Esto es seguro (dev-bypass funciona igual en ambos), pero es una mejora de claridad pendiente y de bajo riesgo: fijar `NODE_ENV=test` en el script de test haría explícito el entorno sin cambiar ningún comportamiento (`env.ts` no distingue `development` de `test` en ningún guard hoy). Documentado acá como deuda menor, no bloqueante.

## Todas las variables

### Núcleo / base de datos

| Variable | Requerida | Default | Dónde se usa | Notas |
|---|---|---|---|---|
| `DATABASE_URL` | **Sí, siempre** | — | Prisma (todo el ORM) | Única variable sin default — su ausencia es el único caso que hace fallar el parseo de Zod directamente. |
| `PORT` | No | `4000` | `index.ts` (`app.listen`) | Render la inyecta automáticamente en producción; no hace falta fijarla ahí. |
| `NODE_ENV` | No | `development` | Guard de arranque (dev-bypass), nivel de detalle de errores | `development \| test \| production` — enum estricto, cualquier otro valor falla el parseo. |

### Autenticación

| Variable | Requerida | Default | Dónde se usa | Notas |
|---|---|---|---|---|
| `AUTH_MODE` | No | `dev-bypass` | `app.ts` (monta o no `clerkMiddleware()`), `auth-provider.ts` | `dev-bypass \| clerk`. Fatal en producción si es `dev-bypass` (ver guard #1 arriba). |
| `DEV_DEFAULT_USER_EMAIL` | No | `admin@titan.dev` | `dev-bypass.provider.ts` | Solo relevante si `AUTH_MODE=dev-bypass`. Nunca se usa en producción real (el modo entero está bloqueado ahí). |
| `CLERK_PUBLISHABLE_KEY` | Solo si `AUTH_MODE=clerk` | — | `clerk.provider.ts`, `app.ts` | Clave pública real de la aplicación Clerk — **bloqueada en este entorno de desarrollo, ver `docs/F12_PRODUCTION_READINESS_BASELINE.md` §3.5**. |
| `CLERK_SECRET_KEY` | Solo si `AUTH_MODE=clerk` | — | `clerk.provider.ts` | Clave secreta real — nunca debe llegar al frontend (ver sección "Frontend" abajo). |
| `CLERK_WEBHOOK_SECRET` | Solo si se reciben webhooks de Clerk | — | `webhook.router.ts` (`verifyWebhook`) | Sin esto, el webhook de sync de usuarios/organizaciones rechaza todo con 400 (firma svix nunca verifica). |
| `CLERK_SIGN_IN_URL` | No | `/sign-in` | Redirects de Clerk | |
| `CLERK_SIGN_UP_URL` | No | `/sign-up` | Redirects de Clerk | |
| `CLERK_AFTER_SIGN_IN_URL` | No | `/` | Redirects de Clerk | |
| `CLERK_AFTER_SIGN_UP_URL` | No | `/` | Redirects de Clerk | |

### Orígenes / CORS

| Variable | Requerida | Default | Dónde se usa | Notas |
|---|---|---|---|---|
| `APP_ORIGIN` | No (pero **debe** configurarse en staging/producción) | `http://localhost:5173` | `app.ts` (allowlist de CORS) | En Render: la URL real del servicio `apps/web`. |
| `MARKETING_ORIGIN` | No (ídem) | `http://localhost:5174` | `app.ts` (allowlist de CORS) | En Render: la URL real del servicio `apps/marketing`, si se despliega. |
| `API_ORIGIN` | No | `http://localhost:4000` | Referencias internas (ej. URLs absolutas en emails/webhooks) | |

### Proveedores de IA / datos externos (todos opcionales — cada uno se degrada honestamente sin inventar datos)

| Variable | Requerida | Dónde se usa | Comportamiento sin configurar |
|---|---|---|---|
| `OPENAI_API_KEY` | No | CEO/Sales/Campaign/Outreach/Conversation Agents | `MissingApiKeyProvider` — cualquier tool que lo necesite falla con `AI_NOT_CONFIGURED` (nunca inventa una respuesta). **Sí está configurada en este entorno de desarrollo** (usada en las 4 misiones reales validadas antes de F12). |
| `GOOGLE_PLACES_API_KEY` | No | Discovery Agent | Sin esto, `discoverCompaniesTool` usa solo Overpass (gratis, OpenStreetMap). |
| `PEOPLEDATALABS_API_KEY` | No | Contact Intelligence Agent | Sin esto, `findContactsTool` no encuentra nada — nunca inventa un contacto. |
| `HUNTER_API_KEY` | No | Email Intelligence Agent | Sin esto, `findEmailTool` solo usa Website Intelligence (scraping propio, gratis). |
| `WEBSITE_INTELLIGENCE_CONTACT_EMAIL` | No | User-Agent del scraper propio | Sin esto, el User-Agent se manda sin cláusula de contacto. |

### Branding / negocio (ya decididos — DreiStaff / Data More LLC)

| Variable | Requerida | Default | Notas |
|---|---|---|---|
| `BUSINESS_LEGAL_NAME` | No | `Data More LLC` | |
| `BUSINESS_BRAND_NAME` | No | `DreiStaff` | |
| `BUSINESS_DOMAIN` | No | `dreistaff.com` | |
| `APP_DOMAIN` | No | `app.dreistaff.com` | |
| `OUTREACH_FROM_NAME` | No | `DreiStaff` | |
| `OUTREACH_FROM_EMAIL` | No | — (sin default a propósito) | Sin configurar, ningún código de outreach puede enviar un email real. |
| `OUTREACH_REPLY_TO` | No | — | Ídem. |
| `BUSINESS_POSTAL_ADDRESS` | No | — | Ídem (requisito legal CAN-SPAM antes de enviar cualquier email real). |

### Modo de operación

| Variable | Requerida | Default | Notas |
|---|---|---|---|
| `PRODUCTION_MODE` | No | `false` | Ver `core/production-mode.ts`. `false` = permite datos demo/seed/regresión (estado de hoy). `true` = prohíbe crear datos demo, oculta datos demo sin excepción, bloquea `seed.ts`. **Decisión exclusiva del PO, para cuando la agencia empiece a operar con datos 100% reales** — no se activa en este commit. |
| `PUBLIC_TENANT_SLUG` | No | `titan` | Qué tenant sirve el sitio público (`dreistaff.com`). |

### Frontend (Vite — `apps/web`)

| Variable | Requerida | Dónde se usa | Notas |
|---|---|---|---|
| `VITE_API_URL` | No | `lib/api.ts`, `lib/download.ts` | Vacío = ruta relativa `/api/v1` (dev local vía proxy de Vite). En Render con servicios separados: URL absoluta del API. |
| `VITE_CLERK_PUBLISHABLE_KEY` | Solo si `AUTH_MODE=clerk` | `lib/auth-config.ts` | **Nunca la clave secreta** — Vite solo empaqueta variables con prefijo `VITE_` en el bundle del navegador; `CLERK_SECRET_KEY` (sin ese prefijo) nunca puede llegar al frontend por diseño de Vite, verificado: ningún archivo bajo `apps/web/src` referencia `CLERK_SECRET_KEY`. |

## Nunca hacer

- No imprimir ninguna de estas variables por `console.log`/`console.error` (verificado: cero ocurrencias en todo `apps/api/src`).
- No commitear `.env` real (ya en `.gitignore`, verificado en cada fase de este proyecto).
- No fijar un valor real de `CLERK_SECRET_KEY`/`OPENAI_API_KEY`/etc. en `render.yaml` — esas quedan `sync: false` (Render pide el valor real una sola vez desde su dashboard, nunca desde este repo).
