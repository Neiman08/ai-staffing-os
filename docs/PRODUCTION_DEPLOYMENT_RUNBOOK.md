# Production Deployment Runbook

F12.11. Procedimiento real para desplegar AI Staffing OS a Render, para uso operativo de la propia agencia y sus portales de cliente/candidato/trabajador. Este documento describe cómo desplegar — **no ejecuta ningún deploy por sí mismo**. Ningún paso de este runbook fue ejecutado contra Render real durante F12 (prohibido explícitamente por el alcance de esta fase).

## 1. Qué existe hoy

- `render.yaml` — blueprint de Render con 3 recursos: `ai-staffing-os-db` (Postgres 16, plan starter), `ai-staffing-os-api` (Node, plan starter) y `ai-staffing-os-web` (sitio estático, el build de Vite). `apps/marketing` no está en el blueprint todavía (mismo patrón que `ai-staffing-os-web`, agregar cuando el PO lo decida).
- `.github/workflows/ci.yml` — pipeline de verificación (install, prisma validate, migrate deploy sobre una base vacía, seed, typecheck, lint, build, suite completa de apps/api, e2e de Playwright). Corre en cada push/PR a `main`. **Nunca despliega** — es un gate de calidad, no un pipeline de CD.
- `docs/BACKUP_AND_RECOVERY_RUNBOOK.md` — estrategia de backup/restore, con una prueba real ya ejecutada.
- `docs/ENVIRONMENT_VARIABLES.md` — referencia completa de cada variable de entorno.

## 2. Bloqueadores externos reales (no resolubles por este agente)

Documentados también en `docs/F12_PRODUCTION_READINESS_BASELINE.md` §14:

1. **Cuenta de Render real** — el blueprint (`render.yaml`) es preparación de código. Crear los recursos reales requiere que el PO conecte este repo desde su propia cuenta de Render (Render lee `render.yaml` automáticamente al crear un "Blueprint" desde el dashboard).
2. **Credenciales reales de Clerk** — diferido por decisión explícita del PO (2026-07-12, ver `docs/F4_9_PRODUCTION_AUTH_PLAN.md`). Mientras `AUTH_MODE=dev-bypass` siga activo, `NODE_ENV` en `render.yaml` debe quedar en `development` — `env.ts` se niega a arrancar si `NODE_ENV=production` y `AUTH_MODE=dev-bypass` (guardia intencional, no tocar sin decisión explícita del PO). Pasar a `AUTH_MODE=clerk` en producción requiere: una aplicación Clerk real creada, sus 3 keys (`CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`) cargadas en el dashboard de Render (nunca en este repo), y recién ahí `NODE_ENV=production` es seguro.
3. **Secrets de proveedores opcionales** (`OPENAI_API_KEY`, `GOOGLE_PLACES_API_KEY`, `PEOPLEDATALABS_API_KEY`, `HUNTER_API_KEY`) — el sistema funciona sin ellos (cada uno se degrada honestamente), pero el CEO Agent y el enriquecimiento de contactos no hacen nada útil sin `OPENAI_API_KEY` como mínimo.
4. **Secrets de CI real** (mismos 4 de arriba, como GitHub Secrets del repo) — sin ellos, ~15 pruebas de `apps/api` que ejercitan integraciones de IA reales fallan de forma honesta en cada corrida de `.github/workflows/ci.yml` (ver el comentario de costo real al inicio de ese archivo). Configurarlos implica costo real recurrente en cada push/PR — decisión explícita del PO, no asumida automáticamente por este runbook.

## 3. Checklist previo a cualquier deploy real (manual, humano)

1. `git status` limpio, working tree sin cambios sin commitear.
2. `pnpm run typecheck && pnpm run lint && pnpm run build` verde localmente (o CI verde en el último commit de `main`).
3. `pnpm --filter @ai-staffing-os/api run test` verde (con los 4 provider keys reales si se quiere cobertura completa; sin ellos, revisar que los fallos sean exactamente los esperados de proveedor ausente, no algo nuevo).
4. `pnpm --filter @ai-staffing-os/web run test:e2e` verde.
5. `./scripts/db-backup.sh` contra la base de producción real (si ya existe) **antes** de aplicar cualquier migración nueva — ver `docs/BACKUP_AND_RECOVERY_RUNBOOK.md`.
6. Revisar el diff de `packages/db/prisma/migrations/` desde el último deploy: **toda migración debe ser aditiva** (nunca `DROP`/`TRUNCATE`/renombres destructivos/`DELETE` masivo — política explícita de este proyecto).
7. Revisar `docs/ENVIRONMENT_VARIABLES.md` contra las env vars realmente configuradas en el dashboard de Render — ninguna variable obligatoria nueva sin su valor real cargado.

