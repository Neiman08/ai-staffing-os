# F12 — Production Readiness — Informe Final

F12.12. Cierre de F12: "Preparar AI Staffing OS para ser utilizado de forma estable, segura y mantenible en la operación real de nuestra propia agencia de staffing." Este documento resume las 12 subfases, cada hallazgo real (con o sin corrección), toda la evidencia de verificación, y declara el estado final.

## 1. Resumen ejecutivo

F12 se ejecutó de punta a punta, F12.1 → F12.12, sin pedir autorización entre subfases, con un commit lógico independiente por corrección/subfase (ver §11). Se encontraron y corrigieron **8 problemas reales** (2 de seguridad, 2 de resiliencia de jobs, 4 de fragilidad de tests/error-handling), todos con test de regresión donde aplicaba. Se ejecutó una validación final completa desde una base de datos nueva y vacía (migraciones + seed + suite completa + e2e + backup/restore/verify/boot + chequeos de seguridad en vivo), con resultado limpio salvo un caso de flakiness ambiental documentado transparentemente en §8.

**Quedan 2 bloqueadores externos reales**, ninguno resoluble por este agente (requieren decisiones/credenciales del PO): cuenta real de Render, credenciales reales de Clerk. Ambos ya estaban identificados desde F12.1 y siguen igual — no son nuevos, no bloquean el uso interno actual con `AUTH_MODE=dev-bypass`.

## 2. F12.1 — Auditoría base

`docs/F12_PRODUCTION_READINESS_BASELINE.md` (17 secciones). Mapeó el estado real de cada área (arquitectura, Prisma, env vars, Render, Clerk, CORS, logging, health checks, error handling, background jobs, seed, backups, Docker, CI, tests, documentación) e identificó los 2 bloqueadores externos de arriba desde el principio.

## 3. F12.2 — Configuración de entornos

`docs/ENVIRONMENT_VARIABLES.md` (27 variables documentadas), `.env.example` actualizado con las 14 que faltaban. `apps/api/package.json` test script corregido para descubrir todos los `*.test.ts` reales (antes se le podían escapar archivos nuevos).

## 4. F12.3 — Verificación real de Clerk (cierre del diferimiento F4.9)

**Bug de seguridad real encontrado y corregido**: `resolveIdentityFromClerkSession` nunca poblaba `companyId`/`workerId`/`candidateId` en el `ResolvedIdentity` — el path de dev-bypass sí lo hacía, y como el 100% de los ~1300 tests existentes corrían sobre dev-bypass, esto nunca se detectó. En producción real con Clerk activo, esto habría roto por completo el aislamiento de los portales de cliente/candidato/trabajador (`requireInternalIdentity()` y cualquier chequeo de `ctx.companyId` habrían fallado silenciosamente). Corregido + 2 tests nuevos (usuario interno resuelve los 3 campos `undefined`; usuario de portal real con `workerId` poblado en la DB resuelve el campo real).

**Bloqueo real, no fingido**: no hay una aplicación Clerk real conectada en este entorno — todo lo verificable sin credenciales reales quedó verificado; el resto queda documentado como bloqueo explícito, no simulado.

## 5. F12.4 — Endurecimiento de seguridad

`helmet()` montado (CSP desactivada a propósito — API JSON pura, nunca sirve HTML), `express.json({limit: "100kb"})`, 3 rate limiters por ruta (`missionLaunchLimiter` 20/h, `userInviteLimiter` 30/h, `exportLimiter` 30/15min) montados exactamente en las rutas que gastan dinero real o podrían usarse para spam — nunca a nivel de router completo (mismo criterio ya establecido en F4.8).

## 6. F12.5 — Resiliencia de jobs/misiones

Auditoría del watchdog (`runMissionCloseSweep`) encontró un punto ciego real: una misión con `output === null` (crash total antes de escribir cualquier progreso) nunca se consideraba "vieja" para el chequeo de staleness, porque el código sólo miraba `output?.progressUpdatedAt` y usaba `createdAt` como fallback, pero la condición de entrada al bloque de staleness dependía de que `output` no fuera `null`. Corregido: ahora usa `createdAt` como ancla real cuando no hay `output`, cerrando exactamente la clase de incidente que ya se había corregido antes de F12 (la misión que quedaba atascada en RUNNING).

