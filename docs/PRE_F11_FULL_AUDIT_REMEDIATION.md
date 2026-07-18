# Pre-F11 Full System Audit — Remediation

Ver hallazgos completos en `docs/PRE_F11_FULL_AUDIT_FINDINGS.md`. Este documento registra exactamente qué se cambió, por qué, y cómo se verificó, agrupado por commit — ningún commit mezcla hallazgos no relacionados.

## Commit `9a66116` — fix: close cross-tenant ownership gap in FollowUp/Campaign models

**Corrige**: F-05 (P0).

**Archivos**:
- `apps/api/src/core/tenancy/prisma-extension.ts` — agrega `FollowUp`, `Campaign`, `CampaignCompany`, `CompanyContactPoint` a `STRICT_TENANT_MODELS`.
- `apps/api/src/modules/agents/company-enrichment.ts` — `companyContactPoint.findUnique({ where: { companyId_email: {...} } })` → `findFirst({ where: { companyId, email } })`.
- `apps/api/src/modules/agents/mission-orchestrator.ts` — `campaignCompany.findUnique({ where: { campaignId_companyId: {...} } })` → `findFirst({ where: { campaignId, companyId } })`.
- `apps/api/src/core/tenancy/tenancy.test.ts` — 2 tests nuevos.

**Por qué esta forma y no otra**: la alternativa de "agregar un `where: { tenantId }` manual en cada uno de los 60+ call sites" se descartó — es exactamente el patrón que la extensión de Prisma existe para evitar (un solo punto de enforcement, no 60 lugares donde un desarrollador puede olvidarlo). Agregar los modelos al `Set` ya existente es el fix mínimo, consistente con cómo se protegen los otros 41 modelos STRICT.

**Verificación**:
1. `npm test` (backend completo) → 1278/1283 pass tras el primer intento (1 falla real: `campaignCompany.findFirst()` con `Unknown argument campaignId_companyId`, la limitación de compound-key ya documentada en F8).
2. Corregido el segundo call site (`mission-orchestrator.ts`, no detectado en la primera pasada porque el grep inicial no mostró el contenido del `where`).
3. Barrido final: `grep -rn "campaignId_companyId\|companyId_email" apps/api/src` → 0 resultados, confirmando que no queda ningún otro call site con el mismo patrón.
4. `npm test` re-ejecutado → 1278/1283 pass, 0 fail (vuelve al baseline exacto).
5. `npx tsx --test tenancy.test.ts` (aislado, con dotenv) → 10/10 pass, incluyendo los 2 tests nuevos.
6. `npm run typecheck` / `npm run lint` (backend) → limpios.
7. Verificado en una base de datos completamente aislada creada desde cero (Stage 3): migraciones 34/34 aplicadas, seed limpio, suite completa 1280/1285 pass (0 fail tras eliminar un proceso concurrente que escribía a la misma DB, ver nota de metodología en el baseline).

---

## Commit `2afde1c` — fix: secure unauthenticated legacy internal dashboard/revenue routes

**Corrige**: F-06 (P1), F-07 (P1), F-08 (P3, endurecimiento preventivo).

**Archivos**:
- `apps/api/src/core/rbac/require-permission.ts` — nueva función `requireInternalIdentity()`, mismo estilo que `requirePermission`/`requireAnyPermission`/`requireAllPermissions` ya existentes.
- `apps/api/src/modules/dashboard/router.ts` — aplicado a `/summary`, `/audit-log`, `/notifications`.
- `apps/api/src/modules/reports/router.ts` — aplicado a `/reports/operational`.
- `apps/api/src/modules/revenue/router.ts` — aplicado a `/revenue/summary`, `/revenue/intelligence`.
- `apps/web/e2e/portal-tenancy.spec.ts` — test nuevo.

**Por qué `requireInternalIdentity()` y no reusar un permiso existente**: se investigó reusar `auditLogs.view` (ya usado por F10.9 para el audit trail propio del portal) — descartado porque los roles CLIENT_ADMIN/WORKER/CANDIDATE ya tienen esa misma clave de permiso para SU PROPIO endpoint de portal; gatear el endpoint interno con el mismo permiso no lo habría cerrado. `requireInternalIdentity()` usa la misma señal que ya usan los checks de ownership de portal en la dirección opuesta (`ctx.companyId/workerId/candidateId`), es imposible de confundir con un permiso mal heredado, y no requiere seedear ni asignar ningún permiso nuevo a los 11 roles internos.

