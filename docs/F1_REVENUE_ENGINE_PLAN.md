# F1 — Revenue Engine (Sales CRM) — Propuesta Técnica

**Estado:** F1 completada y verificada.
**Precedente:** F0 aprobado (`docs/F0_COMPLETION_REPORT.md`). Este plan no rompe nada de F0 — todos los cambios son aditivos.

---

## 1. Objetivo de F1

Convertir AI Staffing OS en un **Revenue Engine**: el foco deja de ser la operación (reclutamiento/compliance/payroll) y pasa a ser **conseguir clientes**. F0 ya demostró el loop operativo completo; lo que falta para que el producto sea vendible de verdad es un CRM comercial sólido, sin IA real todavía — la IA (Sales Agent) llega en F2 sobre una base ya funcional manejada por humanos.

Dato clave que cambia el punto de partida de este plan: **el schema de F0 ya tiene `Company`, `Contact`, `Lead`, `Opportunity` y `Activity`**. Estaban en el schema desde el diseño original (Arquitectura §2.2) pero F0 los dejó fuera de alcance deliberadamente (sin seed, sin escritura, sin UI de pipeline). F1 no parte de cero: activa y completa lo que ya existe, y agrega solo lo que falta (`FollowUp`, algunos campos nuevos).

---

## 2. Cambios necesarios en base de datos

**Regla seguida:** ningún campo ni modelo de F0 se modifica ni se elimina. Todo lo de abajo es aditivo (nuevos campos nullable, un modelo nuevo, nuevos enums). `tenantId` en todos los modelos nuevos, siguiendo la decisión #1 del header del schema (String indexado, sin `@relation` a Tenant).

### 2.1 Company — campos nuevos

| Campo | Tipo | Nota |
|---|---|---|
| `city` | `String?` | Se promueve de `address` (Json) a columna real — necesario para agrupar "clientes por estado" en Revenue Intelligence sin parsear JSON en cada query |
| `state` | `String?` | Idem. `address` (Json) se mantiene para calle/zip; no se elimina |
| `estimatedSize` | `CompanySize?` (nuevo enum: `MICRO\|SMALL\|MEDIUM\|LARGE\|ENTERPRISE`) | Banda de tamaño, no headcount exacto — más útil para segmentar que un número suelto |
| `possibleCategories` | `JobCategory[]` (m2m implícita) | "Necesidades posibles" — reutiliza el vocabulario ya existente de `JobCategory` en vez de inventar una taxonomía nueva |
| `commercialScore` | `Float?` | Score comercial a nivel empresa (análogo a `Lead.aiScore`, que ya existe) |

Nuevo índice: `@@index([tenantId, state])` para las agregaciones de Revenue Intelligence.

**Deliberadamente NO se agregan** `nextAction` ni `lastContactedAt` como columnas: se calculan en el service layer (`FollowUp` pendiente más próximo / `Activity` más reciente por `entityType="company"`). Guardarlos como columna los duplicaría y desincronizaría — mismo principio que F0 aplicó a los cálculos de Pricing ("los cálculos de dinero son siempre código testeable").

`status` (LEAD/PROSPECT/CLIENT/INACTIVE) ya cubre "tipo: lead, prospect, cliente" y "status comercial" — no se agrega un campo redundante. Ver §2.4 sobre cómo se relaciona con `Lead.status`.

### 2.2 Contact — campos nuevos

| Campo | Tipo | Nota |
|---|---|---|
| `linkedinUrl` | `String?` | |
| `decisionRole` | `ContactDecisionRole?` (nuevo enum: `OWNER\|HR\|OPERATIONS_MANAGER\|PROJECT_MANAGER\|PLANT_MANAGER\|RECRUITER\|OTHER`) | Distinto de `title` (que ya existe y es texto libre) — este es el rol categorizado para targeting comercial |

### 2.3 Lead — campos nuevos

| Campo | Tipo | Nota |
|---|---|---|
| `industryId` | `String?` (FK a `Industry`) | Un lead puede existir antes de tener `Company` asociada; necesita su propia industria |
| `city` | `String?` | |
| `state` | `String?` | |
| `priority` | Reutiliza `RiskLevel` (`LOW\|MEDIUM\|HIGH`, ya existe) | Decisión de bajo impacto — reutilizar en vez de agregar un enum `LeadPriority` nuevo evita proliferación de enums casi idénticos. Se puede ampliar a un enum dedicado más adelante si `HIGH` resulta insuficiente para urgencias reales |