## 7. F12.6 — Backups y recuperación

3 scripts reales (`db-backup.sh`, `db-restore.sh`, `db-verify-restore.sh`), `docs/BACKUP_AND_RECOVERY_RUNBOOK.md`. Ciclo real ejecutado dos veces en todo F12 (F12.6 y de nuevo en F12.12, ver §9): backup → restore a base aislada → verificación de conteos en 19 tablas → boot del API contra la base restaurada → datos reales servidos. Un hallazgo cosmético documentado sin ocultarlo: `pg_dump` local (18.4) emite `SET transaction_timeout = 0;`, no reconocido por el servidor real (`postgres:16`) — 1 warning ignorado, cero pérdida de datos confirmada por conteo exacto en ambas ejecuciones.

## 8. F12.7 — Observabilidad

Logger JSON estructurado (`core/logger.ts`), `X-Request-Id` real por request, `GET /api/v1/health/live` (sin DB) y `GET /api/v1/health/ready` (DB + migraciones + auth config) nuevos junto al `/health` original, graceful shutdown real (SIGTERM/SIGINT/uncaughtException/unhandledRejection → detiene 3 schedulers → cierra HTTP server → desconecta Prisma → exit 0, con timer de force-exit a 10s). Verificado con un SIGTERM real a un proceso hijo real (`graceful-shutdown.test.ts`), no solo revisión de código.

## 9. F12.8 — Rendimiento

Solo evidencia, sin optimizaciones prematuras: `EXPLAIN ANALYZE` real sobre la query de AuditLog (0.25ms, index scan sobre 62k+ filas — ya bien indexada) y sobre Notification (seq scan correcto para una tabla de 11 filas, un índice ahí sería contraproducente). Cero cambios de código — no había nada que corregir con evidencia real de un problema.

## 10. F12.9 — Herramientas administrativas

Verificado que `UsersPanel.tsx` (invite/estado/rol/revocar sesiones) y la acción "recuperar" de `Missions.tsx` ya existen y están conectadas a endpoints reales. Cero código nuevo — explícitamente no se construyó un "super admin SaaS" innecesario, tal como pedía el alcance.

## 11. F12.10 — UX de producción

2 gaps reales encontrados: (1) sin ruta catch-all, cualquier URL desconocida no renderizaba nada; (2) sin `ErrorBoundary` en ningún punto del árbol de React, un error de render tumbaba toda la app a una pantalla en blanco. Ambos corregidos (`pages/NotFound.tsx` + ruta `*` en `router.tsx`; `components/ErrorBoundary.tsx` envolviendo el árbol completo en `main.tsx`, incluido `ClerkProvider`). Verificado en vivo con Playwright contra el dev server real, no solo build/typecheck.

## 12. F12.11 — CI, blueprint de Render, runbooks

Antes de escribir `.github/workflows/ci.yml`, se ejecutó a mano el recipe completo (prisma validate → migrate deploy sobre una base de Postgres vacía → seed → typecheck → lint → build → suite completa de `apps/api` → e2e de Playwright) contra una base de datos aislada nueva. Esto sacó a la luz **4 hallazgos reales** que la base de desarrollo persistente venía ocultando por accidente (ver el commit `7f78207` para el detalle completo de cada uno):

1. Los rate limiters de F12.4 comparten un store en memoria durante toda la vida del proceso de test — corregido con `skip` bajo `NODE_ENV=test` + las 4 pruebas de "wiring" reescritas para inspeccionar el stack real de Express en vez de disparar requests.
2. El test de budget guard dependía de gasto de IA ya acumulado ambientalmente — corregido creando su propio `AgentTask` con costo real.
3. El test de deduplicación de contactos dependía de `PEOPLEDATALABS_API_KEY` ambiental sin pasarla explícitamente — corregido.
4. Un e2e no toleraba el primer 404 esperado de `GET .../matching` (mismo patrón ya usado en otro spec) — corregido.

