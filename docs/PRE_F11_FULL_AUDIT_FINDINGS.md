# Pre-F11 Full System Audit — Findings

Ver metodología y baseline completo en `docs/PRE_F11_FULL_AUDIT_BASELINE.md`. Commit inicial: `0c65af2`. Cada hallazgo lista su estado y, si aplica, el commit de corrección.

---

## F-05 (P0) — Cross-tenant bypass en FollowUp/Campaign/CampaignCompany/CompanyContactPoint

- **Severidad**: P0 (acceso cross-tenant real a nivel de motor de datos).
- **Fase de origen**: FollowUp existe desde F1; Campaign/CampaignCompany desde F4; CompanyContactPoint desde F4.6/F4.7. El bug (omisión en `STRICT_TENANT_MODELS`) es tan antiguo como cada modelo — nunca introducido por F7-F10, pero nunca detectado hasta esta auditoría.
- **Componente**: `apps/api/src/core/tenancy/prisma-extension.ts` (`STRICT_TENANT_MODELS`).
- **Descripción**: los cuatro modelos tienen una columna `tenantId` requerida (no nullable) en `schema.prisma` y se consultan vía `scopedDb.*` en 60+ call sites (`followups/service.ts`, `campaigns/service.ts`, `crm/service.ts`, `opportunities/service.ts`, `agents/scheduler.ts`, `agents/tools/outreach-tools.impl.ts`, `agents/tools/campaign-tools.impl.ts`, `agents/tools/sales-tools.impl.ts`, `agents/tools/ceo-tools.impl.ts`, `agents/mission-orchestrator.ts`, `production-readiness/*`) sin pasar nunca un filtro `tenantId` explícito — todos dependían silenciosamente de que la extensión de Prisma lo inyectara/exigiera, exactamente igual que cualquier otro modelo STRICT. Nunca fueron agregados al `Set`.
- **Evidencia**: lectura de `$allOperations` en `prisma-extension.ts` línea 142 (antes de la corrección): `if (!isStrict && !isHybrid) { return query(args); }` — con ninguno de los cuatro modelos en ninguno de los dos `Set`, cualquier `scopedDb.followUp.findMany()` (por ejemplo) se ejecutaba como un `prisma.followUp.findMany()` sin filtro alguno.
- **Impacto**: lectura y escritura cross-tenant total sobre estos cuatro modelos — cualquier usuario de cualquier tenant, a través de cualquier endpoint que use estos modelos, podía leer/modificar filas de otro tenant.
- **Reproducibilidad**: 100% determinista por código — no depende de datos ni de timing. Confirmado por lectura directa del código, no solo inferencia.
- **Explotación real**: **ninguna detectada**. `SELECT tenantId, count(*) FROM "FollowUp"/"Campaign"/"CampaignCompany"/"CompanyContactPoint" GROUP BY tenantId` (vía psql) mostró que solo `tenant-titan` tiene filas (`FollowUp=13`; los otros tres, 0 filas) — `tenant-acme` nunca creó datos en estas tablas, por lo que el hueco era real y crítico en diseño pero no había un segundo tenant con datos para filtrar todavía.
- **Causa raíz**: al momento de crear cada modelo (F1, F4, F4.6/4.7), se omitió agregarlo a `STRICT_TENANT_MODELS` — un paso manual, no hay ningún chequeo automático (lint/test) que garantice que todo modelo con `tenantId` requerido esté en el set.
- **Corrección propuesta y aplicada**: agregar `FollowUp`, `Campaign`, `CampaignCompany`, `CompanyContactPoint` a `STRICT_TENANT_MODELS`.
- **Efecto secundario descubierto durante la corrección**: dos call sites (`agents/company-enrichment.ts:188`, `agents/mission-orchestrator.ts:450`) usaban `findUnique({ where: { <compoundKey>: {...} } })` sobre `CompanyContactPoint`/`CampaignCompany` — la limitación ya documentada en F8 (el redirect a `findFirst` de la extensión no acepta el nombre compuesto de una `@@unique`) rompió ambos call sites (confirmado por una falla real de test: `prisma.campaignCompany.findFirst()` con `Unknown argument campaignId_companyId`). Corregidos al patrón ya establecido (`findFirst` con los campos planos), igual que `placements/service.ts`/`payroll/service.ts`.
- **Estado**: **CORREGIDO**.
- **Commit de corrección**: `9a66116` — "fix: close cross-tenant ownership gap in FollowUp/Campaign models".
- **Test de regresión**: `apps/api/src/core/tenancy/tenancy.test.ts` — dos tests nuevos: (1) `tenant-acme` ve 0 filas de `FollowUp` reales de `tenant-titan` (13 filas reales, no un tenant inexistente); (2) los tres modelos restantes exigen contexto de tenancy. Además, la suite completa (1280/1285 pass) y los e2e relevantes corrieron limpios tras la corrección, incluyendo una base de datos aislada desde cero (Stage 3).

