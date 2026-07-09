# F0 — Prompt de Ejecución para Claude Code
## AI Staffing OS · Fase 0: Fundaciones

Arquitectura oficial: **AI_STAFFING_OS_ARQUITECTURA_v1.1.md** (aprobada). El schema completo está en **schema.prisma** — cópialo verbatim, no lo reescribas ni lo "mejores".

---

## Reglas de trabajo (obligatorias)

1. Ejecuta los pasos EN ORDEN. Un commit por paso completado, con mensaje `F0-<paso>: <descripción>`.
2. Parches quirúrgicos: lee el estado exacto de un archivo antes de modificarlo.
3. Nada se declara "listo" sin verificarlo: servidor levantado, endpoint probado con curl, frontend abierto en navegador real.
4. No dejes código muerto, imports sin usar ni TODOs críticos.
5. No implementes NADA de fases futuras (ver "Fuera de alcance" al final).
6. Si algo del spec es imposible en tu entorno, detente y repórtalo — no improvises una alternativa silenciosa.

## Stack y versiones

- Node 20+, pnpm workspaces (sin Turborepo en F0 — scripts pnpm simples)
- TypeScript 5 estricto (`strict: true`) en todos los packages
- Backend: Express 4 + Zod + Prisma
- Frontend: React 18 + Vite 5 + TypeScript + Tailwind + shadcn/ui + TanStack Query + react-router-dom + recharts + lucide-react
- DB: PostgreSQL local (docker-compose incluido)
- SIN Redis, SIN Socket.io, SIN OpenAI, SIN Clerk real en F0 (ver Auth abajo)

---

## Paso 1 — Estructura del monorepo

```
ai-staffing-os/
├── package.json              (workspaces, scripts raíz)
├── pnpm-workspace.yaml
├── docker-compose.yml        (solo postgres:16)
├── .env.example
├── README.md                 (setup en 5 comandos)
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── app.ts
│   │       ├── core/
│   │       │   ├── env.ts          (Zod: valida env al arrancar)
│   │       │   ├── errors.ts       (AppError + handler uniforme)
│   │       │   ├── rbac/           (requirePermission middleware)
│   │       │   └── tenancy/        (context AsyncLocalStorage + Prisma extension)
│   │       └── modules/
│   │           ├── auth/           (dev-bypass, ver Paso 9)
│   │           ├── dashboard/
│   │           ├── crm/            (companies, contacts)
│   │           ├── jobs/           (job orders)
│   │           ├── talent/         (candidates, workers)
│   │           ├── compliance/     (documents, alerts)
│   │           ├── payroll/        (time entries — solo lectura en F0)
│   │           └── pricing/        (scenarios — solo lectura en F0)
│   └── web/
│       └── src/
│           ├── main.tsx / App.tsx / router.tsx
│           ├── lib/api.ts          (fetch wrapper + TanStack Query)
│           ├── components/
│           │   ├── layout/         (AppShell, Sidebar, Topbar, ThemeToggle)
│           │   └── ui/             (shadcn)
│           └── pages/
│               ├── Dashboard.tsx
│               ├── AgentsCenter.tsx
│               ├── Companies.tsx
│               ├── Candidates.tsx
│               ├── JobOrders.tsx
│               ├── Compliance.tsx
│               ├── Payroll.tsx
│               ├── Pricing.tsx
│               └── Settings.tsx
├── packages/
│   ├── db/
│   │   ├── prisma/schema.prisma    ← copiar el schema entregado VERBATIM
│   │   ├── prisma/seed.ts
│   │   └── src/index.ts            (exporta PrismaClient extendido)
│   ├── shared/
│   │   └── src/                    (tipos, Zod schemas de API, permission keys, constantes)
│   └── agents/
│       └── src/
│           ├── core/               (SOLO interfaces y stubs, ver Paso 13)
│           └── definitions/        (archivos vacíos con la interfaz, uno por agente)
```

Módulos del API: cada uno expone `router.ts` + `service.ts`. Los módulos NO importan services de otros módulos.

## Paso 2-3 — Schema Prisma

- Copiar `schema.prisma` entregado a `packages/db/prisma/schema.prisma` sin cambios.
- `pnpm db:migrate` = `prisma migrate dev`. Verificar que la migración corre limpia en el Postgres de docker-compose.
- Respetar las 5 decisiones de diseño comentadas en el header del schema. En particular: NO agregar relations a Tenant ni a User para campos de actor.

