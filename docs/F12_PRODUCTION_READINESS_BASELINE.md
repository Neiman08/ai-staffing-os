# F12.1 — Production Readiness Baseline

**Fecha**: 2026-07-19. **Commit base**: `90fc28d`. **Alcance**: auditoría previa a cualquier cambio de código de F12, per autorización del PO ("Preparar AI Staffing OS para operación real de nuestra propia agencia de staffing").

No se declara nada production-ready en este documento — es un mapa de estado real, riesgos y bloqueadores.

## 1. Resumen ejecutivo

El sistema tiene una base de seguridad/tenancy/RBAC ya sólida (confirmada exhaustivamente en la auditoría pre-F11 y en F11), y una infraestructura de autenticación con Clerk **mucho más avanzada de lo que "diferido" sugiere**: proveedor real (`clerk.provider.ts`), sincronización de identidad vía webhooks con verificación de firma svix (`webhook-handlers.ts`), guard de arranque que ya impide `AUTH_MODE=dev-bypass` en `NODE_ENV=production`, y 6 archivos de test reales para todo esto. Lo que falta para producción no es "construir Clerk desde cero" sino: (a) verificarlo contra una cuenta Clerk real (bloqueado por falta de credenciales — ver §3), (b) cerrar los huecos operativos reales que sí son 100% código nuestro: rate limiting incompleto, sin `helmet`, sin graceful shutdown, sin backups, sin CI, sin runbooks.

## 2. Documentos revisados

`docs/PRE_F11_FULL_AUDIT_FINAL_REPORT.md`, `docs/F11_FINAL_REPORT.md`, `docs/F10_FINAL_REPORT.md`, `docs/F4_9_PRODUCTION_AUTH_PLAN.md` (referenciado, ya leído en sesiones anteriores de este mismo hilo), `render.yaml`, `docker-compose.yml`, `.env.example`, `apps/api/src/core/env.ts`, `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/src/modules/auth/*`, `apps/api/src/modules/production-readiness/*`, `apps/web/src/components/settings/UsersPanel.tsx`.

## 3. Estado actual por área

### 3.1 Arquitectura / configuración de API y frontend
Monorepo pnpm, Express + Prisma (API), Vite + React (web). `app.ts` monta CORS con allowlist real (`APP_ORIGIN`/`MARKETING_ORIGIN`, sin `credentials: true` — modelo Bearer token, no cookies), luego el webhook de Clerk (raw body, antes de `express.json()`), luego `clerkMiddleware()` condicional a `AUTH_MODE=clerk`, luego `tenancyMiddleware`. 33 routers montados. Ya correcto y no requiere rediseño.

### 3.2 Prisma
57 modelos, 34 migraciones, todas aditivas (verificado repetidamente en la auditoría pre-F11 y en cada fase desde F1). `prisma migrate status` limpio al cierre de F11. Nada que migrar en F12 salvo que una subfase encuentre una necesidad real (no se anticipa ninguna).

### 3.3 Variables de entorno
`core/env.ts` ya usa Zod con validación centralizada y falla rápido (`process.exit(1)`) si el parseo falla. Ya tiene el guard crítico: `NODE_ENV=production && AUTH_MODE=dev-bypass` → fatal. Ya tiene el guard `AUTH_MODE=clerk` sin `CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY` → fatal. **Gap real**: no hay un `.env.example` por entorno (solo uno genérico), no hay documentación exhaustiva de cada variable en un solo lugar, y varias variables opcionales (`OUTREACH_FROM_EMAIL`, etc.) no tienen guía clara de "cuándo son obligatorias". `PRODUCTION_MODE` existe (F4.7.5) pero nunca se activó — su semántica exacta necesita quedar documentada antes de F12.2.

### 3.4 Render
`render.yaml` ya existe (F4.9-D4) — blueprint real para el API + Postgres. **Bloqueadores reales**: `NODE_ENV=development` y `AUTH_MODE=dev-bypass` hardcodeados con un comentario "DECISIÓN PENDIENTE DEL PO" — exactamente la decisión que este F12 debe cerrar. No hay blueprint para `apps/web` (frontend estático) ni `apps/marketing`.

