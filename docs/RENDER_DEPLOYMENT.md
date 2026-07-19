# Render Deployment — procedimiento paso a paso

F12.11 (actualizado en F14, 2026-07-19: se agregó `apps/marketing` como cuarto servicio). Procedimiento real para desplegar AI Staffing OS a Render. Este documento describe **cómo** desplegar — no ejecuta ningún deploy por sí mismo. Ningún paso de este runbook fue ejecutado contra Render real (ningún agente puede crear cuentas/recursos de terceros); el siguiente paso real es 100% manual, del lado del PO. Ver `docs/PRODUCTION_DEPLOYMENT.md` para la vista general (qué es cada servicio, por qué, costos) — este documento es la mecánica específica de Render.

**Nota de nombres (F14)**: este archivo se llamaba `PRODUCTION_DEPLOYMENT_RUNBOOK.md`; `docs/ENVIRONMENT_VARIABLES.md` ahora es `docs/RENDER_ENVIRONMENT_VARIABLES.md`; `docs/PRODUCTION_SMOKE_TEST_CHECKLIST.md` ahora es `docs/RENDER_SMOKE_TEST.md`; `docs/BACKUP_AND_RECOVERY_RUNBOOK.md` ahora es `docs/BACKUP_AND_RESTORE.md`. Contenido sin cambios salvo la cobertura nueva de `apps/marketing` y las referencias cruzadas.

**Nota de compatibilidad real (F14, 2 intentos de importación)**: el primer intento de importar `render.yaml` en Render falló con "static sites cannot have a region" (`ai-staffing-os-web`/`ai-staffing-os-marketing`) — corregido quitando `region` de ambos servicios estáticos (nunca es un campo válido ahí, un sitio estático se sirve desde la CDN global de Render). El segundo intento falló con "Legacy Postgres plans, including 'starter', are no longer supported for new databases" — corregido cambiando el plan de `ai-staffing-os-db` de `starter` (legacy) a `basic-256mb` (plan flexible vigente, mismo precio ~$7/mes, ver `render.com/docs/postgresql-refresh`). El plan `starter` de `ai-staffing-os-api` **no cambió** — la deprecación fue específica de Postgres, sigue siendo válido para Web Services.

## 1. Qué existe hoy

- `render.yaml` — blueprint de Render con **4 recursos reales**, ni uno más: `ai-staffing-os-db` (Postgres 16), `ai-staffing-os-api` (Node, Express), `ai-staffing-os-web` (sitio estático, dashboard/CRM), `ai-staffing-os-marketing` (sitio estático, landing pública). **No hay ningún worker** — los 3 schedulers en background (prospecting, compliance, billing) corren dentro del mismo proceso de `ai-staffing-os-api` (`apps/api/src/index.ts`), no existe un proceso/servicio separado para ellos en este repo.
- `.github/workflows/ci.yml` — pipeline de verificación (install, secret scan, prisma validate, migrate deploy sobre una base vacía, seed, typecheck, lint, build, suite completa de `apps/api`, e2e de Playwright). Corre en cada push/PR a `main`. **Nunca despliega** — es un gate de calidad, no un pipeline de CD.
- `docs/BACKUP_AND_RESTORE.md` — estrategia de backup/restore, con una prueba real ya ejecutada dos veces.
- `docs/RENDER_ENVIRONMENT_VARIABLES.md` — referencia completa de cada variable de entorno, backend y frontend.
- `docs/ROLLBACK.md` — procedimiento de rollback (código y datos), separado del backup/restore.

## 2. Los 4 servicios — configuración real