## Paso 4 — Seed data (números exactos)

Archivo `packages/db/prisma/seed.ts`, idempotente (upserts por claves naturales). Crear:

- **1 Tenant:** "Titan Staffing Group", slug `titan`, plan PRO.
- **Permisos:** generar desde `packages/shared` la lista de permission keys: `{recurso}.{view|create|update|delete}` para: companies, contacts, candidates, workers, jobOrders, documents, timeEntries, pricingScenarios + especiales: `payroll.approve`, `compliance.verify`, `compliance.block`, `agents.view`, `agents.configure`, `approvals.decide`, `settings.manage`, `users.manage`.
- **11 Roles** (los del documento §4.1) con asignaciones según la matriz §4.2. Los que no están en la matriz reciben permisos de solo lectura de su dominio.
- **11 Users**, uno por rol: `{rol}@titan.dev` (ej: `ceo@titan.dev`), nombres hispanos realistas. Sin password (auth dev-bypass).
- **4 Industries** globales: Construction, Warehouse/Logistics, Manufacturing, General Labor.
- **5 JobCategories** globales: Journeyman Electrician (Construction), Apprentice Electrician (Construction), General Labor (General Labor), Warehouse Worker (Warehouse/Logistics), Forklift Operator (Warehouse/Logistics). Con `requiredCertifications` realistas (ej. forklift → ["forklift_cert", "drug_test"]).
- **8 DocumentTypes** globales: I-9, W-4, OSHA 10, OSHA 30, Forklift Certification, Drug Test, Background Check, Electrical License (con `requiresExpiration` correcto por tipo).
- **8 Companies** en IL/IN con mezcla de status (4 CLIENT, 2 PROSPECT, 2 LEAD), cada una con 1-2 Contacts. Nombres realistas por industria (ej. "Midwest Data Center Builders", "ChiTown Logistics").
- **40 Candidates:** distribución realista entre las 5 categorías, ciudades de Chicago metro (Chicago, Palatine, Cicero, Aurora, Elgin, Gary IN), 60% bilingües es/en, status variados (15 NEW, 10 SCREENING, 8 QUALIFIED, 7 PLACED), algunos con aiScore/aiSummary simulados.
- **10 Workers** (de los 7 PLACED + 3 QUALIFIED): pay rates $17–$38 según categoría, 7 COMPLIANT / 2 PENDING / 1 BLOCKED.
- **Documents:** para cada worker, sus documentos requeridos con status variados; incluir 2 EXPIRED y 3 que vencen en <30 días → generar sus **ComplianceAlerts** correspondientes.
- **6 JobOrders:** variedad de categorías/turnos/urgencia, 2 OPEN, 2 PARTIALLY_FILLED, 1 FILLED, 1 CLOSED. Bill/pay rates coherentes (markup 45–65%).
- **2 Projects** + **8 Assignments** activas con rates snapshot, y **TimeEntries** de las últimas 2 semanas (8h regulares L-V, algo de OT) para que el dashboard tenga datos de horas y margen.
- **LaborBurdenConfig:** IL e IN, default + uno específico para General Labor construction (workersComp más alto, ej. 12.5% vs 4.5% warehouse).
- **RateBenchmarks:** para las 5 categorías en IL e IN, source MANUAL, percentiles realistas de mercado 2026 (ej. General Labor Chicago: P25 $16.50 / P50 $18.50 / P75 $21).
- **3 PricingScenarios:** incluir el ejemplo canónico del documento (50 General Labor, Chicago, turno nocturno: pay $18–21, bill $26–32, margen bruto $8–11/h, riesgo MEDIUM) con rationale escrito.
- **10 AgentDefinitions** (keys: recruiter, compliance, assistant, pricing, sales, operations, payroll, marketing, ceo, admin) con nombre/descripción, systemPromptTemplate vacío. **3 AgentInstances** activas para el tenant (recruiter, compliance, assistant) en ASSISTED, con metrics simuladas `{ tasksCompleted: 0 }`.
- **AuditLog:** 20 entradas simuladas de actividad reciente. **Notifications:** 5 para el usuario admin.

## Pasos 5-7 — Backend y Frontend base

Backend:
- `GET /api/v1/health` → `{ status: "ok", db: true }` (hace un `SELECT 1`).
- Error handler uniforme `{ error: { code, message, details? } }`.
- Validación Zod de env: `DATABASE_URL`, `PORT`, `AUTH_MODE`.