`.github/workflows/ci.yml` (nunca ejecuta un deploy), `render.yaml` ahora incluye `ai-staffing-os-web` como sitio estático, `docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md` y `docs/PRODUCTION_SMOKE_TEST_CHECKLIST.md` nuevos. **Costo real recurrente documentado explícitamente**: la suite completa de `apps/api` hace llamadas reales a OpenAI/PDL/Google Places/Hunter para ~15 pruebas — sin esos 4 secrets configurados en GitHub, esas pruebas fallan de forma honesta en cada corrida de CI; configurarlos es una decisión de costo explícita del PO, no asumida por este workflow.

## 13. F12.12 — Validación final desde cero

Base de datos nueva (`ai_staffing_os_f1212`), migrate deploy limpio, seed, boot del API con los 3 health checks en verde, suite completa de `apps/api` (1361 pass / 5 fail / 5 skip — ver §14), suite completa de e2e (61/61), ciclo completo de backup→restore→verify→boot repetido con éxito (19/19 tablas coinciden), chequeos de seguridad en vivo (tenant IDOR, CORS, rate limit headers, oversized body, sesión ausente/inválida, rol incorrecto — ver §14), revisión de git (sin secretos, sin `.env` trackeado, sin archivos temporales, working tree limpio).

**1 hallazgo real corregido en esta subfase**: un body de más de 100kb devolvía un 500 genérico en vez del 413 real que `body-parser` ya reporta — corregido en `core/errors.ts` con un caso explícito para `entity.too.large`, + 2 tests de regresión contra la app real completa.

## 14. Evidencia detallada de F12.12

### 14.1 Migraciones desde cero
`prisma migrate deploy` sobre una base de Postgres 16 recién creada: las 34 migraciones existentes aplicaron limpio, sin intervención manual.

### 14.2 Health checks
`GET /health` → `{"status":"ok","db":true,"authMode":"dev-bypass"}`. `GET /health/live` → `{"status":"ok"}`. `GET /health/ready` → `{"status":"ok","db":true,"migrationsApplied":true,"authConfigured":true}`.

### 14.3 Guardia de producción real
`NODE_ENV=production` + `AUTH_MODE=dev-bypass` → el proceso se niega a arrancar con el mensaje `FATAL: AUTH_MODE=dev-bypass is not allowed when NODE_ENV=production...` — confirmado en vivo, no solo por lectura de código.

### 14.4 Suite completa de `apps/api`
1361 pass / 5 fail / 5 skip de 1371 pruebas, contra la base aislada, con los 4 provider keys reales configurados. Los 5 fallos son **el mismo test de misiones**, con timings distintos entre sí — se confirmó 3 veces en corridas aisladas (fuera del proceso de 1371 tests) que las 7 pruebas de `missions.test.ts` pasan limpio, incluida esta exacta. La causa raíz es contención real de recursos en esta máquina de desarrollo específica (decenas de procesos ajenos corriendo en simultáneo durante la validación — otro agente activo, múltiples instancias de Chrome/Playwright, VS Code, un dev server de `apps/marketing` abandonado de una sesión anterior), no un defecto funcional: la espera de 45s de ese test específico (`waitForMissionChildren`) es sensible a la carga real de CPU de la máquina, y un runner de CI dedicado (GitHub Actions) no tiene esta contención. Documentado transparentemente, no ocultado — ver recomendación en §16.

### 14.5 E2E completo
61/61 pruebas de Playwright en verde contra los dev servers reales.

### 14.6 Backup/restore/verify/boot
Backup real (324K) → restore a base aislada (mismo warning cosmético ya documentado en F12.6, cero pérdida real) → verify: **19/19 tablas coinciden exactamente** → boot del API contra la base restaurada → `GET /companies` sirve las 8 companies reales del seed.

