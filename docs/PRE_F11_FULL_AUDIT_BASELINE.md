# Pre-F11 Full System Audit — Baseline

**Fecha**: 2026-07-18. **Autorización**: auditoría total F0→F10 antes de F11, sin nuevas funcionalidades, sin push, sin deploy, sin borrar datos, sin `prisma migrate reset`.

## 1. Git

- **Branch**: `main`.
- **HEAD**: `0c65af2` — "chore: F10.12 — harden and close client and worker portals".
- **Working tree**: limpio (`git status --short` sin salida).
- **Tags**: ninguno (`git tag -l` vacío).
- **Últimos 50 commits**: ver `git log --oneline -50` — cadena continua desde `4efdcbf` (F7.4) hasta `0c65af2` (F10.12), sin rebases, sin amends, un commit por subfase sin excepción (confirmado visualmente, ningún hash repetido, ningún mensaje mezclando dos fases).

## 2. Estructura del monorepo

`pnpm-workspace.yaml`: `apps/*`, `packages/*`.

- **apps/**: `api` (Express + Prisma), `web` (React + Vite), `marketing` (sitio público, F4.8 -- no auditado en profundidad esta sesión, fuera del alcance de F7-F10, ver §Stage 2 nota).
- **packages/**: `db` (schema Prisma + seed), `shared` (Zod schemas + tipos compartidos), `agents` (definiciones de agentes IA).
- **apps/api/src/modules**: 33 módulos (`activities, agents, ai-dashboard, approvals, assignments, audit, auth, billing, branding, campaigns, ceo-intelligence, compliance, crm, dashboard, discovery, followups, incidents, jobs, leads, matching, missions, notifications, operations-intelligence, opportunities, payroll, placements, portal, pricing, production-readiness, prospecting, public, recruiting-intelligence, reports, revenue, talent, workers`).
- **apps/web/src/pages**: 68 archivos `.tsx`.
- **packages/db/prisma/migrations**: 34 migraciones + `migration_lock.toml`.
- **packages/db/prisma/schema.prisma**: 57 modelos (`grep -c "^model "`).
- **Tests backend**: 88 archivos `*.test.ts`.
- **E2E**: 10 archivos `*.spec.ts` (`apps/web/e2e/`).

## 3. Documentos leídos completos

`docs/F7_FINAL_REPORT.md`, `docs/F8_FINAL_REPORT.md`, `docs/F9_FINAL_REPORT.md`, `docs/F10_FINAL_REPORT.md`, `docs/F7_TO_F10_AUTONOMOUS_EXECUTION_REPORT.md` (nota: este último es un snapshot INTERMEDIO de una sesión anterior, escrito cuando solo F7 y F8.1 estaban completos -- superado por los reportes finales de F8/F9/F10, que sí confirman las 12 subfases de cada fase completas). También: `docs/F9_PLAN.md`, `docs/F10_PLAN.md` (14 secciones, un resultado por subfase).

## 4. Baseline de tests (corrida limpia, sin otro proceso escribiendo a la DB en simultáneo)

| Suite | Total | Pass | Fail | Skip |
|---|---|---|---|---|
| Backend (`apps/api`, `npm test`) | 1283 | 1278 | 1 (`prospecting.test.ts`, no determinista -- ver Stage 2/3) | 5 |
| Typecheck backend | limpio | — | — | — |
| Lint backend | limpio | — | — | — |
| Typecheck frontend | limpio | — | — | — |
| Lint frontend | 0 errores, 5 warnings preexistentes (`react-refresh/only-export-components`, patrón ya usado en archivos que exportan constantes junto a un componente) | — | — | — |
| Build frontend | limpio (bundle único de 1.68MB, warning de tamaño de chunk ya preexistente) | — | — | — |
| E2E (`apps/web`, `playwright test`, todos los specs) | 54 | 43 | **2** (ver hallazgo abajo) | 9 (cascada del `describe.configure({mode:"serial"})` de `job-order-matching.spec.ts` tras su primera falla) |

**Hallazgo de baseline (nuevo, no documentado en F10_FINAL_REPORT.md)**: `portal-flows.spec.ts` ("Time Entry: DRAFT -> SUBMITTED por el Worker", F10.11) falló en esta corrida de e2e completo -- diagnosticado como una colisión real de fecha (`Date.now() % 27` solo genera 27 valores posibles para el campo `date`, y la constraint única `(assignmentId, date)` de `TimeEntry` ya tiene 4 fechas ocupadas por corridas anteriores de este mismo test en esta sesión). Ver `docs/PRE_F11_FULL_AUDIT_FINDINGS.md` (F-01).

`job-order-matching.spec.ts` sigue fallando exactamente igual que lo documentado en F8/F9/F10 (mismo 404 espurio de `/job-orders/joborder-04/matching`, ya confirmado ajeno a cualquier código de F7-F10 en 5+ verificaciones independientes a lo largo de la sesión).

## 5. Baseline de Prisma / base de datos

- `prisma migrate status`: **"Database schema is up to date!"** (34 migraciones, todas aplicadas, `_prisma_migrations` consistente).
- `prisma validate`: **válido**.
- `prisma format --check`: reporta un archivo sin formatear -- diagnosticado como una mera desalineación de columnas en el bloque `Assignment` (el campo `scheduleChangeRequests` agregado en F10.6 no re-alineó el resto del bloque). Cero cambio semántico. Ver hallazgo F-02 (cosmético, P4).

## 6. Baseline de base de datos (conteos, DB de desarrollo compartida `ai_staffing_os`)

**Metodología**: la primera corrida de conteos coincidió con una ejecución en background de la suite completa de backend (que crea/borra fixtures de tenant/company reales dentro de sus propios tests), produciendo una lectura transitoria inflada (`Tenant=21`, `Company=24`). Repetida la lectura en quiescencia (ningún proceso de test corriendo) para obtener el baseline real:

| Modelo | Conteo |
|---|---|
| Tenant | 2 (`tenant-titan`, `tenant-acme`) |
| User | 19 |
| Company | 9 |
| Contact | 10 |
| Lead | 16 |
| Opportunity | 12 |
| Candidate | 40 |
| Worker | 10 |
| JobOrder | 6 |
| ClientJobRequest | 1 (fixture real de e2e F10.11, dejado en estado terminal REJECTED por diseño -- ver `docs/F10_PLAN.md` §13.8) |
| Placement | 0 |
| Assignment | 8 |
| TimeEntry | 84 |
| ScheduleChangeRequest | 0 |
| OperationalIncident | 0 |
| Notification | 6 |
| AuditLog | 21745 |
| AgentTask | 172 |
| Activity | 20654 |

**Hallazgo importante (nuevo, caracteriza completamente el incidente de F10.6 por primera vez)**: `docs/F10_PLAN.md` §8.1 documentó el incidente de pérdida de datos de F10.6 (uso incorrecto de `--shadow-database-url`) y su recuperación, verificando en su momento solo los modelos con seed determinista (`Candidate`, `Worker`, `Company`, `JobOrder`, etc.) -- **nunca se verificaron `AgentTask`/`Activity`/`Lead`/`Opportunity` contra su valor pre-incidente**. El reporte de F7 (`docs/F7_FINAL_REPORT.md` §"Datos") registra, ANTES del incidente: `AgentTask=1999`, `Activity=50636`, `Lead=136`, `Opportunity=53`, `Company=81`. El reporte maestro F7→F10 (fecha intermedia) registra `AgentTask=2019`, `Activity=52486`. Los valores actuales (`AgentTask=172`, `Activity=20654`, `Lead=16`, `Opportunity=12`, `Company=9`) son muchísimo más bajos -- consistente con: el wipe de F10.6 vació estas tablas por completo (no son parte del seed determinista de `prisma/seed.ts`, salvo los 12 `Lead`/12 `Opportunity`/9 `Company` que SÍ están en loops fijos del seed), y los valores actuales de `AgentTask`/`Activity`/`Lead`(+4)/`Opportunity` provienen enteramente de la re-acumulación orgánica de correr la suite de tests repetidamente desde F10.6 hasta hoy. **Esto significa que el historial real de `AgentTask`/`Activity` acumulado durante F1-F10.5 (días de trabajo autónomo simulado, ~2000 tareas de agente, ~50000 actividades) se perdió permanentemente y nunca fue recuperado** -- a diferencia de lo que el reporte de F10.6 declaró ("recuperado sin pérdida real"), que solo era cierto para los modelos de seed determinista, no para el historial operacional completo. Ver `docs/PRE_F11_FULL_AUDIT_FINDINGS.md` (F-03).

**Hallazgo menor**: `Lead` tiene 16 filas vs. 12 en el array `LEADS` de `seed.ts` -- 4 filas adicionales, consistentes con fixtures de test (`POST /api/v1/leads as sales@titan.dev succeeds`) creadas en corridas anteriores de la suite sin cleanup. Ver F-04 (P4, deuda de higiene de tests, no seguridad).

## 7. Alcance NO auditado en profundidad esta sesión (declarado explícitamente)

- `apps/marketing` -- sitio público de F4.8, sin relación con portales/tenancy/RBAC de F7-F10; fuera del alcance funcional de esta auditoría (que la propia instrucción del PO define como "desde F0/F1 hasta F10" en el sentido del backend/CRM/portales, no el marketing site estático).
- Contenido línea-por-línea de los ~2500 archivos de código del repo -- se auditó mediante lectura dirigida de los módulos de mayor riesgo (tenancy, auth, RBAC, migraciones, portales) más barridos sistemáticos por patrón (grep) sobre el resto, no una relectura manual completa de cada archivo. Documentado explícitamente para no sobre-reclamar cobertura.