| | `ai-staffing-os-db` | `ai-staffing-os-api` | `ai-staffing-os-web` | `ai-staffing-os-marketing` |
|---|---|---|---|---|
| **Tipo Render** | PostgreSQL gestionado | Web Service (`runtime: node`) | Static Site (`runtime: static`) | Static Site (`runtime: static`) |
| **Root directory** | — | repo root (monorepo pnpm, ver abajo) | repo root | repo root |
| **Build command** | — | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @ai-staffing-os/db run generate && pnpm --filter @ai-staffing-os/db run migrate:deploy` | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @ai-staffing-os/web run build` | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @ai-staffing-os/marketing run build` |
| **Start command** | — | `pnpm --filter @ai-staffing-os/api run start:deploy` | — (sitio estático, sin proceso) | — (sitio estático, sin proceso) |
| **Publish directory** | — | — | `apps/web/dist` | `apps/marketing/dist` |
| **Health check** | gestionado por Render | `/api/v1/health/ready` | — (Render sirve estático, siempre "up" si el build pasó) | — (ídem) |
| **Node version** | — | `>=20` (de `engines` en `package.json` raíz; fijar `NODE_VERSION=20` explícito en el dashboard si Render no lo detecta automático) | `20` (solo para el build) | `20` (solo para el build) |
| **Auto Deploy** | N/A | on push a `main` (default de Blueprint) — desactivar desde el dashboard si se prefiere control manual | igual | igual |
| **Persistent Disk** | gestionado por Render (el volumen de Postgres) | **No aplica** — sin disco propio, ver nota abajo | No aplica (estático) | No aplica (estático) |
| **Internal URL** | conexión interna vía `fromDatabase` en `render.yaml` (nunca expuesta) | URL interna de Render entre servicios del mismo proyecto (opcional, no usada hoy — la comunicación web→api es siempre por la URL pública) | — | — |
| **External URL** | — (nunca pública) | `https://ai-staffing-os-api.onrender.com` (o dominio propio vía `API_ORIGIN`/`APP_DOMAIN`) | `https://ai-staffing-os-web.onrender.com` (o `app.dreistaff.com`) | `https://ai-staffing-os-marketing.onrender.com` (o `dreistaff.com`) |
| **Plan recomendado (agencia chica)** | `basic-256mb` (F14: reemplaza al plan legacy `starter`, ya no disponible para bases nuevas — mismo precio ~$7/mes, backups diarios incluidos, 7 días retención) | `starter` | Static — Render no cobra plan por sitios estáticos (banda ancha incluida en el free tier de Static Sites) | Static — ídem |

**Persistent Disk — por qué NO hace falta**: `apps/api` no escribe archivos al disco local en ningún punto del código (uploads de documentos usan `DocumentStorageAdapter`, ver `apps/api/src/modules/*/document-storage*` — abstracción ya lista para un adapter real de S3/GCS si algún día se necesita, hoy usa URLs, nunca bytes en disco). Un dyno de Render sin disco persistente puede reiniciarse/redistribuirse libremente sin pérdida de datos.

## 3. Orden exacto de creación

Render crea los 4 recursos del Blueprint en un solo paso ("New" → "Blueprint"), pero el orden real de **arranque/disponibilidad** importa para completar las variables cruzadas correctamente:

1. **`ai-staffing-os-db`** — se aprovisiona primero (Render lo hace automáticamente antes de los servicios que dependen de `fromDatabase`).
2. **`ai-staffing-os-api`** — depende de `DATABASE_URL` (ya resuelta automáticamente vía `fromDatabase` en `render.yaml`, no requiere acción manual). El build corre `migrate:deploy` — la base debe estar lista antes.
3. **`ai-staffing-os-web`** — puede construirse en paralelo al API (no depende de que el API esté "up" para el build, solo para funcionar en el navegador). Requiere `VITE_API_URL` apuntando a la URL real de `ai-staffing-os-api` — **solo se conoce después de que el paso 2 exista** (puede requerir un segundo deploy/redeploy de `web` tras completar la variable).
4. **`ai-staffing-os-marketing`** — mismo caso que `web`: requiere `VITE_API_URL` apuntando al API real, se puede construir en paralelo pero necesita esa variable completada (y redeploy) para funcionar correctamente en el navegador.