**Análisis de impacto antes de aplicar** (para descartar regresión):
- `grep -rln "dashboard/audit-log\|dashboard/summary\|dashboard/notifications" apps/web/src` → solo `pages/Dashboard.tsx` y `pages/AIDashboard.tsx` llaman `/dashboard/summary` y `/dashboard/audit-log` (ambas páginas exclusivas del shell interno, jamás renderizadas en un portal). `dashboard/notifications` no tiene ningún caller real en el frontend — `NotificationBell.tsx` (usado en ambos shells) ya fue migrado en F10.8 a `/notifications/*`, el comentario del propio archivo lo confirma ("reemplaza el widget decorativo de F0/F1").
- `reports/operational` no tiene ningún caller en el frontend — endpoint de API interna sin UI dedicada.

**Verificación en vivo (contra el servidor de desarrollo real, antes y después)**:
| Ruta | Identidad | Antes | Después |
|---|---|---|---|
| `/revenue/summary` | `worker-portal@titan.dev` | 200 + datos financieros reales | 403 |
| `/revenue/summary` | `sales@titan.dev` (interno) | 200 | 200 (sin cambio) |
| `/revenue/summary` | `client-admin@titan.dev` | 200 + datos financieros reales | 403 |
| `/dashboard/audit-log` | `worker-portal@titan.dev` | 200 + AuditLog real | 403 |
| `/dashboard/summary` | `admin@titan.dev` (interno) | 200 | 200 (sin cambio) |
| `/reports/operational` | `candidate-portal@titan.dev` | 403 |
| `/dashboard/notifications` | `worker-portal@titan.dev` | 200 (vacío, ya seguro) | 403 |

**Verificación automatizada**:
1. `npm test` (backend) → 0 fail.
2. `npm run typecheck` / `npm run lint` (backend) → limpios.
3. e2e dirigido (`portal-flows.spec.ts`, `dashboard.spec.ts`, `dashboard-roles.spec.ts`, `portal-tenancy.spec.ts`) → 22/22 pass, incluyendo los 6 tests de `dashboard-roles.spec.ts` que ejercitan el Dashboard interno con 5 roles distintos (CEO/Recruiter/Operations/Compliance/Accounting) — ninguno perdió acceso.
4. e2e completo (10 specs) → 48/55 pass, 1 fail (pre-existente, `job-order-matching.spec.ts`, no relacionado), 6 skipped en cascada del mismo fallo pre-existente — mejora neta sobre el baseline (que tenía 2 fallas).
5. Repetido contra la base de datos aislada de Stage 3 (`curl` directo) — mismo comportamiento exacto: 403 para 3 identidades de portal, 200 para `sales@titan.dev`.

---

## Commit `98a8d12` — fix: repair portal e2e test flakiness in TimeEntry date generator

**Corrige**: F-01 (P2).

**Archivo**: `apps/web/e2e/portal-flows.spec.ts`.

**Verificación**: el test se ejecutó 3 veces en esta sesión tras el fix (dentro del run dirigido de 4 specs, y dos veces dentro del run completo de 10 specs) sin fallar ninguna vez.

---

## Commit `a76ca35` — chore: reformat Assignment/ScheduleChangeRequest schema block

**Corrige**: F-02 (P4).

**Archivo**: `packages/db/prisma/schema.prisma`.

**Verificación**: `prisma validate` limpio; `prisma migrate status` sin cambios (el formato del `.prisma` no genera ninguna migración nueva); suite completa sin regresión.

---

## Hallazgos sin corrección de código

- **F-03**: pérdida de datos históricos de `AgentTask`/`Activity` de F10.6 — irreversible, sin backup disponible. Documentado con su alcance real completo por primera vez (ver findings). No bloquea F11: los modelos de negocio (Tenant/User/Company/Candidate/Worker/JobOrder/Assignment/Placement/TimeEntry/Invoice/etc.) están 100% intactos desde entonces.
- **F-04**: 4 filas de `Lead` de higiene de tests — aceptado bajo el precedente ya establecido en F10.11 para `ClientJobRequest`/`TimeEntry`, ningún cambio de código necesario.

## Disciplina de commits

Cada uno de los 4 commits de este stage aborda exactamente un hallazgo o un grupo de hallazgos estrechamente relacionados (F-06/F-07/F-08 comparten el mismo mecanismo de corrección — `requireInternalIdentity()` — y se verificaron juntos porque tocan las mismas 3 rutas de router y el mismo archivo de e2e). Ningún commit introduce funcionalidad nueva; todos son correcciones sobre código y tests ya existentes de F0-F10.