### 3.5 Clerk
Implementación real y sustancial ya existe:
- `clerk.provider.ts` (`ClerkAuthProvider`, resuelve tenant SOLO por `clerkOrganizationId`, nunca por dato del cliente — ya documentado y testeado).
- `clerk-identity.ts` (mapeo de identidad Clerk → User/Role/tenant/company/worker/candidate).
- `webhook.router.ts` + `webhook-handlers.ts` (verificación de firma svix real, sync de `user.created/updated/deleted`, `organization.created/updated`, `organizationMembership.created/updated/deleted`).
- 6 archivos de test reales (`clerk.provider.test.ts`, `clerk-identity.test.ts`, `webhook-handlers.test.ts`, `webhook.router.test.ts`, `user-management.test.ts`, `portal-identity.test.ts`).

**Bloqueador real**: `.env` no tiene `CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY`/`CLERK_WEBHOOK_SECRET` reales — no existe una cuenta Clerk real conectada a este proyecto. Esto es una **dependencia externa que este agente no puede resolver por sí mismo** (requiere que el PO cree una cuenta/aplicación en clerk.com y comparta las claves). F12.3 va a verificar todo lo verificable sin esas claves (tests existentes, guards de arranque, revisión de código) y documentará este bloqueo explícitamente — no se va a fingir una verificación real contra Clerk que no puede ocurrir.

### 3.6 CORS
Ya correcto desde F4.9 (allowlist real, sin `credentials`). Sin cambios necesarios salvo agregar el dominio real de producción cuando exista (paso manual del runbook, no código).

### 3.7 Logging
`console.log`/`console.error` dispersos, con un helper local `log()` en `mission-orchestrator.ts` (formato JSON parcial). **Gap real**: sin logging estructurado uniforme, sin request ID, sin correlación tenant/usuario/duración/status code de forma consistente entre módulos.

### 3.8 Health checks
`GET /api/v1/health` ya existe, ya verifica conectividad real a DB (`SELECT 1`), ya devuelve 503 si la DB está caída. **Gap real**: es un solo endpoint mezclando liveness y readiness; F12.7 pide ambos por separado.

### 3.9 Manejo de errores
`core/errors.ts` ya confirmado seguro en la auditoría pre-F11 (errores inesperados nunca filtran stack trace/mensaje interno, siempre `INTERNAL_ERROR` genérico al cliente, log solo server-side). Sin cambios necesarios.

### 3.10 Procesos en background
3 schedulers arrancan sin condición en `index.ts` (`startProspectingScheduler`, `startComplianceAlertScheduler`, `startBillingOverdueScheduler`) — todos ya usan barrido por tenant activo, ya revisados en la auditoría pre-F11 sin hallazgos de tenancy. `mission-orchestrator.ts` ya tiene una batería real de protecciones de ciclo de vida (timeout de misión, detección de stale, terminalización garantizada, recuperación) construida en fases anteriores — y el bug real que aún quedaba (ventana síncrona sin captura de errores en `launchMission`) ya se corrigió y verificó con 3 misiones reales end-to-end en el turno anterior a este F12. **Gap real**: `index.ts` no tiene manejo de `SIGTERM`/`uncaughtException`/`unhandledRejection` — un `kill` (o el ciclo de vida real de un dyno de Render) no cierra conexiones de forma ordenada.

### 3.11 Scripts de seed
`prisma/seed.ts` es completamente idempotente (`upsert` por ID fijo en todos los loops determinísticos, ya confirmado en incidentes anteriores de esta sesión). Nunca borra datos. Sin cambios necesarios.

### 3.12 Backups
**No existe ningún script ni estrategia de backup todavía.** Gap completo — F12.6 parte de cero.

### 3.13 Docker
Solo `docker-compose.yml` para Postgres local (dev). No hay `Dockerfile` para `apps/api`/`apps/web`. Render usa Node runtime nativo (buildpack), no Docker — no es necesariamente un bloqueador si el despliegue sigue siendo vía Render nativo, pero se documentará como decisión explícita en F12.11 en vez de asumir.