---

## F-06 (P1) — `revenue/summary` y `revenue/intelligence` sin control de acceso real

- **Severidad**: P1 (control de acceso roto, exposición de datos financieros internos).
- **Fase de origen**: F1/F3 (revenue module), nunca revisado contra la existencia de portales hasta F10.
- **Componente**: `apps/api/src/modules/revenue/router.ts`, `apps/api/src/modules/revenue/service.ts`.
- **Descripción**: el comentario del router afirmaba "each with its own view guard", pero `revenue/service.ts` no tiene ningún chequeo de permiso u ownership (`grep "permission\|ctx\.\|getTenancyContext"` → 0 resultados). El endpoint solo usa `scopedDb` (scoping de tenant correcto), pero cualquier identidad autenticada del tenant —incluyendo las 4 identidades de portal creadas en F10— podía leerlo.
- **Evidencia**: verificado en vivo contra el servidor de desarrollo real:
  - `curl -H "x-dev-user: worker-portal@titan.dev" .../revenue/summary` → 200, con `pipelineValue` real (~$920,000.00) y desglose de companies/industries reales.
  - Repetido con `candidate-portal@titan.dev` y `client-admin@titan.dev` — mismo resultado.
- **Impacto**: un WORKER, CANDIDATE o CLIENT_ADMIN podía ver el valor total del pipeline comercial interno, ingresos estimados por oportunidad y datos de industria/estado de la cartera de companies — información que ningún rol de portal debería ver bajo ningún criterio de negocio ya establecido en F10.
- **Reproducibilidad**: 100% determinista, confirmado con 3 identidades de portal distintas.
- **Causa raíz**: el módulo predata F10 (portales no existían), y el comentario "each with its own view guard" describía una intención de diseño que nunca se implementó — nadie lo revisó cuando F10 introdujo roles de portal.
- **Corrección propuesta y aplicada**: nuevo middleware `requireInternalIdentity()` (rechaza cualquier `ctx.companyId/workerId/candidateId`), aplicado a ambas rutas. Se descartó reusar un permiso existente (`auditLogs.view` u otro) porque los roles de portal ya tienen permisos compartidos con roles internos para sus propios endpoints — un permission-check por sí solo no distingue "caller interno" de "caller de portal con una concesión no relacionada de la misma clave".
- **Estado**: **CORREGIDO**.
- **Commit de corrección**: `2afde1c` — "fix: secure unauthenticated legacy internal dashboard/revenue routes".
- **Test de regresión**: `apps/web/e2e/portal-tenancy.spec.ts` — nuevo test verifica 403 real para `worker-portal@titan.dev` contra `/revenue/summary`, `/revenue/intelligence` y `/dashboard/audit-log` en un solo test, vía `fetch()` real desde el navegador.

---

## F-07 (P1) — `dashboard/audit-log` expone el AuditLog interno completo a cualquier identidad

