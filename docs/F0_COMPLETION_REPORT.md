# F0 — Reporte de Cierre (Fundaciones)

**Estado:** ✅ Aprobado por el Product Owner (2026-07-09).
**Duración:** 1 sesión de ejecución continua, tras CHECKPOINT 0 (3 bloqueantes resueltos, ver `DECISION_LOG.md` y `PROPUESTAS.md`).

---

## 1. Qué se construyó

Monorepo pnpm completo, funcional de punta a punta contra una base de datos real, con las 9 páginas del F0_PROMPT sirviendo datos reales del seed.

```
ai-staffing-os/
├── apps/
│   ├── api/     Express 4 + TypeScript + Prisma — 8 módulos de solo lectura
│   └── web/     React 18 + Vite 5 + Tailwind + TanStack Query — 9 páginas
├── packages/
│   ├── db/      schema.prisma (verbatim) + cliente + seed idempotente
│   ├── shared/  40 permission keys + contratos Zod de los endpoints implementados
│   └── agents/  esqueleto de framework de agentes (interfaces, sin red)
```

**Backend (`apps/api`):**
- `core/env.ts` — validación Zod de env al arrancar.
- `core/errors.ts` — `AppError` + handler uniforme `{ error: { code, message, details } }`.
- `core/tenancy/` — `AsyncLocalStorage` + Prisma Client Extension que inyecta el filtro de tenant en 29 modelos estrictos y aplica `OR: [{tenantId}, {tenantId: null}]` en 4 modelos híbridos globales (Industry, JobCategory, DocumentType, RateBenchmark) — decisión B1 de CHECKPOINT 0.
- `core/rbac/requirePermission` — middleware de permisos leído del contexto de tenancy.
- `modules/auth` — `AuthProvider` interface + `DevBypassAuthProvider` (header `x-dev-user`), listo para enchufar Clerk en F1 sin tocar módulos de negocio.
- `modules/{crm,jobs,talent,compliance,payroll,pricing,agents}` — endpoints de lectura paginados por cursor.
- `modules/dashboard` — métricas calculadas desde la DB (no hardcodeadas), feed de auditoría, notificaciones.
- `apps/api/src/**/*.test.ts` — 9 tests con `node:test`: aislamiento de tenancy (4) + RBAC 403 (4) + health (1).

**Frontend (`apps/web`):**
- `AppShell` (Sidebar de 9 ítems + Topbar con notificaciones reales, avatar del usuario dev).
- Dark/light mode (clase `dark` en `<html>`, persistido en `localStorage`).
- Componentes UI estilo shadcn hechos a mano (Button, Card, Badge, Table, Tooltip, Skeleton — sin dependencia de Radix aún).
- 9 páginas: Dashboard, Companies, Job Orders, Candidates, Compliance, Payroll, Pricing, AgentsCenter, Settings — todas con datos reales vía TanStack Query, paginación por cursor, botón "New" deshabilitado con tooltip "F1".
- Dashboard con tarjetas de métricas + gráfico de área (recharts, 14 días) + alertas recientes + feed de auditoría.

**Base de datos:**
- `schema.prisma` copiado verbatim (36 modelos, 30 enums) — nunca modificado.
- Seed idempotente (`packages/db/prisma/seed.ts`, ~1300 líneas) con los números exactos del spec: 1 tenant, 40 permisos, 11 roles (matriz completa, incluidos los 5 roles que la Arquitectura no cubría — ver PROPUESTAS P0-1), 11 usuarios, 4 industrias, 5 categorías, 8 tipos de documento, 8 empresas, 40 candidatos, 10 workers, 36 documentos, 6 compliance alerts, 6 job orders, 2 proyectos + 8 asignaciones + 80 time entries, 3 labor burden configs, 10 rate benchmarks, 3 pricing scenarios, 10 agent definitions + 3 instances, 20 audit logs, 5 notifications.

---

