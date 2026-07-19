# Production Deployment — vista general

F14 (2026-07-19). Documento de entrada única: qué se va a crear en Render, en qué orden, cuánto cuesta aproximadamente, y qué falta para que el siguiente paso sea únicamente crear los recursos reales en el dashboard de Render. La mecánica detallada de Render vive en `docs/RENDER_DEPLOYMENT.md`; este documento es el resumen ejecutivo y el mapa hacia el resto de la documentación operativa.

Como con cualquier otra fase de este proyecto: **preparación de código únicamente**. Ningún recurso real fue creado, ningún deploy fue ejecutado. El repositorio queda listo para que el PO conecte su propia cuenta de Render y confirme la creación del Blueprint.

## 1. Arquitectura real (auditada, no asumida)

Monorepo `pnpm` (workspaces: `apps/*`, `packages/*`), sin Turborepo (los scripts recursivos de `package.json` raíz usan `pnpm --recursive`, no hay `turbo.json` en el repo).

| Workspace | Qué es | Se despliega como |
|---|---|---|
| `apps/api` | Backend real — Express + Prisma, 33 routers, CEO Agent y el resto de agentes autónomos, 3 schedulers en background (prospecting/compliance/billing) **dentro del mismo proceso** | `ai-staffing-os-api` — Web Service (Node) |
| `apps/web` | Frontend — CRM/dashboard interno + portales de cliente/candidato/trabajador (Vite + React SPA) | `ai-staffing-os-web` — Static Site |
| `apps/marketing` | Landing pública (dreistaff.com) — Vite + React SPA independiente, solo habla con `/api/v1/public/*` | `ai-staffing-os-marketing` — Static Site |
| `packages/db` | Prisma (schema, 35 migraciones, seed) — librería, no un servicio propio | Usado en build-time por `ai-staffing-os-api` |
| `packages/agents` | Lógica compartida de agentes de IA (tools, cost tracking) — librería | Usado por `ai-staffing-os-api` |
| `packages/shared` | Tipos/schemas Zod compartidos — librería | Usado por todos los anteriores |
| **Base de datos** | PostgreSQL 16 (57 modelos Prisma) | `ai-staffing-os-db` — Render Postgres gestionado |
| **Worker** | **No existe.** Los 3 schedulers (`startProspectingScheduler`, `startComplianceAlertScheduler`, `startBillingOverdueScheduler`) arrancan con `setInterval` dentro de `apps/api/src/index.ts` — mismo proceso que la API, mismo dyno. No hay ningún archivo/paquete de "worker" en el repo. | No se crea ningún servicio de worker — inventar uno sería preparación falsa. |

## 2. Los 4 servicios que se van a crear en Render

Exactamente estos 4, ninguno más:

1. **`ai-staffing-os-db`** (PostgreSQL 16, plan `starter`)
2. **`ai-staffing-os-api`** (Node Web Service, plan `starter`)
3. **`ai-staffing-os-web`** (Static Site, sin costo de plan)
4. **`ai-staffing-os-marketing`** (Static Site, sin costo de plan)

Configuración completa de cada uno (root directory, build/start command, health check, Node version, auto-deploy, disco, URLs, publish directory) — ver `docs/RENDER_DEPLOYMENT.md` §2.

**Orden de creación** — ver `docs/RENDER_DEPLOYMENT.md` §3. Resumen: los 4 se crean juntos vía Blueprint, pero `web`/`marketing` necesitan un segundo paso (completar `VITE_API_URL` + redeploy) una vez que `ai-staffing-os-api` tiene una URL real.

## 3. Variables de entorno

Referencia completa, separada backend/frontend, con la validación real de Zod (`apps/api/src/core/env.ts`) como fuente de verdad: `docs/RENDER_ENVIRONMENT_VARIABLES.md`.

Resumen de lo que se completa a mano en el dashboard de Render (nunca en `render.yaml`, todas `sync: false` a propósito):

- **`ai-staffing-os-api`**: `APP_ORIGIN`, `MARKETING_ORIGIN`, `API_ORIGIN`, `OPENAI_API_KEY`, `GOOGLE_PLACES_API_KEY`, `PEOPLEDATALABS_API_KEY`, `HUNTER_API_KEY`, `BUSINESS_DOMAIN`, `APP_DOMAIN`. `CLERK_*` solo cuando se active (ver §5).
- **`ai-staffing-os-web`**: `VITE_API_URL`, `VITE_CLERK_PUBLISHABLE_KEY` (cuando se active Clerk).
- **`ai-staffing-os-marketing`**: `VITE_API_URL`, `BUSINESS_DOMAIN` (build-time, para `robots.txt`/`sitemap.xml`).

## 4. Plan recomendado por servicio (agencia chica)