- **Severidad**: P1 (control de acceso roto, exposición de datos de auditoría internos — actores, acciones, entidades).
- **Fase de origen**: F1 (dashboard module). El hueco YA estaba documentado como deuda conocida/diferida en `docs/F10_PLAN.md` §11.1 y `docs/F10_FINAL_REPORT.md` §26 (decisión F10.9 de no tocarlo para no romper el widget de actividad de IA para la mayoría de roles internos) — pero nunca se había demostrado explotable con una request real hasta esta auditoría.
- **Componente**: `apps/api/src/modules/dashboard/router.ts` (`GET /audit-log`), `apps/api/src/modules/dashboard/service.ts` (`getRecentAuditLog`).
- **Descripción**: `getRecentAuditLog()` no aplica ningún filtro además del scoping de tenant (`scopedDb.auditLog.findMany({ orderBy, take })`, sin `where` de ningún tipo) — devuelve las N entradas más recientes del AuditLog completo del tenant a cualquier caller autenticado.
- **Evidencia**: verificado en vivo — `curl -H "x-dev-user: worker-portal@titan.dev" .../dashboard/audit-log` devolvió entradas reales del AuditLog interno: nombres de actores humanos (ej. "Camila Torres"), acciones internas (`candidate.matching_computed`, `candidate.shortlist_generated`), IDs de entidad reales y timestamps — datos que un WORKER (identidad de portal) nunca debería poder ver.
- **Impacto**: cualquier identidad de portal puede reconstruir actividad interna completa del tenant (quién hizo qué, cuándo, sobre qué candidato/company/job order), incluyendo trabajo de reclutamiento sobre otros clientes/candidatos.
- **Reproducibilidad**: 100% determinista, confirmado en vivo.
- **Causa raíz**: el mismo patrón que F-06 — diseño F0/F1 "visible a cualquier rol autenticado" nunca revisado tras la introducción de portales en F10. La decisión de F10.9 de "no tocarlo" fue conservadora (evitar romper el widget interno) pero, dado el mandato explícito de esta auditoría ("no dejes una falla fácil y segura de corregir como preexistente"), se resolvió correctamente esta vez: la misma técnica de F-06 (`requireInternalIdentity()`) cierra el acceso de portal sin afectar a ningún rol interno (`Dashboard.tsx`/`AIDashboard.tsx`, los únicos consumidores del frontend, solo se renderizan en el shell interno).
- **Corrección propuesta y aplicada**: `requireInternalIdentity()` aplicado a `/dashboard/audit-log`, junto con `/dashboard/summary` y `/dashboard/notifications` (endurecimiento defensivo — ver F-08).
- **Estado**: **CORREGIDO** (deuda conocida desde F10.9, resuelta en esta auditoría en vez de re-diferida).
- **Commit de corrección**: `2afde1c` (mismo commit que F-06).
- **Test de regresión**: mismo test de `portal-tenancy.spec.ts` que F-06 (cubre las tres rutas en un solo assertion).

---

## F-08 (P3) — Endurecimiento defensivo de `dashboard/summary`, `dashboard/notifications`, `reports/operational`