En la práctica: crear el Blueprint completo, esperar a que `ai-staffing-os-api` tenga una URL real asignada, completar `VITE_API_URL` en `web` y `marketing`, y **redeploy manual de esos dos** (Render no re-triggerea el build solo por cambiar una env var en un sitio estático — confirmar este comportamiento en el dashboard al momento real del deploy, puede variar).

## 4. Bloqueadores externos reales (no resolubles por este agente)

Documentados también en `docs/F12_PRODUCTION_READINESS_BASELINE.md` §14:

1. **Cuenta de Render real** — el blueprint (`render.yaml`) es preparación de código. Crear los recursos reales requiere que el PO conecte este repo desde su propia cuenta de Render (Render lee `render.yaml` automáticamente al crear un "Blueprint" desde el dashboard).
2. **Credenciales reales de Clerk** — diferido por decisión explícita del PO (2026-07-12, ver `docs/F4_9_PRODUCTION_AUTH_PLAN.md`). Mientras `AUTH_MODE=dev-bypass` siga activo, `NODE_ENV` en `render.yaml` debe quedar en `development` — `env.ts` se niega a arrancar si `NODE_ENV=production` y `AUTH_MODE=dev-bypass` (guardia intencional, no tocar sin decisión explícita del PO). Pasar a `AUTH_MODE=clerk` en producción requiere: una aplicación Clerk real creada, sus 3 keys (`CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`) cargadas en el dashboard de Render (nunca en este repo), y recién ahí `NODE_ENV=production` es seguro. Ver `docs/CLERK_PRODUCTION_READINESS.md`.
3. **Secrets de proveedores opcionales** (`OPENAI_API_KEY`, `GOOGLE_PLACES_API_KEY`, `PEOPLEDATALABS_API_KEY`, `HUNTER_API_KEY`) — el sistema funciona sin ellos (cada uno se degrada honestamente), pero el CEO Agent y el enriquecimiento de contactos no hacen nada útil sin `OPENAI_API_KEY` como mínimo.
4. **Secrets de CI real** (mismos 4 de arriba, como GitHub Secrets del repo) — sin ellos, ~15 pruebas de `apps/api` que ejercitan integraciones de IA reales fallan de forma honesta en cada corrida de `.github/workflows/ci.yml`. Configurarlos implica costo real recurrente en cada push/PR — decisión explícita del PO.

## 5. Checklist previo a cualquier deploy real (manual, humano)

1. `git status` limpio, working tree sin cambios sin commitear.
2. `pnpm run typecheck && pnpm run lint && pnpm run build` verde localmente (o CI verde en el último commit de `main`).
3. `pnpm --filter @ai-staffing-os/api run test` verde (con los 4 provider keys reales si se quiere cobertura completa; sin ellos, revisar que los fallos sean exactamente los esperados de proveedor ausente, no algo nuevo).
4. `pnpm --filter @ai-staffing-os/web run test:e2e` verde.
5. `./scripts/db-backup.sh` contra la base de producción real (si ya existe) **antes** de aplicar cualquier migración nueva — ver `docs/BACKUP_AND_RESTORE.md`.
6. Revisar el diff de `packages/db/prisma/migrations/` desde el último deploy: **toda migración debe ser aditiva** (nunca `DROP`/`TRUNCATE`/renombres destructivos/`DELETE` masivo — política explícita de este proyecto).
7. Revisar `docs/RENDER_ENVIRONMENT_VARIABLES.md` contra las env vars realmente configuradas en el dashboard de Render — ninguna variable obligatoria nueva sin su valor real cargado.

## 6. Primer deploy real (cuando el PO decida activarlo)