### 3.14 CI
**No existe ningún workflow de CI.** Gap completo — F12.11 parte de cero. Los scripts (`typecheck`/`lint`/`test`/`build`) ya existen y son ejecutables vía `pnpm --recursive run <script>` desde la raíz — la base para armar CI ya está.

### 3.15 Tests
Suite backend: 1352 tests, ~1347 pass de forma estable (1 test conocido como flaky por dependencia real de red a OpenAI, ya documentado en F7/F11). E2E: 61 tests, 1 falla pre-existente documentada desde F8 (`job-order-matching.spec.ts`, ajena a cualquier fase reciente). Typecheck/lint/build limpios en ambas apps.

### 3.16 Documentación
Extensa y actualizada por fase (F0-F11). Faltan los 4 documentos específicos de operación que F12 debe crear (backup/recovery, deployment runbook, smoke test checklist, y este baseline).

## 4. Dependencias de desarrollo activas en runtime — identificadas

- `AUTH_MODE=dev-bypass` es el modo activo hoy en `.env` local — correctamente bloqueado de producción por el guard de `env.ts`, pero `render.yaml` todavía lo declara como valor del blueprint (ver §3.4).
- El banner "DEV-BYPASS auth is active" en el frontend (`DevBanner.tsx`) ya está condicionado a que el modo esté realmente activo — verificado visualmente en múltiples capturas de esta sesión.

## 5. Rutas de DEV-BYPASS

`modules/auth/dev-bypass.provider.ts` — confía en el header `x-dev-user` sin verificación criptográfica. Ya bloqueado de producción por `env.ts` (fatal al arrancar). No se ha encontrado ningún código que pueda activar este modo condicionalmente en runtime sin pasar por esa validación de arranque — es la mitigación correcta y ya existe.

## 6. Secretos potencialmente expuestos

`.env` (real, con claves de desarrollo) está en `.gitignore` (confirmado). `.env.example` no contiene ningún secreto real (`OPENAI_API_KEY=`, `CLERK_SECRET_KEY=` vacíos). `git log` de todo el proyecto nunca commiteó `.env` (verificado por la ausencia del archivo en `git status`/`git log --all -- .env` a lo largo de toda la sesión). Sin hallazgos.

## 7. Variables obligatorias no validadas

Ninguna a nivel de arranque — `envSchema.safeParse` ya cubre el 100% de `process.env` relevante y falla si `DATABASE_URL` falta. El único gap es de **documentación**, no de validación: no hay una tabla centralizada "variable → obligatoria en qué entorno → default → dónde se usa" (F12.2 la crea).

## 8. Configuraciones inseguras