| Servicio | Plan | Costo | Por qué |
|---|---|---|---|
| `ai-staffing-os-db` | Starter | $7/mes | Backups diarios automáticos (7 días de retención) incluidos — suficiente para el volumen real de una agencia chica. Subir a Standard solo con evidencia real de necesitarlo (más conexiones concurrentes, más almacenamiento). |
| `ai-staffing-os-api` | Starter | $7/mes | 512MB RAM — suficiente para el tráfico de una agencia chica sin colas pesadas (no hay worker separado, todo corre acá). Si el volumen de misiones/usuarios concurrentes crece notoriamente, subir a Standard ($25/mes, más RAM/CPU) — decisión basada en evidencia real (ver F12.8, mismo criterio de este proyecto: nunca optimizar sin medir primero). |
| `ai-staffing-os-web` | Static | $0 | Render no cobra plan por sitios estáticos — banda ancha incluida, compresión gzip/brotli automática de la plataforma. |
| `ai-staffing-os-marketing` | Static | $0 | Ídem. |

**Infraestructura fija**: **$14/mes** (`db` + `api`, ambos Starter). Los costos variables (OpenAI, Google Places, Hunter, PDL) se estiman en §7 según volumen real de misiones.

## 5. Clerk (autenticación de producción)

`docs/CLERK_PRODUCTION_READINESS.md` — qué ya existe (provider, webhooks, tests, guards de arranque), qué falta (credenciales reales, Organizations en Clerk, mapeo `Tenant.clerkOrganizationId`), y los pasos exactos para activarlo. **`dev-bypass` no se toca ni se elimina** — sigue siendo el modo activo hasta que el PO decida activar Clerk.

## 6. Seguridad — estado real verificado

| Área | Estado | Evidencia |
|---|---|---|
| Secrets en el repo | Limpio | `git grep` de patrones de secretos + `.env` no trackeado — verificado en cada fase, gate automático en `.github/workflows/ci.yml` ("Secret scan") |
| `.gitignore` | Cubre `.env`, `backups/`, `*.dump`, salida de Playwright, `dist/`/`build/` | Revisado en esta fase |
| CORS | Allowlist real (`APP_ORIGIN`/`MARKETING_ORIGIN`), sin `credentials: true` (modelo Bearer token) | `apps/api/src/app.ts`, verificado en vivo en F12.12 (origen no permitido → sin header; permitido → header presente) |
| Headers de seguridad | `helmet()` montado (CSP desactivada a propósito — API JSON pura, nunca sirve HTML) | `apps/api/src/app.ts` |
| Cookies | No aplica — auth es Bearer token / header `x-dev-user`, nunca cookies cross-origin | Decisión explícita, ver `docs/F4_9_PRODUCTION_AUTH_PLAN.md` §4.1/§10 |
| Rate limiting | 3 limiters reales por ruta específica (`missionLaunchLimiter` 20/h, `userInviteLimiter` 30/h, `exportLimiter` 30/15min) | `apps/api/src/core/rate-limiters.ts`, verificado en vivo (headers `RateLimit-*` reales) |
| Uploads | **Adapter mock explícito** (`LocalMockDocumentStorageProvider`) — nunca guarda bytes reales, genera una referencia `mock://` para que quede explícito que ningún documento se sube de verdad todavía | `apps/api/src/core/document-storage/local-mock.provider.ts` — **gap real y conocido, no oculto**: conectar un adapter real (S3/GCS/etc.) es trabajo pendiente, fuera del alcance de esta fase (nadie pidió construirlo, y decidir el proveedor de storage real es una decisión operativa del PO) |
| Body limits | `express.json({ limit: "100kb" })`, 413 real (no 500) para body sobredimensionado | `apps/api/src/app.ts`, corregido y verificado en F12.12 |
| Prisma | Nunca query cruda con input del usuario sin parametrizar (Prisma ORM por diseño), tenancy verificado en vivo (IDOR → 404, nunca datos de otro tenant) | F12.12 §14.7 |
| OpenAI / Google Places / Hunter / PDL | Todos opcionales a nivel de arranque — cada uno se degrada honestamente si falta la key (nunca inventa datos) | `apps/api/src/core/env.ts`, `docs/RENDER_ENVIRONMENT_VARIABLES.md` |

## 7. Rendimiento — estado real verificado + 1 mejora aplicada en esta fase