- **Severidad**: P3 (no explotable — confirmado en vivo que ya devolvían datos vacíos/propios para una identidad de portal — pero sin una segunda capa de defensa real).
- **Componente**: `apps/api/src/modules/dashboard/router.ts`, `apps/api/src/modules/reports/router.ts`.
- **Descripción**: `dashboard/summary` y `reports/operational` ya implementan omisión de campos a nivel de servicio (patrón F6.8/F9.11) — verificado en vivo: `curl -H "x-dev-user: worker-portal@titan.dev" .../dashboard/summary` → `{}`; `.../reports/operational` → `{"generatedAt": "..."}` solamente. `dashboard/notifications` (`getNotificationsSummary`) ya filtra por `where: { userId: ctx.userId }` — un WORKER solo ve sus propias notificaciones (revisado el código: seguro por diseño, no por casualidad de datos).
- **Impacto real actual**: ninguno confirmado — las tres rutas ya eran seguras en la práctica.
- **Riesgo residual sin corrección**: dependían enteramente de que el filtrado a nivel de campo/query estuviera correctamente implementado en cada service — un futuro cambio en `dashboard/service.ts` o `reports/service.ts` que agregue un campo nuevo sin replicar el mismo criterio de omisión rompería la protección silenciosamente, sin que ninguna prueba de ruta lo detecte.
- **Corrección propuesta y aplicada**: `requireInternalIdentity()` agregado a las tres rutas como segunda capa, igual que F-06/F-07 — no depende de que cada campo del service se filtre correctamente. `dashboard/notifications` es además código muerto desde el frontend (F10.8's `NotificationBell` lo reemplazó, confirmado por grep — ningún componente lo llama), por lo que el cambio no tiene ningún consumidor real que pueda romperse.
- **Estado**: **CORREGIDO** (endurecimiento preventivo, no una vulnerabilidad explotada).
- **Commit de corrección**: `2afde1c`.
- **Test de regresión**: cubierto indirectamente por la suite completa (1280/1285 backend) y los 22 e2e de portal — ninguna regresión de acceso legítimo interno.

---

## F-01 (P2) — Flakiness real en el test e2e de Time Entry (F10.11)

- **Severidad**: P2 (falla de test nueva, no de producto — bloquea el criterio de salida "cero fallas nuevas").
- **Fase de origen**: F10.11 (el propio test, no el feature que prueba).
- **Componente**: `apps/web/e2e/portal-flows.spec.ts`.
- **Descripción**: el generador de fecha única (`1 + (Date.now() % 27)` sobre `"2027-01-DD"`) solo tiene 27 valores posibles contra la constraint única real `(assignmentId, date)` de `TimeEntry` (F5.6). Las corridas exitosas se dejan a propósito sin limpiar (mismo criterio ya establecido para `ClientJobRequest` en F10.11: son rastro de auditoría legítimo). Tras suficientes corridas repetidas en esta sesión, los 27 valores se agotaron.
- **Evidencia**: la corrida completa de e2e del baseline (Stage 1) falló en este test con un 409 real. Consulta directa: `SELECT date FROM "TimeEntry" WHERE "assignmentId"='assignment-01' AND date >= '2027-01-01'` devolvió 4 fechas ya ocupadas de las 27 posibles.
- **Impacto**: falla intermitente de CI/e2e, sin relación con ningún bug de producto real (F10.7's Time Entry feature funciona correctamente).
- **Reproducibilidad**: determinista dado el estado acumulado de la DB (número de corridas previas ejecutadas).
- **Causa raíz**: rango de entropía insuficiente (27 valores) combinado con la decisión, correcta en sí misma, de no limpiar corridas exitosas.
- **Corrección propuesta y aplicada**: ventana de ~27 años (9862 días) desde una fecha base fija, calculada desde `Date.now()` — sigue siendo determinista-por-corrida sin depender de limpieza.
- **Estado**: **CORREGIDO**.
- **Commit de corrección**: `98a8d12` — "fix: repair portal e2e test flakiness in TimeEntry date generator".
- **Test de regresión**: el propio test, ahora ejecutado 3 veces en esta sesión (una vez en el run dirigido de 4 specs, otra en el run completo de 10 specs) sin fallar.

---

## F-02 (P4) — Desalineación cosmética de columnas en el schema de Prisma

- **Severidad**: P4 (cero impacto funcional).
- **Fase de origen**: F10.6 (se agregó `scheduleChangeRequests` a `Assignment` sin re-alinear el bloque).
- **Componente**: `packages/db/prisma/schema.prisma` (modelos `Assignment`, `ScheduleChangeRequest`).
- **Descripción**: `prisma format --check` reportaba el archivo como no formateado. `prisma format` solo re-alinea espacios en blanco entre nombre de campo/tipo/atributos — confirmado por diff que ningún campo, tipo, relación, default o constraint cambió.
- **Impacto**: ninguno — puramente estético.
- **Corrección propuesta y aplicada**: `prisma format` re-ejecutado y commiteado (revertido inicialmente durante Stage 1 por disciplina de "no tocar nada" durante el baseline, reaplicado ahora en Stage 4 con evidencia documentada).
- **Estado**: **CORREGIDO**.
- **Commit de corrección**: `a76ca35` — "chore: reformat Assignment/ScheduleChangeRequest schema block".
- **Test de regresión**: no aplica (cambio cosmético); `prisma validate` y la suite completa confirmaron cero regresión.

---

## F-03 (Documentación/Transparencia) — Alcance real del incidente de pérdida de datos de F10.6

- **Severidad**: no es un bug de código — es una corrección de transparencia sobre un reporte anterior.
- **Fase de origen**: F10.6.
- **Componente**: `docs/F10_PLAN.md` §8.1 (declaración original del incidente).
- **Descripción**: el incidente de F10.6 (uso incorrecto de `--shadow-database-url` apuntando a la base principal) fue documentado en su momento como "recuperado sin pérdida real", pero esa verificación solo cubrió los modelos con seed determinista (`Candidate`, `Worker`, `Company`, `JobOrder`, etc.). Nunca se comparó `AgentTask`/`Activity`/`Lead`/`Opportunity`/`Company` contra su valor real pre-incidente.
- **Evidencia**: `docs/F7_FINAL_REPORT.md` registra, ANTES del incidente: `AgentTask=1999, Activity=50636, Lead=136, Opportunity=53, Company=81`. El reporte intermedio F7→F10 registra `AgentTask=2019, Activity=52486`. Los valores actuales (post-incidente + reacumulación orgánica desde F10.6 hasta hoy): `AgentTask=172, Activity≈20654 (creciendo por las corridas de test/e2e de esta sesión), Lead=16, Opportunity=12, Company=9`.
- **Impacto**: pérdida real y permanente del historial operacional de F1-F10.5 (~2000 tareas de agente, ~50000 actividades) — nunca recuperable porque `prisma/seed.ts` no tiene ningún loop que reconstruya ese historial orgánico. Los modelos de seed determinista sí se recuperaron correctamente, como se declaró originalmente.
- **Causa raíz**: el reporte original de recuperación no verificó todos los modelos afectados por el wipe, solo los que el propio seed determinista podía restaurar y por lo tanto eran fáciles de verificar.
- **Corrección aplicada**: **ninguna posible a nivel de datos** (el historial no existe en ningún backup) — la corrección es exclusivamente de transparencia: esta auditoría documenta el alcance real, corrigiendo la declaración incompleta de F10.6.
- **Estado**: **DOCUMENTADO / SIN CORRECCIÓN DE DATOS POSIBLE**. No bloquea F11 (dato histórico de agentes de IA, no dato de negocio del cliente — Tenant/User/Company/Candidate/Worker/JobOrder/Assignment/etc. permanecen 100% correctos y consistentes desde entonces).
- **Commit de corrección**: N/A (documentación únicamente, ver `docs/PRE_F11_FULL_AUDIT_BASELINE.md` §6).
- **Test de regresión**: N/A.

---

## F-04 (P4) — 4 filas adicionales de `Lead` por higiene de tests

- **Severidad**: P4 (deuda de higiene de tests, no seguridad ni funcionalidad).
- **Componente**: base de datos de desarrollo compartida (`ai_staffing_os`), tests de integración de `leads`.
- **Descripción**: `Lead` tiene 16 filas vs. 12 en el array `LEADS` de `seed.ts` — 4 filas adicionales, consistentes con el test `POST /api/v1/leads as sales@titan.dev succeeds`, que crea un Lead real y no lo limpia tras el test.
- **Impacto**: ninguno funcional — mismo criterio ya aceptado explícitamente para `ClientJobRequest`/`TimeEntry` en F10.11 (registros de test reales tratados como rastro de auditoría legítimo, no como basura a limpiar).
- **Corrección propuesta**: ninguna — se documenta y se acepta bajo el mismo precedente ya establecido, no se trata como hallazgo a corregir.
- **Estado**: **ACEPTADO, SIN CAMBIO DE CÓDIGO**.
- **Commit de corrección**: N/A.
- **Test de regresión**: N/A.

---

## Resumen de severidades

| ID | Severidad | Estado | Commit |
|---|---|---|---|
| F-05 | P0 | Corregido | `9a66116` |
| F-06 | P1 | Corregido | `2afde1c` |
| F-07 | P1 | Corregido | `2afde1c` |
| F-08 | P3 | Corregido (preventivo) | `2afde1c` |
| F-01 | P2 | Corregido | `98a8d12` |
| F-02 | P4 | Corregido | `a76ca35` |
| F-03 | Documentación | Documentado, sin corrección de datos posible | N/A |
| F-04 | P4 | Aceptado, sin cambio | N/A |

No se encontraron hallazgos P0/P1 adicionales en las áreas revisadas de RBAC, CORS, contratos de API, manejo de errores, schedulers en background, o los flujos principales de comercial/reclutamiento/operaciones/portales (ver `docs/PRE_F11_FULL_AUDIT_FINAL_REPORT.md` para el detalle de cobertura por área).