`source`, `status`, `ownerId` ("asignado a"), `aiScore` ("score" — el nombre se queda aunque F1 no use IA real, es solo un `Float`), `notes` ya existen, no se tocan.

### 2.4 Relación Lead ↔ Opportunity ↔ Pipeline de 8 etapas — **Decisión confirmada por el PO: Opción A**

El pipeline pedido es: `New Lead → Contacted → Interested → Meeting Scheduled → Proposal Sent → Negotiation → Won → Lost`. `Lead` y `Opportunity` se mantienen como conceptos separados (pre-calificación vs. oportunidad con $ estimado, tal como lo diseñó la Arquitectura original) — el Kanban en la UI es una vista unificada que combina ambos, no un solo modelo fusionado.

Cambios de enum concretos que esto implica:

- `LeadStatus` gana `INTERESTED` (entre `CONTACTED` y `QUALIFIED`): `NEW | CONTACTED | INTERESTED | QUALIFIED | UNQUALIFIED | CONVERTED`. `QUALIFIED` sigue siendo el estado justo antes de convertir a `Opportunity`; `INTERESTED` cubre la columna homónima del pipeline pedido.
- `OpportunityStage` se reemplaza por `MEETING_SCHEDULED | PROPOSAL_SENT | NEGOTIATION | WON | LOST` (se quita `DISCOVERY`, que pasa a ser cubierto por los estados de `Lead`; se renombra `PROPOSAL`→`PROPOSAL_SENT` para calzar con el nombre pedido).
- `Lead.status = CONVERTED` implica que existe una `Opportunity` asociada (creada vía `POST /leads/:id/convert`, §3); no hay `Opportunity` sin `Lead` de origen en el flujo estándar, aunque el endpoint `POST /opportunities` directo se deja disponible para casos donde el trato entra ya calificado (referido, RFP entrante, etc.) sin pasar por `Lead`.

**Nota sobre `OpportunityStage`:** al no ser un campo nuevo sino un enum existente que cambia sus valores, esto es la única parte de §2 que no es puramente aditiva — Prisma requiere que la migración mapee los valores viejos (`DISCOVERY`, `PROPOSAL`) a los nuevos. Como F0 nunca sembró ninguna `Opportunity` (tabla vacía en producción/dev hasta hoy), no hay filas existentes que migrar — el cambio es seguro.

### 2.5 Opportunity — campos nuevos

| Campo | Tipo | Nota |
|---|---|---|
| `categoryId` | `String?` (FK a `JobCategory`) | "Tipo de trabajadores" |
| `estimatedPayRate` | `Decimal? @db.Decimal(10,2)` | |
| `estimatedBillRate` | `Decimal? @db.Decimal(10,2)` | |

`estimatedWorkers`, `estimatedRevenue`, `probability`, `expectedCloseDate` ya existen. **`estimatedMargin` no se guarda** — se calcula en la API (`estimatedBillRate - estimatedPayRate`), mismo principio que §2.1.

### 2.6 Modelo nuevo: `FollowUp`