## 4. Primer deploy real (cuando el PO decida activarlo)

1. En el dashboard de Render: "New" → "Blueprint" → conectar este repositorio de GitHub → Render detecta `render.yaml` automáticamente y propone los 3 recursos.
2. Antes de confirmar la creación, completar en el dashboard (nunca en `render.yaml`, todas están como `sync: false` a propósito):
   - `APP_ORIGIN`, `MARKETING_ORIGIN`, `API_ORIGIN` del servicio `ai-staffing-os-api` (URLs reales que Render asigna a `ai-staffing-os-web` y a sí mismo — puede requerir un segundo paso una vez que las URLs existen).
   - `VITE_API_URL` del servicio `ai-staffing-os-web` (URL real de `ai-staffing-os-api`, con sufijo `/api/v1`).
   - `BUSINESS_DOMAIN` / `APP_DOMAIN` si ya hay un dominio propio conectado.
   - Los provider keys opcionales que el PO decida activar (§2.3).
3. Confirmar creación. Render ejecuta `buildCommand` de cada servicio y luego `startCommand` (API) / sirve el `staticPublishPath` (web).
4. El primer build del API corre `prisma migrate deploy` como parte de `buildCommand` — aplica todo el historial de migraciones sobre la base nueva y vacía de `ai-staffing-os-db`. **No corre seed automáticamente** — si se quiere el tenant `titan` de referencia en producción, correr `pnpm --filter @ai-staffing-os/db run seed` manualmente una sola vez contra la `DATABASE_URL` real de producción (vía Render Shell o un job manual), evaluando primero si tiene sentido para el uso real de la agencia o si conviene crear el tenant real de la agencia a mano en su lugar.
5. Verificar `healthCheckPath: /api/v1/health/ready` en verde desde el dashboard de Render antes de considerar el servicio disponible.
6. Ejecutar `docs/PRODUCTION_SMOKE_TEST_CHECKLIST.md` completo contra las URLs reales.

## 5. Deploys posteriores (flujo normal)

1. Merge a `main` → CI (`.github/workflows/ci.yml`) corre automáticamente. **Merge solo si CI está verde.**
2. Render está configurado para redeploy automático en push a `branch: main` (comportamiento default de un Blueprint de Render) — verificar que esto sea lo que el PO quiere; si se prefiere control manual, desactivar el auto-deploy desde el dashboard de cada servicio.
3. Si el commit incluye migraciones nuevas: `./scripts/db-backup.sh` contra producción **antes** del merge que dispara el deploy (paso manual, ver §3.5).
4. Tras el deploy: revisar logs del servicio en el dashboard de Render (`graceful_shutdown_started`/`graceful_shutdown_complete` en el deploy anterior confirman que el shutdown fue limpio, no un kill forzado — ver F12.7), y `docs/PRODUCTION_SMOKE_TEST_CHECKLIST.md` (al menos la sección "smoke mínimo").

## 6. Rollback

Ver `docs/BACKUP_AND_RECOVERY_RUNBOOK.md` §10.5. Resumen: con la política de migraciones solo-aditivas de este proyecto, revertir el código desplegado (Render permite volver a un deploy anterior desde el dashboard) es normalmente seguro sin tocar el schema. Revertir datos reales requiere el procedimiento completo de restore documentado ahí.

## 7. Nunca hacer

- Nunca ejecutar `prisma migrate reset` contra la base de producción.
- Nunca cambiar `NODE_ENV=production` mientras `AUTH_MODE=dev-bypass` siga activo — `env.ts` ya lo impide al arrancar, no forzar ese guardia.
- Nunca commitear un secret real (Clerk, OpenAI, etc.) en `render.yaml` ni en ningún archivo del repo — siempre `sync: false` + valor cargado a mano en el dashboard.
- Nunca hacer push directo a `main` sin pasar por CI.
- Nunca desactivar el health check (`healthCheckPath`) para "forzar" que un deploy roto quede activo.