| Área | Estado |
|---|---|
| Build | `pnpm run build` limpio en los 3 workspaces desplegables (`api` no tiene build propio — corre con `tsx` directo, ver `start:deploy`) |
| Bundle / chunks | **Hallazgo real, no corregido en esta fase** (fuera de alcance — sería un refactor de rutas, no preparación de deploy): `apps/web` compila a un único chunk JS de **1.7MB** sin code-splitting por ruta (`apps/web/src/router.tsx` no usa `React.lazy`/`Suspense`). `apps/marketing` es más liviano (305KB, sitio más simple). **Recomendación para una fase futura, no aplicada acá**: `React.lazy()` por página en `router.tsx` reduciría el bundle inicial — no se tocó en esta fase por ser un cambio de código de UI con superficie de regresión real, fuera del alcance de "preparar despliegue". |
| Compression | **Corregido en esta fase**: `apps/api` no comprimía ninguna respuesta (Express no lo hace por default). Agregado `compression()` (paquete `compression`, estándar de Express) — verificado en vivo, `curl` con `Accept-Encoding: gzip` ahora recibe `Content-Encoding: gzip` real. `apps/web`/`apps/marketing` no lo necesitan — Render comprime automáticamente sitios estáticos en su CDN. |
| Caching | Render sirve sitios estáticos con cache-control razonable por default (assets con hash en el nombre de archivo, ya cacheables de forma segura — ver `apps/web/dist/assets/index-<hash>.js`). Sin configuración adicional necesaria para esta escala. |
| Prisma / connection pool | `new PrismaClient()` sin `connection_limit`/`pool_timeout` explícitos en `packages/db/src/index.ts` — usa el default de Prisma (`num_cpus * 2 + 1`). **Recomendación, no aplicada**: en Render Starter (recursos limitados, un solo dyno) esto es seguro tal cual; si se agregan más instancias del API (escalado horizontal) o se nota agotamiento de conexiones reales contra el plan de Postgres contratado, agregar `?connection_limit=N&pool_timeout=N` a `DATABASE_URL` — cambio de configuración, no de código. |
| Memoria / CPU | Sin evidencia real de un problema (F12.8: `EXPLAIN ANALYZE` sobre las tablas más grandes — `AuditLog` 62k+ filas ya con index scan de 0.25ms, `Notification` con seq scan correcto para su tamaño). Plan `starter` (512MB) es razonable para el volumen actual; monitorear métricas reales de Render post-deploy antes de asumir que hace falta más. |
| Timeouts | Graceful shutdown real con timer de force-exit a 10s (`apps/api/src/index.ts`) — verificado con una señal `SIGTERM` real en F12.7. |

## 8. Costo estimado mensual (agencia chica)

**Infraestructura fija**: $14/mes (`ai-staffing-os-db` + `ai-staffing-os-api`, ambos Starter — ver §4). `web`/`marketing` sin costo de plan.

**Costo variable por misión** (evidencia real, no estimación teórica — medido en esta misma fase con 4 misiones reales de 10 empresas cada una, tenant aislado, providers reales): entre **$0.035** (una sola query, ej. bodegas) y **$0.13** (varias queries específicas + enriquecimiento, ej. hoteles) por misión de "10 empresas encontradas" que **necesita descubrimiento externo real** (Google Places, el costo dominante — $0.032 por query de hasta 20 resultados). Una misión cuyo sector/estado **ya tiene suficiente oferta en el CRM** (reutiliza empresas ya descubiertas antes) cuesta prácticamente $0 en proveedores externos — solo un par de llamadas chicas a OpenAI (interpretación + reporte).

Los proveedores de contacto (`HUNTER_API_KEY`, `PEOPLEDATALABS_API_KEY`) son **suscripciones mensuales fijas**, no pago por uso — su costo no escala linealmente con el número de misiones, escala con cuántos contactos reales se necesitan encontrar por mes (tope del plan contratado).

| Escenario | Misiones/mes | Infra Render | OpenAI + Google Places (estimado, mezcla realista ~30% requieren descubrimiento externo nuevo, 70% reutiliza CRM) | Hunter.io | People Data Labs | **Total aprox./mes** |
|---|---|---|---|---|---|---|
| **Chico** | 100 | $14 | ~$3–4 (30 misiones "frías" × ~$0.10) | Free (25 búsquedas/mes) o Starter $49 si se necesita más volumen | Opcional — Pro $98 si se activa | **$17 – $165** según cuánto contacto real se necesite |
| **Medio** | 500 | $14 | ~$15–20 (150 misiones frías × ~$0.10) | Growth $149/mes (recomendado a este volumen) | Pro $98/mes | **~$296** |
| **Grande** | 1.000 | $14 (o $25 si Standard, ver §4) | ~$30–40 (300 misiones frías × ~$0.10) | Scale $299/mes | Pro/Enterprise $98–2.500/mes según volumen real de contactos | **~$450 – $2.900** según cuántos contactos reales requiera el volumen |