## 2. Comandos de setup

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Verificación rápida:
```bash
curl -s http://localhost:4000/api/v1/health
curl -s -H "x-dev-user: sales@titan.dev" http://localhost:4000/api/v1/candidates   # → 403
pnpm test   # tenancy + RBAC
```

## 3. Puertos

| Servicio | Puerto | Nota |
|---|---|---|
| API | `4000` | `http://localhost:4000/api/v1` |
| Web | `5173` | Vite dev server |
| Postgres (host) | `5433` | **No 5432** — este entorno ya tenía un Postgres de Homebrew en 5432; se remapeó el contenedor para no tocar ese servicio (ver `docker-compose.yml`) |

---

## 4. Bugs reales encontrados y corregidos (verificación en entorno real)

Ninguno de estos apareció en `typecheck`/`lint` — todos salieron al migrar, sembrar y navegar la app de verdad, confirmando por qué el DoD exige verificación real y no solo compilación limpia.

| # | Bug | Causa raíz | Fix |
|---|---|---|---|
| 1 | Migración fallaba con "User denied access" | Conflicto de puerto: `localhost:5432` resolvía al Postgres de Homebrew, no al contenedor Docker | Remapeo a puerto host `5433` |
| 2 | Seed crasheaba en `documentType.upsert` | Prisma rechaza `null` dentro de un `WhereUniqueInput` compuesto en runtime, aunque TypeScript lo compilaba sin error | Upsert por `id` fijo en vez del índice compuesto `tenantId_key` |
| 3 | Solo 3 de 6 `ComplianceAlert` esperadas | La lógica de EXPIRED/EXPIRING estaba atada a índices de worker específicos sin verificar si ese worker tenía un documento con vencimiento aplicable | Contadores globales sobre todos los workers en vez de gating por índice |
| 4 | `/auth/me` crasheaba en cada request | Mismo problema que #2: `findUnique` con filtro envuelto en `AND` es rechazado en runtime por Prisma | La extensión de tenancy redirige `findUnique`/`findUniqueOrThrow` a `findFirst`/`findFirstOrThrow` sobre el cliente base |
| 5 | **Crash de React en las 9 páginas** | `Topbar.tsx` declaraba su propio tipo `CurrentUser` local (`role: string`) en vez de importar el contrato real de `packages/shared`, donde `role` es `{id, name}` — renderizar el objeto tiraba "Objects are not valid as a React child" | Import del tipo compartido real + `user.role.name` |

Bug #5 es el más instructivo: es exactamente el tipo de error que el patrón "contratos Zod compartidos en `packages/shared`" existe para prevenir — simplemente no se usó consistentemente en ese archivo. Vale la pena revisar el resto del frontend en F1 para confirmar que todos los componentes importan tipos de `@ai-staffing-os/shared` en vez de redeclarar interfaces locales.

## 5. Desviaciones del spec (documentadas y justificadas)

| Desviación | Justificación |
|---|---|
| Módulo `agents` agregado al backend (`apps/api/src/modules/agents/`) | Paso 1 no lo lista, pero Paso 8 exige que AgentsCenter muestre datos reales — sin él esa página no tendría fuente de datos. Solo lectura, sin OpenAI. |
| `eslint.config.js` agregado | Los scripts `lint` ya existían en el spec pero no había configuración — necesario para que el DoD ("pnpm lint sin errores") fuera real y no un script roto. |
| `node:test` como framework de tests | El spec no especifica framework para los tests de tenancy/RBAC del DoD; se usó el test runner nativo de Node para no agregar una dependencia (Jest/Vitest) que F0 no pidió. |
| Matriz RBAC completa para 11 roles | Arquitectura §4.2 solo cubre 6 de los 11 roles; se implementó la propuesta P0-1 de `PROPUESTAS.md` con criterio explícito por dominio para Operations/Marketing/HR/Accounting/Manager. |
| CI (GitHub Actions) diferido | Decisión B3 de CHECKPOINT 0, aprobada explícitamente por el PO — documentado en `PROPUESTAS.md` P0-8. |
| Build de producción diferido para `apps/api` | `pnpm dev`/`start` corren vía `tsx` directamente, sin bundling — documentado como P0-9 en `PROPUESTAS.md`, no bloquea el DoD de F0 (que solo exige `pnpm dev`). |