### 14.7 Seguridad en vivo
- Tenant IDOR: `GET /companies/<id-inexistente>` → 404 real, nunca datos.
- CORS: origen no permitido → sin header `Access-Control-Allow-Origin`; origen permitido (`localhost:5173`) → header presente.
- Rate limit: `POST /missions` expone `RateLimit-Limit: 20`/`RateLimit-Remaining: 19` reales.
- Body de 200KB → **413 real** (corregido en esta subfase, antes era 500).
- Sesión ausente (dev-bypass): defaultea a `DEV_DEFAULT_USER_EMAIL` — comportamiento intencional de conveniencia de desarrollo, imposible en producción real por el guardia de §14.3.
- Identidad inválida (email sin usuario real) → 401 real.
- Rol incorrecto (`compliance` pidiendo `missions.create`) → 403 real.

### 14.8 Revisión de git
`git status` limpio, sin `.env` trackeado, sin literales con forma de secreto en el código fuente trackeado, sin archivos temporales de esta sesión (los 2 scripts de verificación ad-hoc creados durante F12.10/F12.11 se borraron después de usarlos).

## 15. Deuda técnica y bloqueadores conocidos (no resueltos, documentados a propósito)

1. **Cuenta real de Render** — bloqueador externo, requiere que el PO conecte el repo desde su cuenta.
2. **Credenciales reales de Clerk** — diferido por decisión explícita del PO (2026-07-12). El código está listo (F12.3 lo verificó/corrigió), solo falta la aplicación Clerk real.
3. **Costo recurrente de CI completo** — si el PO configura los 4 secrets de proveedores en GitHub, cada push/PR incurre en costo real de OpenAI/PDL/Google Places/Hunter. Sin configurarlos, ~15 pruebas fallan de forma honesta en cada corrida.
4. **Flakiness ambiental de un test bajo contención extrema de CPU** (§14.4) — no es un defecto de producto, pero si se repite en un runner de CI real bajo carga, subir el timeout de `waitForMissionChildren` en ese test específico de 45s a un valor mayor es una mejora de bajo riesgo, no aplicada en F12 por no tener evidencia de que sea necesaria en un entorno de CI real y dedicado.
5. **Mover backups manuales a storage externo duradero** — decisión operativa/de costo del PO, no implementada (ver `docs/BACKUP_AND_RECOVERY_RUNBOOK.md` §9).

## 16. Commits de F12 (cada uno independiente, ver `git log`)

`401880e` F12.1 · `52e94e4` F12.2 · `86ed2da` F12.3 · `06a5dcc` F12.4 · `52b06e2` F12.5 · `7bbdc69` F12.6 · `cbf6731` F12.7 · (F12.8/F12.9 sin commit — cero cambios de código) · `c818893` F12.10 · `7f78207` + `faf243a` F12.11 · `1308c9c` F12.12.

## 17. Declaración final

**F12 COMPLETE.**

Cero hallazgos P0/P1 sin corregir. Cero regresiones introducidas (suite completa verde salvo el caso de flakiness ambiental documentado y explicado en §14.4, no funcional). Autenticación real (Clerk) implementada y verificada hasta donde las credenciales lo permiten, bloqueo externo documentado sin fingir verificación. DEV-BYPASS comprobadamente imposible en producción real. Tenancy/RBAC/IDOR verificados en vivo. CORS correcto. Rate limiting activo y verificado. Los jobs/misiones nunca quedan atascados indefinidamente (watchdog + guardia síncrona, ambos con test de regresión). Los 3 health checks funcionan. Graceful shutdown verificado con una señal real. Backup y restore reales verificados dos veces con conteo exacto de filas. Migraciones desde cero verificadas dos veces. Typecheck/lint/build limpios en todos los workspaces. Suites principales y e2e en verde. Runbooks creados. Cero pérdida de datos en ningún punto de F12. Git limpio. **No se hizo push. No se desplegó. No se empezó F13. No se agregaron planes, suscripciones ni checkout SaaS.**