**Nota honesta**: a partir de ~500 misiones/mes, el costo real deja de estar dominado por infraestructura/OpenAI/Google Places (siempre relativamente bajo) y pasa a estar dominado por **cuánto contacto real (Hunter/PDL) decida comprar la agencia** — ambos son totalmente opcionales y el sistema se degrada honestamente sin ellos (nunca inventa un contacto), así que el costo real final depende de una decisión de negocio del PO, no de un mínimo técnico obligatorio.

Fuentes de precios (julio 2026, verificar vigencia antes de presupuestar): [Render Pricing](https://render.com/pricing), [OpenAI API Pricing](https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/), [Google Maps Platform Pricing](https://developers.google.com/maps/billing-and-pricing/pricing), [Hunter.io Pricing](https://hunter.io/pricing), [People Data Labs Pricing](https://www.peopledatalabs.com/pricing/person).

## 9. Documentación completa

| Documento | Qué cubre |
|---|---|
| `docs/PRODUCTION_DEPLOYMENT.md` | Este documento — vista general |
| `docs/RENDER_DEPLOYMENT.md` | Mecánica exacta de Render: configuración por servicio, orden de creación, checklist previo, primer deploy, deploys posteriores |
| `docs/RENDER_ENVIRONMENT_VARIABLES.md` | Cada variable de entorno, backend y frontend, requerida/opcional/default |
| `docs/RENDER_SMOKE_TEST.md` | Checklist manual post-deploy (11 secciones: health, auth, tenancy, rate limiting, CEO Agent, backoffice, portales, backups, observabilidad, rendimiento) |
| `docs/ROLLBACK.md` | Procedimiento de rollback — código (caso común) y datos (caso raro) |
| `docs/BACKUP_AND_RESTORE.md` | Estrategia de backups, scripts, prueba real ya ejecutada dos veces |
| `docs/CLERK_PRODUCTION_READINESS.md` | Qué existe, qué falta, pasos exactos para activar Clerk |
| `docs/F12_PRODUCTION_READINESS_BASELINE.md` / `docs/F12_FINAL_REPORT.md` | Auditoría histórica completa (F12) — contexto de por qué el sistema llegó a este estado |

## 10. Checklist de despliegue (resumen accionable)

1. [ ] `docs/RENDER_DEPLOYMENT.md` §5 (checklist previo) completo y verde.
2. [ ] Cuenta de Render conectada por el PO (bloqueador externo, fuera del alcance de cualquier agente).
3. [ ] Blueprint creado desde `render.yaml` — 4 recursos, orden de disponibilidad según §3 de `RENDER_DEPLOYMENT.md`.
4. [ ] Variables de entorno completadas en el dashboard (`docs/RENDER_ENVIRONMENT_VARIABLES.md`), incluidas `VITE_API_URL` de `web`/`marketing` tras el segundo paso.
5. [ ] `healthCheckPath: /api/v1/health/ready` en verde.
6. [ ] Redeploy manual de `web`/`marketing` si `VITE_API_URL` se completó después del build inicial.
7. [ ] `docs/RENDER_SMOKE_TEST.md` completo contra las URLs reales.
8. [ ] Decisión explícita del PO sobre: activar Clerk ahora o seguir con dev-bypass (`docs/CLERK_PRODUCTION_READINESS.md`); qué provider keys opcionales activar (`OPENAI_API_KEY` como mínimo recomendado); si correr `seed` o crear el tenant real a mano.

## 11. Checklist de rollback (resumen accionable)

Ver `docs/ROLLBACK.md` completo. Resumen: rollback de código vía dashboard de Render o `git revert` (caso común, gracias a la política de migraciones solo-aditivas); rollback de datos solo si el código no alcanza, siempre restaurando primero en una base aislada (nunca directo sobre producción).

## 12. Confirmación final

- [x] Build limpio (`pnpm run build`, todos los workspaces desplegables).
- [x] Typecheck limpio (`pnpm run typecheck`, todos los workspaces).
- [x] Lint limpio (`pnpm run lint`, todos los workspaces).
- [x] Suite de tests verde (`apps/api`, ver `docs/F12_FINAL_REPORT.md` §14.4 para el detalle histórico; suite de este repo re-verificada en esta misma fase tras los cambios de F14, ver §13 de este documento).
- [x] `prisma validate` limpio, 35 migraciones aditivas.
- [x] Health checks (`/health`, `/health/live`, `/health/ready`) funcionando.
- [x] `render.yaml` validado (YAML parseable, 4 servicios reales, ningún recurso inventado).
- [x] Variables de entorno documentadas y cruzadas contra `env.ts` (fuente de verdad única).
- [x] Sin secretos en Git (`.env` no trackeado, secret scan de CI limpio).
- [x] Working tree limpio al cierre de esta fase.

**El siguiente paso real es exclusivamente crear los 4 recursos en Render desde la cuenta del PO — nada más queda pendiente del lado de este repositorio.** No se hizo push. No se desplegó. No se empezó F13.