## 6. Capturas de verificación

Tomadas con Playwright (Chromium headless) contra el servidor real, después del fix del bug #5 — cero errores de consola, cero requests fallidos en las 9 páginas. Guardadas en `docs/screenshots/f0/`:

| Página | Archivo |
|---|---|
| Dashboard (claro) | `docs/screenshots/f0/dashboard.png` |
| Dashboard (oscuro) | `docs/screenshots/f0/dashboard-theme-toggled.png` |
| Companies | `docs/screenshots/f0/companies.png` |
| Job Orders | `docs/screenshots/f0/job-orders.png` |
| Candidates | `docs/screenshots/f0/candidates.png` |
| Compliance | `docs/screenshots/f0/compliance.png` |
| Payroll | `docs/screenshots/f0/payroll.png` |
| Pricing | `docs/screenshots/f0/pricing.png` |
| AI Agents Center | `docs/screenshots/f0/agents.png` |
| Settings | `docs/screenshots/f0/settings.png` |

## 7. Estado del Definition of Done

Los 10 ítems del DoD de `02_F0_PROMPT.md` están verificados en un entorno real (no solo compilación) — detalle completo en el mensaje de cierre de F0 de esta conversación. Resumen: setup desde cero ✅, seed idempotente ✅ (conteos exactos verificados dos veces), frontend sin errores de consola ✅, dashboard dinámico ✅ (probado modificando datos en vivo), 9 páginas navegan ✅, dark/light mode ✅, tests de tenancy + RBAC ✅ (9/9), typecheck + lint limpios ✅, sin TODOs críticos ✅.

---

## 8. Próximos riesgos (antes de empezar F1)

1. **Deuda de tipos frontend-backend**: el bug #5 muestra que nada obliga hoy a que un componente use los tipos de `packages/shared` en vez de redeclarar los suyos. No hay lint rule que lo prevenga. Riesgo bajo por sí solo, pero se multiplica con cada página nueva de F1.
2. **Sin build de producción real** (P0-9): F1 no debería ignorar esto indefinidamente si se acerca un primer deploy.
3. **`update`/`delete`/`upsert` de un solo registro no implementados en la extensión de tenancy** (lanzan error explícito a propósito): F1 es la primera fase con escritura real (Leads, Follow-ups, cambios de stage), así que este es el primer punto de diseño que hay que resolver, no evitar. Ver plan de F1.
4. **Ambigüedad Company.status vs Lead.status** (P0-4, sin resolver desde CHECKPOINT 0): F1 la vuelve central en vez de periférica — el pipeline comercial que se pide ahora depende de tener esta relación clara.
5. **Cold start de datos comerciales**: los 8 companies y 0 leads/opportunities sembrados en F0 no representan carga real de un pipeline de ventas; el seed de F1 necesita datos mucho más densos para que Sales Dashboard y Revenue Intelligence tengan algo que mostrar.
6. **RBAC crece con cada módulo nuevo**: pasar de 40 a ~52+ permission keys sin una convención de generación más automática empieza a ser tedioso de mantener a mano en el seed.

## 9. Recomendación para F1

**Priorizar Sales CRM y la base del AI Sales Agent por sobre profundizar Compliance/Payroll/Pricing.** F0 ya demostró el loop operativo completo (candidato → compliance → asignación → margen); lo que falta para que el producto sea vendible de verdad es *conseguir clientes*, no perfeccionar la operación de los que ya se tienen. El schema de F0 ya tiene `Company`, `Contact`, `Lead`, `Opportunity` y `Activity` — nunca se sembraron ni expusieron en F0 porque estaban fuera de alcance, pero están ahí, listos para ser la base de F1 sin necesidad de rediseñar desde cero. Ver `docs/F1_REVENUE_ENGINE_PLAN.md` para el detalle.