1. En el dashboard de Render: "New" → "Blueprint" → conectar este repositorio de GitHub → Render detecta `render.yaml` automáticamente y propone los **4 recursos** (ver §3 para el orden real de disponibilidad).
2. Antes de confirmar la creación, completar en el dashboard (nunca en `render.yaml`, todas están como `sync: false` a propósito):
   - `APP_ORIGIN`, `MARKETING_ORIGIN`, `API_ORIGIN` del servicio `ai-staffing-os-api` (URLs reales que Render asigna a `ai-staffing-os-web`/`ai-staffing-os-marketing` y a sí mismo — requiere un segundo paso una vez que esas URLs existen, ver §3).
   - `VITE_API_URL` de `ai-staffing-os-web` y de `ai-staffing-os-marketing` (URL real de `ai-staffing-os-api`, **sin** sufijo — cada app agrega su propio sufijo, `/api/v1` en `web` y `/api/v1/public` en `marketing`).
   - `BUSINESS_DOMAIN` de `ai-staffing-os-marketing` (usado en build-time por `generate-seo-files.mjs`) y `BUSINESS_DOMAIN`/`APP_DOMAIN` de `ai-staffing-os-api` si ya hay un dominio propio conectado.
   - Los provider keys opcionales que el PO decida activar (§4.3).
3. Confirmar creación. Render ejecuta `buildCommand` de cada servicio y luego `startCommand` (solo API) / sirve el `staticPublishPath` (web, marketing).
4. El primer build del API corre `prisma migrate deploy` como parte de `buildCommand` — aplica todo el historial de migraciones (35 al día de este documento) sobre la base nueva y vacía de `ai-staffing-os-db`. **No corre seed automáticamente** — si se quiere el tenant `titan` de referencia en producción, correr `pnpm --filter @ai-staffing-os/db run seed` manualmente una sola vez contra la `DATABASE_URL` real de producción (vía Render Shell o un job manual), evaluando primero si tiene sentido para el uso real de la agencia o si conviene crear el tenant real de la agencia a mano en su lugar.
5. Verificar `healthCheckPath: /api/v1/health/ready` en verde desde el dashboard de Render antes de considerar el API disponible.
6. Redeploy manual de `web`/`marketing` si `VITE_API_URL` se completó después del build inicial (ver §3).
7. Ejecutar `docs/RENDER_SMOKE_TEST.md` completo contra las URLs reales.

## 7. Deploys posteriores (flujo normal)

1. Merge a `main` → CI (`.github/workflows/ci.yml`) corre automáticamente. **Merge solo si CI está verde.**
2. Render está configurado para redeploy automático en push a `branch: main` (comportamiento default de un Blueprint de Render) — verificar que esto sea lo que el PO quiere; si se prefiere control manual, desactivar el auto-deploy desde el dashboard de cada servicio.
3. Si el commit incluye migraciones nuevas: `./scripts/db-backup.sh` contra producción **antes** del merge que dispara el deploy (paso manual, ver §5.5).
4. Tras el deploy: revisar logs del servicio en el dashboard de Render (`graceful_shutdown_started`/`graceful_shutdown_complete` en el deploy anterior confirman que el shutdown fue limpio, no un kill forzado — ver F12.7), y `docs/RENDER_SMOKE_TEST.md` (al menos la sección "smoke mínimo").

## 8. Rollback

Ver `docs/ROLLBACK.md` (procedimiento completo, código y datos).

## 9. Nunca hacer

- Nunca ejecutar `prisma migrate reset` contra la base de producción.
- Nunca cambiar `NODE_ENV=production` mientras `AUTH_MODE=dev-bypass` siga activo — `env.ts` ya lo impide al arrancar, no forzar ese guardia.
- Nunca commitear un secret real (Clerk, OpenAI, etc.) en `render.yaml` ni en ningún archivo del repo — siempre `sync: false` + valor cargado a mano en el dashboard.
- Nunca hacer push directo a `main` sin pasar por CI.
- Nunca desactivar el health check (`healthCheckPath`) para "forzar" que un deploy roto quede activo.
- Nunca inventar un servicio de "worker" en `render.yaml` — no existe ningún proceso separado que lo necesite hoy (ver §1).