- Sin `helmet` (o equivalente) — sin headers de seguridad (`X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, etc.).
- `express.json()` sin límite explícito de tamaño (usa el default de Express, 100kb — razonable pero no documentado ni decidido explícitamente).
- Rate limiting solo existe en `modules/public/router.ts` (tráfico anónimo del sitio de marketing) — ningún límite en `/missions`, `/exports` (analytics/payroll), `/auth/users/invite`, búsquedas, ni ninguna ruta autenticada interna.

## 9. Endpoints sin límites

`/analytics/*/export`, `/payroll/*/export`, `/missions` (POST, dispara una llamada real a OpenAI + potencialmente varias más), `/discovery/*` (búsquedas externas reales) — ninguno tiene rate limiting ni límite de tamaño de respuesta explícito.

## 10. Procesos que puedan quedar atascados / jobs no recuperables

Ya cubierto extensamente por el trabajo de "bugfix de ciclo de vida" en `mission-orchestrator.ts` (timeout, detección de stale, terminalización garantizada) más el fix de esta misma sesión (ventana síncrona de `launchMission` sin captura). **Gap real remanente**: ese mismo patrón (terminalización garantizada + timeout) no se ha auditado explícitamente para el resto de `AgentTask` (tareas hijas individuales fuera del árbol de una misión — ej. una tarea `find_email`/`match_workers_to_job_order` lanzada de forma aislada) ni para jobs asíncronos fuera del árbol de agentes (exports, notificaciones). F12.5 lo audita explícitamente.

## 11. Riesgo de pérdida de datos

Ninguno nuevo identificado. El único incidente de pérdida de datos de todo el proyecto (F10.6, ya documentado exhaustivamente en la auditoría pre-F11) es histórico, irreversible, y no afecta datos de negocio — no bloquea F12.

## 12. Diferencias entre entorno local y producción

- Local: `AUTH_MODE=dev-bypass`, `NODE_ENV=development`, Postgres en Docker local (puerto 5433), sin Clerk, sin CORS de producción.
- Producción (planeada): `AUTH_MODE=clerk` (obligatorio por el guard), `NODE_ENV=production`, Postgres gestionado por Render, dominios reales en CORS, claves de OpenAI/Clerk reales.
- **Ninguna migración de datos entre ambos** — son bases físicamente distintas, correcto y esperado.

## 13. Riesgos

| Riesgo | Severidad | Mitigación planeada |
|---|---|---|
| Deploy a producción con `AUTH_MODE=dev-bypass` | Crítico si ocurriera, pero **ya mitigado** por el guard de arranque de `env.ts` | F12.2/F12.11 solo necesitan actualizar `render.yaml` para reflejar la intención real, el guard ya existe |
| Sin rate limiting en rutas sensibles | Alto | F12.4 |
| Sin backups | Alto | F12.6 |
| Sin graceful shutdown | Medio | F12.7 |
| Sin CI | Medio (no bloquea operación, sí bloquea calidad continua) | F12.11 |
| Verificación real de Clerk bloqueada por falta de credenciales externas | Alto, pero **fuera del control de este agente** | Documentar exhaustivamente en F12.3, dejar pasos manuales claros en el runbook |

## 14. Bloqueadores

1. **Credenciales reales de Clerk** (CLERK_SECRET_KEY/CLERK_PUBLISHABLE_KEY/CLERK_WEBHOOK_SECRET de una aplicación Clerk real) — no disponibles en este entorno, requieren acción del PO fuera de este agente.
2. **Cuenta/dashboard real de Render** para ejecutar el blueprint — mismo tipo de bloqueo, ya documentado desde F4.9-D4, no cambia en F12 (F12 prepara, no despliega, por instrucción explícita).
3. Ningún bloqueador técnico interno impide completar el resto de F12 (F12.2, F12.4-F12.10, F12.12) con evidencia real usando el entorno de desarrollo actual.

## 15. Componentes a endurecer (resumen para las subfases siguientes)

- F12.2: variables de entorno documentadas + `.env.example` por entorno.
- F12.3: verificación exhaustiva de todo lo verificable de Clerk sin credenciales reales; documentar el bloqueo.
- F12.4: helmet, rate limiting en rutas sensibles, límites de tamaño explícitos, tests de regresión de seguridad.
- F12.5: auditoría de terminalización garantizada para AgentTask fuera del árbol de misiones.
- F12.6: backups desde cero.
- F12.7: logging estructurado, health/live + health/ready, graceful shutdown.
- F12.8: auditoría de rendimiento basada en evidencia (EXPLAIN real, no especulación).
- F12.9: verificar que el toolkit de admin ya existente (`auth/router.ts`: invite/status/role/revoke-sessions, `UsersPanel.tsx`) esté completo y correctamente expuesto en la UI — no construir un admin nuevo.
- F12.10: pase de UX/accesibilidad sobre lo ya construido.
- F12.11: CI desde cero, runbooks.
- F12.12: validación final end-to-end.

## 16. Plan real de F12

Ejecutar F12.2 → F12.12 en orden, cada uno con su propio commit lógico, sin pausar entre subfases salvo bloqueo real de pérdida de datos/decisión irreversible de producto (ninguno anticipado). Reutilizar exhaustivamente lo ya construido (Clerk, `auth/router.ts`, `express-rate-limit` ya instalado, patrón de test ya establecido) antes de escribir código nuevo.

## 17. Criterios de salida (recordatorio, no se declara cumplido acá)

Ver la lista completa de criterios en la instrucción original del PO — se evalúan recién en F12.12/`docs/F12_FINAL_REPORT.md`, nunca antes.