Frontend:
- Vite + Tailwind + shadcn/ui inicializados. Dark/light mode con toggle (persistir en cookie o estado — NO localStorage si algún componente se prueba como artifact; en la app local localStorage está bien).
- Tokens: tipografía Inter, acento violeta/azul eléctrico, estética Linear/Vercel (denso, limpio, sin bordes pesados).

## Paso 8 — Layout SaaS + páginas

- AppShell con Sidebar (los 9 items + Settings), Topbar (búsqueda placeholder, campana de notificaciones con badge real desde la DB, avatar del usuario dev).
- Cada página lista datos REALES de la API con tabla shadcn (columnas clave, badge de status con color semántico, paginación simple). Sin CRUD de escritura todavía — solo lectura + botón "New" deshabilitado con tooltip "F1".
- **AgentsCenter:** grid de tarjetas de las 3 AgentInstances (nombre, descripción, badge de autonomía, estado activo, métricas). Sin acciones.
- **Pricing:** tabla de PricingScenarios + panel de detalle con rangos, márgenes y rationale del escenario canónico.

## Paso 9 — Auth dev-bypass

- `AUTH_MODE=dev-bypass`: middleware inyecta el usuario `admin@titan.dev` (y su tenantId) en el request context. Header opcional `x-dev-user: recruiter@titan.dev` para probar otros roles.
- Dejar la interfaz `AuthProvider` lista para enchufar Clerk en F1 sin tocar los módulos. Comentario `// SECURITY: dev-bypass — reemplazar por Clerk antes de cualquier deploy` en el punto exacto.

## Paso 10 — Tenancy + RBAC

- Tenancy: AsyncLocalStorage con `{ tenantId, userId, permissions }` + Prisma Client Extension que inyecta `where: { tenantId }` en todos los modelos de negocio (lista explícita de modelos; Tenant/Permission/globals excluidos). **Test obligatorio:** un query sin contexto de tenant debe lanzar error, no devolver todo.
- RBAC: `requirePermission("candidates.view")` en cada ruta. Test: `x-dev-user: sales@titan.dev` recibe 403 en `/api/v1/candidates`.

## Paso 11 — Dashboard

`GET /api/v1/dashboard/summary` calcula desde la DB (no hardcodear): trabajadores activos, candidatos por status, job orders abiertas + fill rate, alertas de compliance sin resolver, horas de la semana, margen bruto de la semana (sum de timeEntries × (bill−pay)), revenue facturable del período. Frontend: tarjetas de métricas + gráfico recharts (horas/margen por día, últimos 14 días) + lista de alertas recientes + feed de AuditLog.

## Paso 13 — packages/agents (solo esqueleto)

Interfaces TypeScript SIN implementación con OpenAI: `LLMProvider`, `AgentTool` (con Zod schema), `ToolRegistry`, `AgentRuntime` (método `run()` que lanza `NotImplementedError("F3")`), `AgentContext`. Cero dependencias de red. Un archivo por agente en `definitions/` exportando `{ key, name, tools: [] }`.

---

## Fuera de alcance en F0 (no tocar)

OpenAI/LLMs · Clerk real · Redis/BullMQ · Socket.io · Orchestrator/DomainEvent workers · CRUD de escritura en UI · Payroll runs · Invoices UI · S3/uploads reales (resumeUrl/fileUrl son strings simulados) · emails · multi-tenant UI · command palette ⌘K.

## Definition of Done (verificar TODO antes de reportar)

- [ ] `docker compose up -d` + `pnpm install` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev` funcionan desde cero siguiendo solo el README.
- [ ] `curl localhost:PORT/api/v1/health` responde ok con db:true.
- [ ] Seed idempotente: correrlo dos veces no duplica datos.
- [ ] Frontend abre sin errores en consola del navegador (verificado en navegador real).
- [ ] Dashboard muestra métricas calculadas desde la DB (cambiar un dato en la DB cambia el dashboard).
- [ ] Las 9 páginas navegan y muestran datos del seed.
- [ ] Dark/light mode funciona en todas las páginas.
- [ ] Test de tenancy y test de RBAC (403) pasan.
- [ ] `pnpm typecheck` y `pnpm lint` sin errores en todo el monorepo.
- [ ] Sin código muerto ni TODOs críticos (`grep -r "TODO" --include="*.ts"` revisado).

Al terminar, reporta: comandos exactos de setup, puertos, capturas del estado de cada checklist item, y cualquier desviación del spec con su justificación.