No existía nada parecido en el schema de F0. Sigue el mismo patrón polimórfico que `Activity` (ya probado en F0: `entityType` + `entityId` como strings, sin FK — decisión #2 del header, "referencias sin relation, validadas en services").

```prisma
enum FollowUpType {
  CALL
  EMAIL
  LINKEDIN
  MEETING
}

enum FollowUpStatus {
  PENDING
  DONE
  SNOOZED
  CANCELLED
}

model FollowUp {
  id           String         @id @default(cuid())
  tenantId     String
  entityType   String         // "company" | "lead" | "opportunity" | "contact"
  entityId     String
  type         FollowUpType
  dueDate      DateTime
  priority     RiskLevel      @default(MEDIUM)
  assignedToId String?        // User.id, sin relation (decisión #2)
  status       FollowUpStatus @default(PENDING)
  reminderAt   DateTime?
  notes        String?
  completedAt  DateTime?
  createdAt    DateTime       @default(now())
  updatedAt    DateTime       @updatedAt

  @@index([tenantId, status, dueDate])
  @@index([tenantId, entityType, entityId])
}
```

### 2.7 Sales Activity Timeline — sin cambios de schema

`Activity` ya cubre exactamente lo pedido (`type: NOTE|CALL|EMAIL|MEETING|TASK|SYSTEM`, `entityType`/`entityId` polimórfico, `performedById` para humanos, `performedByAgentId` ya listo para agentes futuros). F1 solo necesita **empezar a escribir filas ahí** — no modificar el modelo. Esto confirma que el diseño de F0 anticipó bien esta necesidad.

### 2.8 Cambio de arquitectura backend (no-schema) que F1 sí necesita

La extensión de tenancy de F0 (`apps/api/src/core/tenancy/prisma-extension.ts`) **lanza un error a propósito** para `update`/`delete`/`upsert` de un solo registro, porque Prisma rechaza filtros `AND`-envueltos en un `WhereUniqueInput` en runtime (bug real encontrado y documentado en el reporte de F0). F0 no tenía endpoints de escritura, así que nunca se ejerció ese camino.

**F1 es la primera fase que necesita escritura real** (crear leads, cambiar de stage, completar follow-ups, editar companies). Antes de construir cualquier endpoint de escritura hay que implementar el patrón *verify-then-act*: `findFirst` con el filtro de tenant para confirmar que el registro pertenece al tenant actual, y solo entonces `update`/`delete` usando el campo único puro. Esto es prerequisito técnico de F1, no una tarea opcional.

### 2.9 Resumen de migración

Una sola migración Prisma (`add_revenue_engine`) con: 3 campos nuevos en `Company` + 1 índice, 2 campos nuevos en `Contact`, 3-5 campos nuevos en `Lead` (según §2.4), 3 campos nuevos en `Opportunity`, 1 modelo nuevo (`FollowUp`), 5 enums nuevos (`CompanySize`, `ContactDecisionRole`, `FollowUpType`, `FollowUpStatus`, y el ajuste a `LeadStatus`/`OpportunityStage` de §2.4). Todos los campos nuevos son nullable u opcionales con default — la migración no requiere backfill de datos existentes de F0.

---

## 3. Nuevas rutas API

Todas bajo `/api/v1`, mismo patrón de F0 (`router.ts` + `service.ts` por módulo, Zod en entrada/salida, paginación por cursor en listados). Módulos nuevos: `sales` (companies/contacts ampliado), `leads`, `pipeline`, `opportunities`, `followups`, `revenue`.

| Método | Ruta | Nota |
|---|---|---|
| `POST` | `/companies` | Nuevo — F0 solo tenía `GET` |
| `GET` | `/companies/:id` | Detalle con contactos, oportunidades, follow-ups próximos, timeline |
| `PATCH` | `/companies/:id` | |
| `POST` | `/companies/:id/contacts` | |
| `PATCH` | `/contacts/:id` | |
| `DELETE` | `/contacts/:id` | Contact es seguro de borrar (no es registro financiero/legal) |
| `GET` | `/leads` | Filtros: status, source, priority, assignedToId, industryId |
| `POST` | `/leads` | |
| `GET` | `/leads/:id` | |
| `PATCH` | `/leads/:id` | |
| `POST` | `/leads/:id/convert` | Crea/vincula `Company` + `Opportunity`, marca `CONVERTED` |
| `GET` | `/pipeline` | Oportunidades agrupadas por stage (vista Kanban) |
| `PATCH` | `/opportunities/:id/stage` | Cambio de columna en el Kanban; escribe una `Activity` |
| `GET` | `/opportunities` | |
| `POST` | `/opportunities` | |
| `GET` | `/opportunities/:id` | |
| `PATCH` | `/opportunities/:id` | |
| `GET` | `/follow-ups` | Filtros: status, assignedToId, entityType, overdue=true |
| `GET` | `/follow-ups/upcoming` | Para el widget del dashboard |
| `POST` | `/follow-ups` | |
| `PATCH` | `/follow-ups/:id` | Completar/posponer/cancelar |
| `GET` | `/activities` | Query params `entityType`+`entityId` — timeline de una entidad |
| `POST` | `/activities` | Registro manual (llamada, email, nota, reunión) |
| `GET` | `/revenue/summary` | Sales Dashboard: leads nuevos, empresas contactadas, follow-ups pendientes, oportunidades abiertas, valor de pipeline, reuniones programadas, clientes por industria/estado |
| `GET` | `/revenue/intelligence` | Mejores industrias/estados, oportunidades más grandes, leads sin seguimiento, clientes dormidos, pipeline por valor/probabilidad |

No se toca ningún endpoint de F0 (`/candidates`, `/job-orders`, `/documents`, etc.).

---

## 4. Nuevas páginas frontend

Sidebar propuesto (siguiendo tu lista, con "Sales CRM" como **section header no clickeable** que agrupa Companies/Contacts/Leads/Pipeline/Opportunities/Follow-ups — patrón estándar de sidebar con grupos, consistente con la estética Linear/Vercel ya establecida; alternativa: página "hub" real, lo dejo a tu criterio):

```
Dashboard
Revenue                    ← nueva
── Sales CRM ──             ← header de sección, no ruta
  Companies                 ← existe, se amplía
  Contacts                  ← nueva
  Leads                     ← nueva
  Pipeline                  ← nueva (Kanban)
  Opportunities              ← nueva
  Follow-ups                ← nueva
── Operations ──
  Job Orders / Candidates / Compliance / Payroll / Pricing   ← sin cambios
AI Agents                  ← renombre del label de "AI Agents Center" (mismo componente)
Settings
```

| Página | Contenido |
|---|---|
| `Revenue.tsx` | Sales Dashboard (§1 del pedido) arriba + Revenue Intelligence (§9 del pedido) abajo, en la misma página con secciones, no dos páginas separadas — así el nav queda con un solo ítem "Revenue" como pediste |
| `Companies.tsx` (ampliada) | Filtros por industria/estado/status/score, botón "New Company" habilitado, click en fila navega a detalle |
| `CompanyDetail.tsx` (nueva, `/companies/:id`) | Tabs: Overview (campos nuevos de §2.1), Contacts, Opportunities, Follow-ups, Activity Timeline |
| `Contacts.tsx` (nueva) | Lista plana de todos los contactos del tenant, filtrable por company/decisionRole |
| `Leads.tsx` (nueva) | Lista + formulario de creación + filtros; acción "Convert to Opportunity" |
| `LeadDetail.tsx` (nueva, `/leads/:id`) | Igual patrón de tabs que Company |
| `Pipeline.tsx` (nueva) | Kanban de 8 columnas (3 de `Lead` + 5 de `Opportunity`, §2.4), tarjetas arrastrables |
| `Opportunities.tsx` (nueva) | Lista + detalle inline o modal |
| `FollowUps.tsx` (nueva) | Vista tipo bandeja: Hoy / Vencidos / Próximos, acciones rápidas (completar, posponer) |

---

## 5. Componentes UI nuevos

F0 solo construyó componentes de **solo lectura** (Button, Card, Badge, Table, Tooltip, Skeleton). F1 es la primera fase con formularios y mutaciones reales — hace falta:

- **Formularios**: `Input`, `Textarea`, `Select`, `Combobox` (para elegir industria/categoría/usuario asignado), `DatePicker` (para `dueDate`/`expectedCloseDate`).
- **Feedback de mutaciones**: `Toast`/notificación de éxito-error (no existe nada hoy — todo F0 era de solo lectura, sin necesidad de esto).
- **`Drawer`/panel lateral**: para editar un registro sin perder el contexto de la lista (patrón ya mencionado en Arquitectura §5.4 para el chat, reutilizable aquí).
- **`KanbanBoard`/`KanbanColumn`/`KanbanCard`**: para Pipeline. Requiere una librería de drag-and-drop — propongo **`@dnd-kit/core`** (liviana, accesible, es el estándar actual en React; no había ninguna dependencia de DnD en F0).
- **`Timeline`**: para el historial de Activity en los detalles de Company/Lead/Opportunity.
- **`StatCard`** genérico: generalizar el `MetricCard` que ya vive dentro de `Dashboard.tsx` en un componente compartido, para reusarlo en `Revenue.tsx` sin duplicar código.

---

## 6. Permisos RBAC necesarios

`contacts.*` ya existe en el catálogo de 40 permisos de F0 (era uno de los 8 recursos base). Hacen falta 3 recursos nuevos × 4 acciones = **12 permission keys nuevas** (`leads.view/create/update/delete`, `opportunities.view/create/update/delete`, `followUps.view/create/update/delete`) — catálogo pasa de 40 a 52.

Ajustes a la matriz de roles (`packages/db/prisma/seed.ts`):

| Rol | Cambio |
|---|---|
| CEO / Admin | Reciben los 12 permisos nuevos automáticamente (ya son `ALL_KEYS` / `ALL_KEYS - payroll.approve`) |
| Sales | Gana `leads.*`, `opportunities.*`, `followUps.*` completos, `contacts.delete` (ya tenía view/create/update), `companies.update` (ya lo tenía) |
| Marketing | Gana `leads.view`, `opportunities.view` (visibilidad, no escritura — relevante para cuando exista Marketing Agent en fases futuras) |
| Manager | Gana `leads.view`, `opportunities.view`, `followUps.view` (sigue el patrón view-only ya establecido) |
| Resto de roles | Sin cambios |

**Nota de diseño:** `companies.delete` existe en el catálogo pero **no se expone en la UI** en F1 — borrar una empresa con historial comercial es data-destructivo; la acción correcta es cambiar `status` a `INACTIVE`. El permiso se deja definido por completitud del catálogo pero ningún endpoint hace hard-delete de `Company`.

---

## 7. Flujos de usuario

1. **Lead nuevo → cliente**: un lead entra (manual en F1, vía Sales Agent en F2) → Sales lo califica y le agenda un follow-up → al calificar, se convierte en `Opportunity` (Opción A de §2.4) → se mueve por el Pipeline arrastrando la tarjeta → en `Won`, la `Company` asociada pasa a `status=CLIENT` automáticamente (o se crea si no existía).
2. **Bandeja diaria**: un usuario de Sales abre `Follow-ups`, ve sus pendientes de hoy y vencidos, completa o pospone cada uno.
3. **Preparación antes de una llamada**: abre el detalle de una `Company`, revisa el timeline de actividad y los contactos con su `decisionRole` antes de llamar.
4. **Revisión ejecutiva**: CEO abre `Revenue`, ve el valor total del pipeline por probabilidad, qué industria/estado convierte mejor, y qué leads llevan más de X días sin seguimiento.
5. **Registro manual de actividad**: después de una llamada, el usuario abre el detalle de la entidad y agrega una `Activity` tipo `CALL` con notas — queda en el timeline para cualquiera que lo revise después.

---

## 8. Cómo prepara el sistema para el AI Sales Agent (F2)

Nada de esto llama a un LLM en F1 — son solo los puntos de enchufe, siguiendo el mismo patrón de esqueleto que `packages/agents` ya usa desde F0 (`AgentRuntime.run()` lanza `NotImplementedError`).

- **Dos definitions nuevas** en `packages/agents/src/definitions/`: `market-intelligence.agent.ts` y `revenue.agent.ts` (junto al `sales.agent.ts` que F0 ya dejó como stub vacío), cada uno exportando `{ key, name, tools: [] }`.
- **Firmas de tools tipadas pero sin implementación**, como `AgentTool` con `execute()` lanzando `NotImplementedError("F2")`, cubriendo las 7 capacidades pedidas: `searchCompanies`, `detectHiringSignals`, `identifyContacts`, `createLead`, `draftOutreach`, `suggestFollowUp`, `scoreOpportunity`. Definir sus `inputSchema` (Zod) ahora obliga a pensar el contrato de datos sin comprometerse a la implementación.
- **3 `AgentDefinition` nuevas en el seed** (`market_intelligence`, `revenue`, y activar la de `sales` que F0 ya sembró pero sin usar) — el modelo `AgentDefinition`/`AgentInstance` de F0 ya es genérico, no necesita cambios de schema.
- **`Activity.performedByAgentId` y `FollowUp.assignedToId`** ya están listos para que, en F2, un agente registre actividad o se le asignen follow-ups sin migración adicional.
- Respeta la matriz de autonomía de la Arquitectura (§3.4): `createLead`/`suggestFollowUp` son candidatos a `FULL_AUTO` ("crear registros internos" ya está clasificado así); `draftOutreach` a un cliente real requiere `AUTO_WITH_APPROVAL` ("enviar emails a clientes"); nada de esto decide precios ni firma nada, así que no choca con las reglas "siempre humano" ya establecidas.

---

## 9. Riesgos

1. **Cambio de valores de `OpportunityStage`** (§2.4, ya decidido): al no ser puramente aditivo hay que aplicar la migración con cuidado — mitigado porque la tabla `Opportunity` está vacía hoy, pero conviene correr `pnpm db:migrate` contra una copia antes de la DB real por hábito.
2. **Kanban con drag-and-drop** es la interacción de frontend más compleja construida hasta ahora en el proyecto — riesgo real de UX torpe si se apura.
3. **Primera vez con formularios/mutaciones reales**: hay que resolver el patrón *verify-then-act* de tenancy (§2.8) con cuidado — es exactamente el tipo de bug (fuga cross-tenant) que un test automatizado debe cubrir antes de dar F1 por cerrado, no después.
4. **Volumen del seed**: los 8 companies / 0 leads actuales no alcanzan para que Revenue Intelligence luzca creíble en una demo — hace falta una pasada de seed mucho más densa (decenas de leads y oportunidades en distintos stages/industrias/estados), lo cual es trabajo real, no trivial.
5. **Tamaño del alcance**: 6 módulos nuevos + 1 ampliado + Revenue + preparación de agentes es más grande que los 13 pasos de F0. Vale la pena confirmar si esto se ejecuta como una sola fase o se parte en F1a (Companies/Contacts/Leads/Activity — fundamentos de datos) y F1b (Pipeline/Opportunities/Follow-ups/Revenue — la capa de flujo comercial).
6. **Deuda detectada en F0** (bug #5 del reporte de cierre): sin una regla de lint que lo prevenga, nada impide que una página nueva de F1 vuelva a declarar un tipo local en vez de importar el contrato de `packages/shared`. Recomiendo revisarlo activamente en cada PR de F1.

---

## 10. Definition of Done

> **Nota de verificación:** cada ítem de abajo fue verificado en un entorno real (navegador real vía Playwright + backend corriendo contra Postgres real en Docker + consultas directas a la base de datos para confirmar persistencia), no únicamente mediante compilación o tipos. Ver el detalle en "Resultado de la implementación" más abajo.

- [x] Migración de Prisma aplicada limpia sobre la DB de F0 sin pérdida de datos existentes
- [x] Seed ampliado con volumen realista de leads/opportunities/follow-ups en distintos estados/industrias/stages, sigue siendo idempotente
- [x] CRUD completo y verificado en navegador real: Companies (ya no solo lectura), Contacts, Leads, Opportunities, Follow-ups
- [x] Pipeline permite mover oportunidades entre columnas, el cambio persiste y genera una `Activity`
- [x] `Revenue.tsx` muestra métricas calculadas desde la DB (no hardcodeadas), verificado cambiando datos en vivo como se hizo en F0
- [x] Extensión de tenancy: patrón verify-then-act implementado; test que confirme que un `update`/`delete` no puede tocar un registro de otro tenant
- [x] RBAC: los 12 permisos nuevos aplicados y probados (ej. Sales puede crear un lead, Compliance recibe 403)
- [x] Todos los tests de F0 (tenancy + RBAC) siguen pasando sin modificarse — no regresión
- [x] `packages/agents` tiene los 2 stubs nuevos + tools tipadas sin red, `pnpm typecheck` limpio
- [x] `pnpm typecheck`, `pnpm lint` y `pnpm test` limpios en todo el monorepo
- [x] Sin código muerto ni TODOs críticos
- [x] Verificación visual en navegador real de cada página nueva, con capturas guardadas en `docs/screenshots/f1/`
- [x] Un commit por paso, ningún módulo ni página de F0 eliminado o roto

---

## Resultado de la implementación

**Fecha de finalización:** 2026-07-09
**Commit final de F1:** `25ac51f` — "F1-17: DoD verification pass complete"
**Rango de commits de la fase:** `8444fd8` (F1-1: schema) → `25ac51f` (F1-17: verificación final), 22 commits, uno por paso.

### Resumen ejecutivo de lo construido

AI Staffing OS pasó de ser un sistema operativo de staffing (F0) a incluir un **Revenue Engine** completo: CRM comercial con Leads, Pipeline visual (Kanban drag-and-drop), Opportunities con cálculo de márgenes, Follow-ups accionables, timeline de actividad polimórfico, y un dashboard de Revenue Intelligence — todo funcional sin IA real, dejando la arquitectura lista para el Sales Agent de F2.

- **Backend:** 5 módulos nuevos (`leads`, `opportunities`, `followups`, `activities`, `revenue`) + `crm` ampliado (Companies con escritura, Contacts CRUD completo). 14 módulos backend en total (9 de F0 + 5 nuevos).
- **Frontend:** 8 páginas nuevas (`CompanyDetail`, `Contacts`, `Leads`, `LeadDetail`, `Pipeline`, `Opportunities`, `FollowUps`, `Revenue`) + `Companies` ampliada. 17 páginas en total (9 de F0 + 8 nuevas). Sidebar reorganizado en secciones (Sales CRM / Operations).
- **Componentes UI nuevos:** Input, Textarea, Select, Label, Drawer, Toast, Timeline, StatCard — primera vez que la app tiene formularios y mutaciones reales (F0 era 100% de solo lectura).
- **Base de datos:** 1 migración nueva (`f1_revenue_engine`) sobre la de F0, aditiva salvo el enum `OpportunityStage` (justificado en §2.4, seguro porque la tabla estaba vacía).
- **Agentes:** groundwork para Sales/Market Intelligence/Revenue Agent (stubs tipados, cero red).

### Métricas finales

| Métrica | Valor |
|---|---|
| Tests (`pnpm test`) | 15/15 pasando (8 tenancy + 7 RBAC) |
| `pnpm typecheck` | limpio en las 5 unidades del monorepo |
| `pnpm lint` | limpio (2 warnings preexistentes de Fast Refresh, sin errores) |
| Modelos Prisma | 39 (38 de F0 + `FollowUp`) |
| Enums Prisma | 36 (32 de F0 + `CompanySize`, `ContactDecisionRole`, `FollowUpType`, `FollowUpStatus`) |
| Migraciones | 2 (`init` de F0, `f1_revenue_engine`) |
| Módulos backend | 14 (9 F0 + `leads`, `opportunities`, `followups`, `activities`, `revenue`) |
| Endpoints HTTP | 43 rutas (29 GET, 7 POST, 6 PATCH, 1 DELETE) |
| Páginas frontend | 17 (9 F0 + 8 F1) |
| Permission keys | 52 (40 de F0 + 12 de `leads`/`opportunities`/`followUps`) |
| AgentDefinition / AgentInstance | 12 / 6 (F0 tenía 10 / 3) |
| Commits de la fase | 22, uno por paso, ninguno rompe el build |
| Capturas de verificación | 18 en `docs/screenshots/f1/` |

### Bugs encontrados durante la implementación y cómo fueron corregidos

Todos se detectaron por verificación real (navegador o consultas a la DB), no por typecheck — ninguno era detectable solo con tipos:

1. **Catálogo de permisos duplicado en `seed.ts`.** El seed mantenía su propia copia de `PERMISSION_RESOURCES`/`ALL_PERMISSIONS` en vez de importar `packages/shared`, así que los 12 permission keys nuevos de F1 nunca llegaron a la base de datos — cada request a `/leads` devolvía 403 aunque el código parecía correcto. Corregido importando `ALL_PERMISSIONS` desde `@ai-staffing-os/shared` como única fuente de verdad.
2. **`findUnique` con filtro `AND` roto en runtime.** Prisma acepta en TypeScript un `WhereUniqueInput` envuelto en `AND`, pero lo rechaza en ejecución — rompía `/auth/me` en cada request tras extender la extensión de tenancy para `update`/`delete`. Corregido redirigiendo `findUnique`/`findUniqueOrThrow` a `findFirst`/`findFirstOrThrow` sobre el cliente base (mismo patrón que F0 ya había resuelto para el caso de lectura simple).
3. **Label roto para leads sin empresa.** `id.slice(-6)` truncaba `"lead-01"` desde el extremo equivocado, mostrando "Lead ead-01". Corregido con un fallback `"Lead sin empresa · ciudad · estado"`.
4. **Eje Y del gráfico de Revenue con apariencia invertida.** No era un bug de datos: `width={36}` en el `YAxis` de recharts recortaba el primer dígito de valores de 6 cifras (`380000` se veía como `80000`), dando la impresión de un eje descendente. Corregido con `tickFormatter` a formato `$Nk` y más ancho.
5. **Inconsistencia de idioma.** Los formularios nuevos (Companies, Leads, CompanyDetail) se escribieron en inglés mientras el resto de la app — incluidos sus propios encabezados de tabla — está en español. Corregido traduciendo labels, botones y toasts, manteniendo en inglés solo la convención ya establecida en F0 de los botones "New X".
6. **Companies y Contacts sin UI de edición.** El backend soportaba `PATCH` desde el primer commit del módulo, pero el frontend solo exponía creación — un gap real contra el DoD, detectado en la revisión final, no durante la construcción. Corregido agregando edición de Company (Drawer) y edición inline por fila de Contact.
7. **Test de RBAC dejaba una `Activity` huérfana.** El test que crea un lead vía `POST /leads` limpiaba el `Lead` pero no la `Activity` que `logActivity()` escribe automáticamente al crearlo — cada corrida de la suite inflaba el conteo de `Activity` en 1. Detectado corriendo el seed dos veces seguidas y notando que el conteo esperado (4) no cuadraba (5). Corregido limpiando también la `Activity` en el test.

Todos verificados con datos reales cambiados en vivo y revertidos vía SQL cuando correspondía, no solo con capturas de pantalla.

### Desviaciones aprobadas respecto al plan original

- **§2.4 (Lead/Opportunity/Pipeline):** el plan presentó dos opciones sin decidir; el PO aprobó explícitamente la Opción A (Lead y Opportunity separados) antes de tocar el schema — documentado en su propio commit (`d525c2f`) antes de iniciar la implementación.
- **`Lead.priority`:** decisión de bajo impacto resuelta unilateralmente durante la planificación (reutilizar `RiskLevel` en vez de crear `LeadPriority`) para no abrir una ronda de aprobación extra por algo reversible; documentado en §2.3.
- Ninguna otra desviación de alcance: los 6 módulos backend, 8 páginas frontend, 12 permisos y 3 agentes stub se construyeron tal como se planificaron.

### Estado final del schema

Migración `f1_revenue_engine` aplicada limpia sobre la base de datos poblada de F0 (verificado: los 40 candidates/8 companies/10 workers de F0 quedaron intactos después de migrar). Único cambio no aditivo: los valores de `OpportunityStage` se reemplazaron por completo — seguro porque `Opportunity` no tenía filas en F0. Todo lo demás (`Company`, `Contact`, `Lead` ampliados + modelo `FollowUp` nuevo) es aditivo, sin pérdida de datos.

### Estado de RBAC

52 permission keys (40 F0 + 12 F1). Sales tiene CRUD completo sobre `leads`/`opportunities`/`followUps` + `contacts.delete`; Marketing y Manager ganaron visibilidad de solo lectura sobre leads/opportunities (y follow-ups en el caso de Manager); el resto de los roles no cambió. Probado con tests automatizados (Sales crea un lead exitosamente, Compliance recibe 403 tanto en `GET` como en `POST /leads`) además de verificación manual en navegador con distintos `x-dev-user`.

### Estado del Revenue Engine

Funcional de punta a punta con datos reales del seed: 12 leads en distintos estados/prioridades/fuentes, 8 opportunities repartidas en las 5 etapas del pipeline (incluida una `WON` y una `LOST`), 10 follow-ups (vencidos, de hoy, próximos, uno completado), 4 activities con antigüedad controlada para que Revenue Intelligence muestre un cliente dormido real (Hoosier Distribution Partners, 90 días sin contacto) y leads sin seguimiento reales. El pipeline por etapa, el valor ponderado por probabilidad, y las métricas de conversión por industria/estado se calculan desde la base de datos en cada request, no están hardcodeadas — verificado cambiando el estado de un follow-up directamente en la DB y confirmando que `/revenue/summary` reflejó el cambio (9→8→9).

### Preparación dejada para F2 (Sales Agent)

- `packages/agents/src/tools/sales-tools.ts`: 7 tools tipadas con Zod (`searchCompanies`, `detectHiringSignals`, `identifyContacts`, `createLead`, `draftOutreach`, `suggestFollowUp`, `scoreOpportunity`), cada una con `execute()` lanzando `NotImplementedError("F2")` — el contrato de datos ya está pensado, la implementación no.
- 3 `AgentDefinition` activas con instancia (`sales`, `market_intelligence`, `revenue`) visibles en AI Agents Center, en autonomía `ASSISTED`, listas para que F2 les dé comportamiento real sin tocar el schema.
- `Activity.performedByAgentId` y `FollowUp.assignedToId` ya aceptan un `AgentInstance.id` sin migración adicional — cuando F2 implemente los agentes, pueden empezar a registrar actividad y recibir follow-ups asignados de inmediato.
- La matriz de autonomía de la Arquitectura (§3.4) ya está reflejada en el diseño de las tools: `createLead`/`suggestFollowUp` son candidatas a autonomía alta (crear registros internos), `draftOutreach` requiere aprobación antes de tocar a un cliente real — ninguna tool decide precios ni firma nada.
- Cero dependencias de red u OpenAI agregadas en F1; el primer `pnpm install` de F2 que agregue el SDK de OpenAI será el primer punto real de contacto con un proveedor de LLM.

---

**Siguiente fase:** F2 — AI Sales Agent, sobre la base de datos y RBAC ya construidos en F1. Pendiente de un nuevo documento de propuesta técnica antes de escribir código, siguiendo el mismo protocolo de CHECKPOINT usado en F0 y F1.
