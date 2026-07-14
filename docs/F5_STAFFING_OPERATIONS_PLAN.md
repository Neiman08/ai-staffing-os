# F5 — Staffing Operations Core — Propuesta Técnica

**Estado:** documento de planificación. **No implementar todavía.** Sin cambios de schema, sin migraciones, sin endpoints nuevos, sin tocar F0–F4.9. Esperando aprobación explícita antes de escribir una sola línea de código.
**Precedente:** `docs/MASTER_PROJECT_STATUS.md` (aprobado) — esta fase es la respuesta directa al hallazgo central de esa auditoría: el núcleo operativo de staffing nunca avanzó más allá del estado de solo lectura que F0 dejó en julio.
**Pausa vigente, reconfirmada:** F4.8B, Clerk/F4.9, Gmail/F4.7, Outreach/Campaigns/Missions, Render, sitio de marketing, diseño visual y nuevos agentes comerciales quedan fuera de alcance de este documento y de la implementación que lo siga. Nada de lo ya construido en esas áreas se toca ni se elimina.

---

## 1. Objetivo general

Hoy AI Staffing OS puede **conseguir clientes** (CRM + 9 agentes de IA reales verificados con datos reales) pero no puede **prestar el servicio de staffing** que esos clientes contratan: no se puede dar de alta un candidato real, convertirlo en trabajador, asignarlo a una vacante, verificar su compliance, aprobarle horas, pagarle, ni facturarle al cliente. Todo eso existe únicamente como datos de seed generados en F0, congelados desde entonces.

**"Operar una agencia de staffing completa" significa, en términos concretos y verificables, que un usuario humano (Recruiter/Operations/Compliance/Payroll/CEO) pueda completar de punta a punta, sin tocar la base de datos a mano, el ciclo:**

```
Candidato entra al sistema (manual o vía formulario público, ya existe)
  → se califica y convierte en Worker
    → se verifica su compliance (documentos, vencimientos)
      → se le asigna a un Job Order real de un cliente real
        → carga/aprueba sus horas semana a semana
          → esas horas entran a un Payroll Run que se aprueba
            → se factura al cliente por lo trabajado
              → el balance de esa factura se cobra
```

Ningún eslabón de esta cadena existe hoy con escritura real. F5 construye los ocho eslabones (Job Orders, Workers, Assignments, Compliance, Timesheets, Payroll, Billing, y el Matching por IA que los conecta), **reutilizando sin cambios** todo lo que F0–F4.9 ya construyeron y probaron: RBAC (los permission keys de estos recursos **ya existen** desde F0, nunca se usaron), tenancy, el patrón *verify-then-act* (F1 §2.8), `AgentTask`/`AuditLog`/`Activity`/`ApprovalRequest`, y el patrón híbrido determinista+LLM (D8) para cualquier pieza que use IA.

**Qué NO es esta fase:** no es tax engine (ver D7/P1, sigue delegado a un proveedor externo en una fase posterior), no es integración de nómina externa (Check/Gusto), no es cobro de pagos online (Stripe), no es un rediseño visual, no es un agente comercial nuevo. Es, literalmente, terminar el "Core Staffing" (F1 original) + "Compliance + Time" (F2 original) que el roadmap de 2026 nunca llegó a construir porque el proyecto pivoteó a Revenue Engine primero.

---

## 2. Auditoría de módulos

Metodología: cada fila se verificó leyendo directamente `router.ts`/`service.ts` del módulo (no solo la documentación de fase), y contra `schema.prisma` para confirmar qué modelo ya existe.

| Módulo/Entidad | Estado | Evidencia |
|---|---|---|
| **Candidates** | 🟡 Parcial (lectura + alta anónima) | `talent/service.ts` solo tiene `listCandidates`/`listIndustries`/`listJobCategories` — cero `create`/`update`. La única forma de crear un `Candidate` hoy es el formulario público `/public/apply` (F4.8), que crea el registro pero no lo integra a ningún flujo operativo interno. El botón "New Candidate" del CRM interno renderiza `<NewButton>`, que es literalmente `<Button disabled aria-disabled="true">` con tooltip **"Disponible en F1"** (`apps/web/src/components/shared/NewButton.tsx`) — cuatro fases después de que "F1" pasó a significar otra cosa, ese texto sigue siendo la verdad operativa: nunca se construyó. |
| **Workers** | 🔴 Demo (cero API) | El modelo existe en el schema desde F0 (`Worker`, con `candidateId`, `employmentType`, `defaultPayRate`, `status`, `complianceStatus`) con datos de seed. **No existe `apps/api/src/modules/workers/` en absoluto** — confirmado, `apps/api/src/app.ts` no monta ningún router de workers. No hay conversión candidate→worker en ningún endpoint. |
| **Job Orders** | 🟡 Parcial (solo lectura) | `jobs/service.ts`: solo `listJobOrders`. Mismo patrón `<NewButton>` deshabilitado ("Disponible en F1") en `JobOrders.tsx`. Sin `POST`/`PATCH`, sin el endpoint de matching (`POST /job-orders/:id/match`) que la Arquitectura original preveía en §7.2. |
| **Projects** | 🔴 Demo (cero API) | Modelo existe (`Project`, con `companyId`, `location`, `status`, `supervisorContactId`) con 2 filas de seed desde F0. Cero router, cero página frontend en cualquier fase — ni siquiera de solo lectura (señalado ya en `PROPUESTAS.md` P0-3 desde CHECKPOINT 0 de F0, nunca resuelto). |
| **Assignments** | 🔴 Demo (cero API) | Modelo existe (`Assignment`, con `workerId`/`jobOrderId`/`projectId`/rates snapshot/`status`) con 8 filas de seed. Mismo caso que Projects: cero superficie HTTP, cero UI, en ninguna fase desde F0. |
| **Shifts** | 🔴 Demo (cero API) | Modelo existe, sin ninguna referencia de código fuera del `schema.prisma` y el seed. |
| **Compliance (Documents/Alerts/DocumentTypes)** | 🟡 Parcial (solo lectura) | `compliance/service.ts`: `listDocuments`/`listComplianceAlerts`/`listDocumentTypes`. Sin `POST /documents`, sin `POST /documents/:id/verify`, sin resolución de alertas, sin upload real (`fileUrl` sigue siendo un string simulado desde F0). `Compliance.tsx` no tiene ni un botón de acción — es la única de las 5 páginas operativas de F0 que ni siquiera intentó un `<NewButton>` deshabilitado. |
| **Timesheets (TimeEntry)** | 🟡 Parcial (solo lectura) | `payroll/service.ts`: solo `listTimeEntries`. `Payroll.tsx` tiene literalmente el texto `"Horas registradas y márgenes por asignación (solo lectura en F0)"` como descripción de la página — sin actualizar en 4+ fases. Sin `POST`, sin `bulk-approve`. |
| **Payroll (PayrollRun/PayrollItem)** | 🔴 Demo (cero API) | Modelos completos en el schema desde F0 (`PayrollRun` con `status: DRAFT→PENDING_APPROVAL→APPROVED→PAID→EXPORTED`, `PayrollItem` con el desglose completo), **cero fila de seed, cero endpoint, cero UI** en cualquier fase. |
| **Billing (Invoice/InvoiceLine/Contract)** | 🔴 Demo (cero API) | Mismo caso — modelos completos desde F0, cero endpoint, cero UI, cero seed. |
| **Pricing (PricingScenario)** | 🟡 Parcial (solo lectura) | `pricing/service.ts`: solo `listPricingScenarios`. Sin creación vía UI/API — los 3 escenarios de seed son los únicos que existirán jamás hasta que se construya escritura. El "Pricing Agent" de la Arquitectura (§6.5) sigue siendo un `AgentDefinition` stub sin tools. |
| **RBAC para estos recursos** | ✅ Completo (ya listo, sin usar) | `packages/shared/src/permissions.ts` — `candidates`, `workers`, `jobOrders`, `documents`, `timeEntries`, `pricingScenarios` **ya están en `PERMISSION_RESOURCES` desde F0**, generando automáticamente `candidates.create`/`workers.update`/`jobOrders.delete`/etc. — 6 recursos × 4 acciones = 24 permission keys que existen en la base de datos y están asignados a roles en el seed, pero que **ningún endpoint verifica todavía** porque no hay endpoints de escritura que los usen. Cero trabajo de RBAC pendiente para F5. |
| **Tenancy/verify-then-act** | ✅ Completo (patrón ya probado) | El patrón que F1 §2.8 estableció para escritura segura (`findFirst` con filtro de tenant antes de `update`/`delete`) es directamente reutilizable — ya resolvió el mismo problema una vez, no hay nada nuevo que diseñar acá. |

**Conclusión de la auditoría, en una frase:** los seis modelos de negocio que definen "operar una agencia de staffing" (`Worker`, `JobOrder`, `Assignment`, `Document`/`ComplianceAlert`, `TimeEntry`, `PayrollRun`/`Invoice`) **existen completos en el schema desde el primer commit del proyecto** — el trabajo de F5 no es diseñar un modelo de datos nuevo desde cero, es construir la capa de escritura, los flujos de aprobación, y la UI que nunca se construyeron encima de un schema que ya los anticipaba correctamente.

---

## 3. Arquitectura propuesta

### 3.1 Principio rector

**No se reinventa nada del patrón ya establecido.** Cada módulo nuevo sigue exactamente la forma que F1–F4 ya probaron: `apps/api/src/modules/<módulo>/router.ts` + `service.ts`, contratos Zod compartidos en `packages/shared/src/schemas/`, paginación por cursor, `requirePermission(<resource>.<action>)` con las claves que ya existen, *verify-then-act* para cualquier `update`/`delete` de un registro puntual, `AuditLog` para cada escritura relevante, `Activity` (`entityType`/`entityId` polimórfico) para el timeline visible en cada entidad.

### 3.2 Por qué este orden y no otro (justificación de dependencias, sin asumir nada)

El orden se deriva **directamente de las foreign keys reales del schema**, no de una preferencia arbitraria:

1. **Job Orders** puede construirse primero porque sus únicas dependencias (`Company`, `JobCategory`) ya tienen CRUD/datos completos desde F1/F0. No depende de nada que F5 deba construir todavía.
2. **Candidates (edición real) + Workers** pueden construirse en paralelo a Job Orders — dependen de `Candidate`/`JobCategory` (F0) y de sí mismos, no de Job Orders. Nota importante: `Worker.candidateId` es una FK real (`@unique`) — un `Worker` no puede crearse sin que su `Candidate` exista primero, pero **no requiere que el CRUD de edición de Candidates esté terminado**, solo que el registro exista (ya ocurre vía seed o vía `/public/apply`). La conversión candidate→worker sí depende de tener un flujo de "calificación" mínimamente usable.
3. **Assignments** depende *estrictamente* de que Workers y Job Orders ya tengan escritura real — `Assignment.workerId`/`Assignment.jobOrderId` son FKs obligatorias (no nullable). No se puede construir antes que sus dos padres.
4. **Compliance (Documents/Alerts, escritura)** puede construirse en paralelo a Assignments — depende de `Candidate`/`Worker` (paso 2), no de `Assignment`.
5. **Timesheets (TimeEntry, escritura)** depende *estrictamente* de Assignments — `TimeEntry.assignmentId` es la única FK del modelo, no nullable.
6. **Payroll (PayrollRun/PayrollItem)** depende *estrictamente* de Timesheets — un `PayrollItem` se construye agregando `TimeEntry`s ya `APPROVED`. No tiene sentido antes.
7. **Billing (Invoice)** puede depender de Payroll (agregando `PayrollItem.billAmount`) **o** construirse en paralelo derivando directo de `TimeEntry × billRate` sin esperar que Payroll esté cerrado — es una decisión de diseño abierta (ver §10), no una dependencia dura de schema.
8. **AI Matching** depende de que Job Orders, Workers y Compliance ya existan con escritura real — necesita filtrar sobre compliance/disponibilidad reales para no proponer un match inválido.
9. **Dashboards operativos** se construyen incrementalmente conforme cada pieza anterior aterriza — no es un paso final aislado, es una extensión progresiva de lo que ya existe (`Dashboard.tsx`, F0).

### 3.3 Orden recomendado (resumen)

```
Bloque A (paralelo, sin dependencias entre sí):
  A1. Job Orders (CRUD + detalle)
  A2. Candidates (CRUD real + conversión a Worker)

Bloque B (depende de A2):
  B1. Workers (creación vía conversión, edición, estados)

Bloque C (depende de A1 + B1):
  C1. Assignments (el ciclo completo, §6)

Bloque D (depende de A2/B1, puede correr en paralelo a C):
  D1. Compliance — escritura (upload, verificación, alertas)

Bloque E (depende de C1):
  E1. Timesheets — escritura (carga, aprobación)

Bloque F (depende de E1):
  F1. Payroll (draft → aprobación)

Bloque G (depende de F1, o de C1 si se decide desacoplar de Payroll — ver §10):
  G1. Billing (invoices)

Bloque H (depende de A1 + B1 + D1):
  H1. AI Matching (diseño; implementación real es candidata a una fase propia, ver §11)

Bloque I (incremental, no bloqueante, corre en paralelo a todo lo anterior):
  I1. Dashboards operativos (extendiendo Dashboard.tsx existente)
```

Ver §13 para la tabla completa de dependencias entidad por entidad.

---

## 4. Job Orders — diseño de un módulo completamente operativo

### 4.1 Qué ya cubre el schema actual (sin cambios)

`JobOrder` ya modela: cliente (`companyId`), proyecto (`projectId`, opcional), industria (indirecta, vía `company.industryId` o `category.industryId`), cantidad requerida (`workersNeeded`/`workersFilled`), cargo (`categoryId` → `JobCategory`), pay rate/bill rate (`Decimal`), duración (`startDate`/`endDate`), prioridad (`urgency: RiskLevel`), estado (`status: JobOrderStatus`), ubicación (`location: Json`), notas de horario (`scheduleNotes`), y requisitos de documentos (`requirements: Json`, keys de `DocumentType`).

### 4.2 Vacíos reales frente al pedido (candidatos a cambio de schema — **no se aplican en este documento**)

| Campo pedido | Estado actual | Recomendación |
|---|---|---|
| Supervisor | `Project.supervisorContactId` existe, pero un `JobOrder` sin `Project` asociado (`projectId` es nullable) no tiene ningún supervisor referenciable | Candidato: `JobOrder.supervisorContactId String?` (sin `@relation`, mismo patrón que `ownerId`/`approvedById` — decisión #2 del header del schema). Se somete a aprobación antes de migrar. |
| Overtime | No existe un multiplicador de horas extra a nivel de `JobOrder` ni de `Assignment` — `TimeEntry.overtimeHours` registra la cantidad de horas, pero no hay una tarifa/multiplicador declarado en ningún lado | Candidato: `JobOrder.otMultiplier Decimal? @default(1.5)` (nullable con default aplicado en código, no en DB, para no forzar backfill) — o, alternativa más simple, un default global en `Tenant.settings` (mismo patrón ya usado para `aiMonthlyBudgetUsd`) con override opcional por `JobOrder`. Se somete a decisión del PO en la aprobación de este plan. |
| Documentos a nivel de Job Order | `Document` solo soporta dueño `candidateId`/`workerId` — no hay forma de adjuntar, por ejemplo, la orden de compra firmada del cliente o el acuerdo específico de ese Job Order | Ya señalado como P0-2 en `PROPUESTAS.md` desde CHECKPOINT 0 de F0, nunca resuelto. Candidato: reutilizar `Contract` (ya tiene `companyId`/`fileUrl`/`terms`) para documentos a nivel de relación comercial, y NO agregar `jobOrderId` a `Document` — evita expandir el modelo polimórfico-manual de `Document` a un tercer dueño posible. A confirmar con el PO. |

### 4.3 Endpoints propuestos (diseño, no implementación)

Mismo patrón `router.ts`+`service.ts`, permisos ya existentes (`jobOrders.view/create/update/delete`):

| Método | Ruta | Nota |
|---|---|---|
| `POST` | `/job-orders` | Crea con cliente/proyecto/categoría/tarifas/fechas ya validados por Zod (companyId y categoryId deben existir y pertenecer al tenant). |
| `PATCH` | `/job-orders/:id` | *Verify-then-act*. Cambios de `workersFilled` deben derivarse de `Assignment`s activas, no editarse a mano libremente (ver §6) — a definir si `PATCH` bloquea ese campo específico. |
| `GET` | `/job-orders/:id` | Detalle: assignments activas, compliance de los workers asignados, historial (`Activity`). |
| `POST` | `/job-orders/:id/close` | Transición a `CLOSED`, valida que no queden `Assignment`s `ACTIVE` sin resolver (o las fuerza a `COMPLETED`/`TERMINATED` explícitamente — a decidir). |
| `POST` | `/job-orders/:id/match` (ver §11) | Candidatos priorizados de Workers disponibles — nunca crea la `Assignment` por sí solo. |

### 4.4 UI propuesta

`JobOrders.tsx` gana el `<NewButton>` real (formulario: cliente, proyecto opcional, categoría, cantidad, tarifas, ubicación, turno, fechas, urgencia, notas). `JobOrderDetail.tsx` (nueva, `/job-orders/:id`): tabs Overview / Assignments / Compliance de asignados / Documentos (si se resuelve vía Contract) / Timeline.

---

## 5. Workers — diseño del módulo completo

### 5.1 Qué ya cubre el schema (sin cambios)

`Worker`: perfil (vía `candidate` 1:1 — nombre, contacto, ciudad ya viven en `Candidate`, no se duplican), documentos (`documents: Document[]`), estados (`WorkerStatus`: AVAILABLE/ASSIGNED/ON_LEAVE/TERMINATED; `ComplianceStatus`: COMPLIANT/PENDING/BLOCKED), tipo de empleo (`employmentType`: W2/1099), tarifa base (`defaultPayRate`).

### 5.2 Cómo conviven Worker y Candidate (decisión de diseño explícita)

**Un `Worker` no duplica ningún dato de `Candidate` — es su extensión operativa.** `Worker.candidateId` (`@unique`) es la relación 1:1 ya definida desde F0. Esto significa:

- **Skills/categorías:** viven en `Candidate.categories` (M:N con `JobCategory`), no se repiten en `Worker`. Un Worker "tiene" las categorías de su Candidate de origen.
- **Perfil (nombre, contacto, ciudad, idiomas):** viven en `Candidate`, `Worker` nunca los repite.
- **Experiencia:** `Candidate.yearsExperience`, sin duplicar.
- Lo que sí es exclusivo de `Worker` (porque solo aplica una vez que alguien es empleado, no candidato): `employmentType`, `defaultPayRate`, `hiredAt`, `complianceStatus`.

**Conversión candidate→worker** (`POST /candidates/:id/convert-to-worker`, previsto desde la Arquitectura original §7.2, nunca implementado): valida que el `Candidate` no tenga ya un `Worker` (constraint `@unique` lo garantiza a nivel de DB, pero el servicio debe devolver un error de negocio claro antes de intentarlo), pide `employmentType`/`defaultPayRate` como input humano explícito (la tarifa **nunca** la decide un agente de IA sin aprobación — coherente con "fijar tarifas finales... SIEMPRE humano" de la matriz de autonomía, Arquitectura §3.4), y — **resuelve aquí, no antes, la ambigüedad P0-7 de `PROPUESTAS.md`** (pendiente desde CHECKPOINT 0 de F0): al convertir, `Candidate.status` pasa a `PLACED` automáticamente en la misma transacción — es la única transición de `Candidate.status` que este módulo fuerza; el resto de las transiciones de estado del candidato (`NEW→SCREENING→QUALIFIED`) siguen siendo manuales.

### 5.3 Disponibilidad — recomendación explícita: no agregar un campo nuevo

El pedido menciona "disponibilidad" como atributo del Worker. **Recomiendo no crear un campo/modelo de calendario de disponibilidad nuevo** — sería el primer caso en todo el proyecto donde se guarda un dato que puede derivarse, violando el principio ya aplicado consistentemente desde F1 ("`nextAction`/`lastContactedAt` no se guardan, se calculan"; "`estimatedMargin` no se guarda, se calcula"). Disponibilidad real de un Worker en un rango de fechas es una consulta determinista: `WorkerStatus != ON_LEAVE/TERMINATED` **y** ninguna `Assignment` `ACTIVE`/`SCHEDULED` de ese worker se solapa con el rango solicitado. Se implementa como una función de servicio (`isWorkerAvailable(workerId, dateRange)`), no como una columna.

### 5.4 Eligibilidad

`Worker.complianceStatus` ya es el campo correcto para esto (COMPLIANT/PENDING/BLOCKED) — "elegible para trabajar" = `complianceStatus === "COMPLIANT"`. No se necesita un campo nuevo, se necesita que el módulo de Compliance (§7) realmente lo actualice quien hoy nadie actualiza.

### 5.5 Historial

Se deriva de fuentes ya existentes, sin modelo nuevo: `Activity` (`entityType: "worker"`) para eventos manuales/de agente, `Assignment[]` (historial de asignaciones con fechas/rates snapshot ya persistidos), `AuditLog` para cambios de estado/tarifa. Mismo principio que F3 aplicó a "por qué no un modelo `Message` nuevo" — reutilizar antes de inventar.

### 5.6 Endpoints propuestos

| Método | Ruta | Nota |
|---|---|---|
| `POST` | `/candidates/:id/convert-to-worker` | Ver §5.2. |
| `GET` | `/workers` | Lista con filtros (status, complianceStatus, categoría heredada del candidate). |
| `GET` | `/workers/:id` | Detalle: perfil (join a Candidate), documentos, asignaciones, alertas de compliance. |
| `PATCH` | `/workers/:id` | Cambiar `status`/`defaultPayRate`/`employmentType` — *verify-then-act*. |

### 5.7 UI propuesta

`Workers.tsx` (nueva página, primera vez que existe) + `WorkerDetail.tsx`. Botón "Convertir a Worker" en `CandidateDetail.tsx` (hoy no existe una página de detalle de candidato tampoco — se construye junto con el CRUD de §5.2, mismo patrón que `CompanyDetail.tsx` de F1).

---

## 6. Assignments — ciclo completo

### 6.1 El ciclo, mapeado contra el schema real

```
Worker (Worker.id)
  ↓  Assignment.workerId (FK obligatoria)
Job Order (Assignment.jobOrderId, FK obligatoria)
  ↓  JobOrder.companyId (FK obligatoria)
Cliente (Company)
  ↓  JobOrder.projectId (FK opcional) → Assignment.projectId (FK opcional, debe coincidir con el del Job Order si existe)
Proyecto (Project, opcional)
  ↓  Project.supervisorContactId (ya existe) — o JobOrder.supervisorContactId si se aprueba el campo de §4.2
Supervisor (Contact, sin @relation — mismo patrón que el resto del schema)
  ↓  Assignment.startDate
Inicio
  ↓  Assignment.endDate (nullable — null mientras está activa)
Fin
  ↓  Assignment.status (AssignmentStatus: SCHEDULED → ACTIVE → COMPLETED | TERMINATED)
Estado
  ↓  (ver §6.2)
Cierre
```

### 6.2 Cierre — qué falta y qué se recomienda

`AssignmentStatus` ya tiene dos estados terminales (`COMPLETED`, `TERMINATED`), suficientes para representar "cerrado". Lo que el schema **no** tiene es un motivo de cierre estructurado (¿terminó el contrato normalmente? ¿el cliente lo pidió? ¿el worker renunció? ¿se despidió por causa?) — dato valioso para reportes de rotación pero no bloqueante para operar. **Recomendación: no agregar campos nuevos en esta pasada** — se puede capturar como una nota de texto libre en la `Activity` que se genera al cerrar (`type: SYSTEM`, `body: <motivo>`), siguiendo el mismo patrón ya usado para anunciar cambios de score. Si más adelante se necesita reportar rotación por motivo de forma estructurada, se agrega un enum entonces — no ahora, sin un caso de uso concreto todavía (mismo criterio YAGNI que 00_KICKOFF.md exige explícitamente).

### 6.3 Reglas de negocio a implementar (código, no schema)

- Crear una `Assignment` **siempre** hace *verify-then-act* de compliance: si `Worker.complianceStatus !== "COMPLIANT"`, la creación se bloquea con un error de negocio explícito (no un 500) — a menos que un rol con permiso explícito decida forzarlo (a definir con el PO: ¿existe un "override" auditado, o es un bloqueo duro sin excepción?).
- Al crear una `Assignment`, `JobOrder.workersFilled` se recalcula desde el conteo real de `Assignment`s `ACTIVE`/`SCHEDULED` de ese Job Order — **nunca se edita a mano** (mismo principio "no duplicar/derivar" ya aplicado en F1 a `Company.nextAction`).
- `Assignment.payRate`/`billRate` son *snapshot* al momento de crear (ya lo dice el comentario del schema desde F0) — un cambio posterior en `JobOrder.payRate`/`billRate` **no** debe propagarse a asignaciones ya creadas.
- Asignar un trabajador a un proyecto **sigue siendo `AUTO_WITH_APPROVAL`** según la matriz de autonomía (Arquitectura §3.4) — si en el futuro un agente de IA propone una asignación (ver §11), la creación real pasa por `ApprovalRequest`, nunca automática.

### 6.4 Endpoints propuestos

| Método | Ruta | Nota |
|---|---|---|
| `POST` | `/assignments` | Valida compliance (§6.3), calcula `workersFilled`. |
| `PATCH` | `/assignments/:id` | Cambios de fecha/estado — *verify-then-act*. |
| `POST` | `/assignments/:id/close` | Transición a `COMPLETED`/`TERMINATED` + `Activity` con motivo. |
| `GET` | `/assignments` | Filtros: workerId, jobOrderId, projectId, status. |

### 6.5 UI propuesta

Sección "Assignments" dentro de `JobOrderDetail.tsx` y de `WorkerDetail.tsx` (misma asignación vista desde ambos lados, sin una página `/assignments` independiente en la primera pasada — se evalúa agregarla si el volumen lo justifica, mismo criterio que F1 usó para no crear páginas sin un caso de uso claro todavía).

---

## 7. Compliance — seguimiento operativo

### 7.1 Tipos de documento pedidos vs. el modelo `DocumentType` (data, no schema)

**Ninguno de los tipos pedidos requiere cambio de schema.** `DocumentType` ya es genérico (`key`, `name`, `category`, `requiresExpiration`, `appliesTo: Json`) — coherente con la decisión D13 del proyecto ("todo lo configurable es data, no código"). F0 sembró 8 tipos (I-9, W-4, OSHA 10, OSHA 30, Forklift Cert, Drug Test, Background Check, Electrical License). Lo que falta es **agregar filas de seed**, no columnas:

| Tipo pedido | Acción |
|---|---|
| I-9 | Ya existe. |
| E-Verify | Nuevo `DocumentType` (`key: "e_verify"`, `category: "identity"`, `requiresExpiration: false`). |
| OSHA | Ya existen OSHA 10/30. |
| SST (Salud y Seguridad en el Trabajo) | **Aclarar con el PO** si es un tipo distinto a OSHA o el nombre en español del mismo concepto — para no duplicar un `DocumentType` con el mismo significado bajo dos claves. |
| TWIC | Nuevo `DocumentType` (`key: "twic"`, `category: "certification"`, `requiresExpiration: true` — el TWIC real vence cada 5 años). |
| Drug Test | Ya existe. |
| Background Check | Ya existe. |
| Certificaciones (genérico) | Ya cubierto por `category: "certification"` — cualquier certificación nueva es una fila más, sin tocar código. |

### 7.2 Vencimientos y alertas — el schema ya alcanza

`ComplianceAlert` (`type: EXPIRING/EXPIRED/MISSING/FAILED_CHECK`, `severity`) ya es exactamente lo necesario. Lo que falta es **generarlas de verdad**, no un modelo nuevo:

- **Job diario/periódico** (mismo patrón de scheduler in-process ya construido en F3/F4, sin Redis/BullMQ — reutiliza el mecanismo, no lo reinventa): recorre `Document`s con `expirationDate` dentro de una ventana configurable (ej. 30 días, `Tenant.settings.complianceAlertWindowDays`) → crea `EXPIRING` si no existe ya una alerta sin resolver para ese documento; documentos ya vencidos sin alerta → `EXPIRED`.
- **`MISSING`:** se deriva comparando, para cada `Worker` con al menos una `Assignment` activa, los `DocumentType.key` requeridos por `JobOrder.requirements`/`JobCategory.requiredCertifications` contra los `Document`s que el worker realmente tiene — si falta uno, se genera `MISSING`.
- **`FAILED_CHECK`:** se genera manualmente cuando un humano marca un `Document.status = REJECTED` en una verificación (background check fallido, por ejemplo) — no es automático.

### 7.3 Flujo de verificación (nuevo, escritura real)

- `POST /documents` — sube (o registra la referencia de) un documento para un Candidate o Worker. **La decisión de storage real de archivos (S3 vs. Cloudflare R2) sigue pendiente desde el CHECKPOINT 0 de F0** (`DECISION_LOG.md` P2: *"decidir en F1 cuando lleguen uploads reales"* — F1 llegó y se fue sin resolverlo). F5 puede avanzar sin resolverlo todavía si `fileUrl` se acepta como una URL ya alojada externamente (ej. un link a Google Drive/Dropbox provisto por el usuario) — **postura recomendada para no bloquear F5 en una decisión de infraestructura que no le pertenece**, dejando file storage real como bloqueante explícito de una fase de infraestructura aparte, igual que Gmail/OAuth quedó documentado como bloqueante de negocio en F4.7.
- `POST /documents/:id/verify` — marca `VERIFIED`/`REJECTED`, `verifiedById` (humano) o `verifiedByAgent` (si en el futuro el Compliance Agent, hoy stub, hace la extracción — fuera de alcance de F5, ver §11).
- `POST /compliance/alerts/:id/resolve` — marca `resolvedAt`/`resolvedById`.

### 7.4 UI propuesta

`Compliance.tsx` gana acciones reales (hoy no tiene ninguna): upload de documento, botón Verificar/Rechazar por fila, botón Resolver por alerta. Badge de vencimiento próximo con color semántico (ya existe el patrón `statusVariant`/`cva` en el proyecto, se reutiliza).

---

## 8. Timesheets — diseño

### 8.1 El schema ya alcanza sin cambios

`TimeEntry` ya modela exactamente lo pedido: `regularHours`/`overtimeHours`/`doubleHours` (ya separadas — el "overtime" que pedía Job Orders en §4 se resuelve mejor acá, a nivel de horas reales trabajadas, que como un multiplicador estimado en el Job Order), `perDiem`/`bonus`, `status: PENDING→APPROVED→LOCKED`, `source: MANUAL/TIMECLOCK/IMPORT`, `approvedById`. `@@unique([assignmentId, date])` ya previene doble carga del mismo día.

### 8.2 Carga de horas

`POST /time-entries` — un `TimeEntry` por `assignmentId`+`date` (constraint ya existente lo garantiza). Input: horas regulares/extra/dobles, per diem, bono opcional. Zod valida rangos razonables (ej. 0–24 por categoría de hora, suma diaria no debe exceder 24) — validación de negocio, no de infraestructura.

### 8.3 Aprobación

`POST /time-entries/bulk-approve` (ya previsto en la Arquitectura original §7.2) — un supervisor u Operations aprueba un lote de `TimeEntry`s `PENDING` → `APPROVED`, seteando `approvedById`. Requiere `timeEntries.view` para leer, una acción de escritura protegida por un permiso a definir (¿reusar `timeEntries.update` del catálogo ya generado, o crear una acción especial `timeEntries.approve`? — recomiendo reusar `.update`, ya existe, evita expandir `SPECIAL_PERMISSION_KEYS` sin necesidad real).

### 8.4 Overtime

El cálculo de qué cuenta como "overtime" (ej. >40h/semana) puede ofrecerse como una **asistencia de UI** (el frontend sugiere cuántas horas de las cargadas deberían ir a `overtimeHours` según un umbral configurable) pero **la fuente de verdad sigue siendo el valor que el humano confirma al guardar** — mismo principio "el código nunca decide solo, asiste y explica" ya aplicado a Pricing (D8). No se automatiza el cálculo sin confirmación humana en esta primera pasada.

### 8.5 Auditoría

Cada aprobación en lote genera una fila de `AuditLog` (`action: "timeEntry.bulk_approved"`, `before`/`after` con los IDs afectados) — mismo helper (`logAuditEvent`) que F4.9 ya construyó para eventos de auth, reutilizable sin cambios para cualquier dominio.

### 8.6 UI propuesta

`Payroll.tsx` pierde el texto "(solo lectura en F0)" y gana: selector de semana, checkboxes de selección múltiple, botón "Aprobar seleccionadas". Vista por supervisor: solo las `Assignment`s bajo su `Project`/`JobOrder`.

---

## 9. Payroll — diseño (sin cálculos fiscales)

### 9.1 El schema ya alcanza, y ya excluye impuestos por diseño desde F0

`PayrollRun`/`PayrollItem` fueron diseñados en la Arquitectura original bajo la decisión D7: **"Payroll MVP sin impuestos ni tax filing; tax engine delegado a proveedor (Check/Gusto Embedded) en una fase posterior"** — la instrucción explícita del usuario de "sin implementar cálculos fiscales todavía" **no es una restricción nueva de F5, es la continuación literal de una decisión de arquitectura que ya existía desde antes de escribir la primera línea de código del proyecto.**

### 9.2 Cálculo

`draftPayrollRun(periodStart, periodEnd)`:
1. Selecciona `TimeEntry`s `APPROVED` (nunca `PENDING`) dentro del período, agrupadas por `Assignment` → `Worker`.
2. Por cada worker: `regularPay = regularHours × Assignment.payRate`; `otPay = overtimeHours × Assignment.payRate × otMultiplier` (ver el campo candidato de §4.2 — mientras no se apruebe, usar un default de 1.5 hardcodeado en el servicio de cálculo, documentado como valor provisional); `grossPay = regularPay + otPay + perDiem + bonus`.
3. `billAmount = (regularHours + overtimeHours) × Assignment.billRate` (simplificación inicial: el bill rate no necesariamente escala con OT salvo que el contrato lo especifique — **a confirmar con el PO** si el cliente paga overtime a una tarifa distinta).
4. `margin = billAmount - grossPay` (deducciones patronales de `LaborBurdenConfig` se muestran como referencia informativa del margen neto, mismo patrón ya usado por Pricing Intelligence — **no se retiene nada del pago al worker**, D7 lo prohíbe).
5. Marca cada `TimeEntry` incluida como `LOCKED` (el estado ya existe en el enum desde F0, nunca se usó) — impide que una hora ya pagada se vuelva a incluir en otro run.

### 9.3 Estados y aprobación

`DRAFT` (recién calculado, editable) → `PENDING_APPROVAL` (el creador lo envía a revisión — **separación de funciones**: quien crea el run no debería ser el único aprobador, tal como la Arquitectura §4.2 ya anotaba con el asterisco en la matriz de permisos de Payroll) → `APPROVED` (`payroll.approve`, permiso ya existente desde F0) → `PAID` (marca manual, sin integración de pago real todavía) → `EXPORTED` (genera un archivo — CSV en la primera pasada, sin PDF todavía; PDF es del dominio de Billing, §10).

### 9.4 Integración futura (solo el punto de enchufe, sin construir nada)

Se deja preparado el mismo patrón que `LLMProvider`/`MailProvider` ya establecieron: una interfaz `PayrollTaxProvider` (sin implementación) para cuando se apruebe Check/Gusto Embedded (P1 de `DECISION_LOG.md`, sigue sin decidir). F5 no llama a esa interfaz desde ningún lado — solo la declara para no tener que rediseñar el flujo de aprobación cuando llegue.

### 9.5 Endpoints propuestos

| Método | Ruta | Nota |
|---|---|---|
| `POST` | `/payroll/runs` | Crea `DRAFT` desde un rango de fechas. |
| `POST` | `/payroll/runs/:id/submit` | `DRAFT → PENDING_APPROVAL`. |
| `POST` | `/payroll/runs/:id/approve` | `payroll.approve`, valida que `approvedById !== createdById` (separación de funciones). |
| `GET` | `/payroll/runs/:id` | Detalle con `PayrollItem`s. |
| `POST` | `/payroll/runs/:id/export` | Genera CSV, marca `EXPORTED`. |

### 9.6 UI propuesta

Nueva sección dentro de `Payroll.tsx` o página `PayrollRuns.tsx` — a decidir en implementación si conviene una pestaña dentro de la página existente (Horas / Runs) en vez de una ruta nueva, mismo criterio de "extender, no fragmentar" recomendado en §12.

---

## 10. Billing — diseño

### 10.1 El schema ya alcanza para lo esencial, con un vacío real (a decidir, no a resolver ahora)

`Invoice` (`status: DRAFT/SENT/PAID/OVERDUE/VOID`, `subtotal`/`total`, `dueDate`, `pdfUrl`) + `InvoiceLine` (`description`/`quantity`/`rate`/`amount`) cubren generación y estado. **Vacío real: no existe ningún modelo de pago** — `status = PAID` es un booleano disfrazado de enum, sin fecha de pago, sin monto parcial, sin historial de pagos parciales.

**Decisión que requiere tu aprobación antes de tocar schema (no se resuelve unilateralmente en este documento):**

| Opción | Qué resuelve | Costo |
|---|---|---|
| A. Campos nuevos en `Invoice` (`paidAmount Decimal? @default(0)`, `paidAt DateTime?`) | Balance simple (`total - paidAmount`), sin historial de pagos parciales múltiples | Mínimo — 2 columnas nullable |
| B. Modelo nuevo `Payment` (`invoiceId`, `amount`, `paidAt`, `method`, `reference`) | Historial completo de pagos parciales (varias filas por invoice) | Igual de justificado que `Campaign`/`CampaignCompany` en F4 — se aplica el mismo test que ese plan usó: "¿un campo suelto puede perder historial que sí importa?" — si el cliente paga en 2 cuotas, la Opción A no lo representa bien |

**Recomendación de este documento: Opción B**, por el mismo estándar de evaluación que F4 aplicó — pero se somete a aprobación explícita, no se asume.

### 10.2 Generación

`POST /invoices` desde un rango de fechas + `companyId`: agrupa `PayrollItem.billAmount` (o `TimeEntry` directo si Billing se desacopla de Payroll, ver §3.2 punto 7) por `Assignment`/`JobOrder`, genera `InvoiceLine`s (una por worker o por job order, a decidir con el PO — probablemente una línea por worker con el desglose de horas, similar al PDF de invoice que la Arquitectura original preveía en §7.2).

### 10.3 Balance

`balance = total - sum(Payment.amount)` (Opción B) — siempre derivado, nunca una columna que se pueda desincronizar, mismo principio aplicado en todo el proyecto desde F1.

### 10.4 Endpoints propuestos

| Método | Ruta | Nota |
|---|---|---|
| `POST` | `/invoices` | Genera desde payroll/timesheets del período. |
| `PATCH` | `/invoices/:id` | Cambios de estado (`SENT`), *verify-then-act*. |
| `POST` | `/invoices/:id/payments` | Registra un pago (Opción B). |
| `GET` | `/invoices/:id` | Detalle + líneas + pagos + balance calculado. |

### 10.5 UI propuesta

Página nueva `Invoices.tsx` (o sección dentro de `Payroll.tsx`/nueva página de Billing) — lista, detalle con líneas, registro de pago, balance visible con color semántico (`OVERDUE` en rojo, etc.).

---

## 11. Matching por IA — diseño (sin implementar)

### 11.1 Principio: mismo patrón híbrido D8 que ya probaron Sales/Pricing/Discovery

**Base determinista primero, LLM solo interpreta y explica dentro de un rango — nunca decide la asignación final.** Reutiliza `AgentRuntime`/`CostTracker`/`ApprovalGate` ya construidos, sin ningún componente nuevo de infraestructura de agentes.

### 11.2 Factores deterministas (código, testeable)

| Factor | Cómo se calcula |
|---|---|
| Mejor trabajador | Coincidencia de `Candidate.categories` del worker con `JobOrder.categoryId`; `Candidate.yearsExperience` como desempate |
| Disponibilidad | La función determinista de §5.3 (`isWorkerAvailable`) — nunca un worker con conflicto de fechas entra a la lista |
| Compliance | Solo `Worker.complianceStatus === "COMPLIANT"` entra a la lista de candidatos — un worker `BLOCKED`/`PENDING` nunca aparece, sin excepción |
| Experiencia | `Candidate.yearsExperience`, ponderado |
| Distancia | Comparación simple de `Candidate.city`/`state` contra `JobOrder.location` (Json) en la primera pasada — sin geocodificación real (evita agregar una API paga de mapas sin aprobación, mismo criterio que toda integración externa del proyecto) |
| Score final | Combinación ponderada de los factores anteriores, 0–100, con pesos declarados y testeables (mismo criterio que `scoreCompany` de F2) |

### 11.3 Capa LLM (opcional, encima del score)

Redacta el `rationale` de por qué esos workers son los mejores candidatos para ese Job Order — nunca ajusta el score fuera de un margen acotado (mismo límite ±10 puntos que `scoreCompany` ya estableció como precedente).

### 11.4 Autonomía — sin excepción a la matriz ya aprobada

`POST /job-orders/:id/match` es de solo análisis (`FULL_AUTO` según Arquitectura §3.4, "leer datos, generar análisis") — devuelve una lista priorizada, **nunca crea la `Assignment`**. Crear la `Assignment` real sigue siendo `AUTO_WITH_APPROVAL`: el matching propone, un humano confirma con un clic (mismo patrón que `suggestFollowUp` de F2 estableció para la primera pieza "solo sugiere, no ejecuta" del proyecto).

### 11.5 Qué agente lo ejecuta

Candidatos naturales: **Recruiter Agent** (stub desde F0, nunca implementado) para el lado de talento, u **Operations Agent** (también stub) para el lado de asignación — a decidir en la implementación real, fuera de alcance de esta fase de planificación. No se crea un agente nuevo; se gradúa uno de los 8 stubs existentes, mismo patrón de "graduación" que Sales (F2)/Market Intelligence (F3)/Campaign-Outreach-Conversation (F4)/CEO (F4) ya siguieron.

---

## 12. Dashboards operativos

### 12.1 Riesgo a evitar (ya señalado en `MASTER_PROJECT_STATUS.md` §6.2)

El proyecto ya acumula 5 superficies tipo "dashboard" (`Dashboard.tsx`, `Revenue.tsx`, `AIDashboard.tsx`, `Missions.tsx`, `ProductionReadiness.tsx`). **Recomendación explícita: no crear 5 páginas nuevas** (una por rol pedido) — se extiende `Dashboard.tsx` (el dashboard operativo original de F0, literalmente diseñado para esto desde el principio) con secciones visibles según el permiso del usuario, no rutas separadas.

### 12.2 Diseño por rol (secciones dentro del mismo `Dashboard.tsx`, filtradas por permiso)

| Rol | Sección visible | Datos (todos calculados desde la DB, sin hardcodear) |
|---|---|---|
| **Recruiter** | Embudo de candidatos por estado, categorías con más demanda (Job Orders abiertos por categoría), time-to-fill promedio | `candidates.view` |
| **Operations** | Job Orders abiertos/parcialmente llenos, fill rate, Assignments activas próximas a vencer, timesheets pendientes de aprobación | `jobOrders.view` |
| **Compliance** | Alertas por severidad, documentos por vencer en 30 días, workers `BLOCKED` | `documents.view` |
| **Payroll** | Horas pendientes de aprobación del período actual, runs en `DRAFT`/`PENDING_APPROVAL`, margen del período | `timeEntries.view` |
| **CEO** | Todo lo anterior consolidado + el enlace ya existente a `AIDashboard.tsx`/`Revenue.tsx` — CEO no pierde nada de lo que ya tenía, gana visibilidad operativa nueva en el mismo lugar donde ya mira el negocio | acceso total |

### 12.3 Endpoint

Se extiende `GET /dashboard/summary` (F0, ya calcula desde la DB) con los campos operativos nuevos — mismo criterio ya aplicado repetidamente en el proyecto ("se extiende un endpoint existente, no se crea un dashboard nuevo" — F4 lo hizo con `ai-dashboard/summary` tres veces).

---

## 13. Dependencias

### 13.1 Tabla de dependencias por entidad (qué debe existir antes)

| Entidad/Módulo | Depende de (hard, por FK) | Depende de (workflow, no FK) | Puede empezar en paralelo con |
|---|---|---|---|
| Job Orders | Company, JobCategory (ya existen) | — | Candidates, Workers |
| Candidates (CRUD real) | Candidate (ya existe) | — | Job Orders |
| Workers | Candidate | CRUD de Candidates (para que tenga sentido de punta a punta, aunque no es un bloqueo técnico) | Job Orders |
| Assignments | Worker, JobOrder | Compliance mínimo (para el chequeo de bloqueo, §6.3) | — (bloqueado hasta que A/B cierren) |
| Compliance (escritura) | Candidate, Worker | — | Assignments |
| Timesheets | Assignment | — | Compliance |
| Payroll | TimeEntry (aprobadas) | — | — |
| Billing | PayrollItem **o** TimeEntry directo (decisión abierta, §3.2) | — | Payroll (si se desacopla) |
| AI Matching | JobOrder, Worker, Compliance | — | — (último de los operativos) |
| Dashboards | Todo lo anterior, incremental | — | Puede avanzar en paralelo agregando secciones a medida que cada pieza aterriza |

### 13.2 Qué puede hacerse en paralelo (resumen)

- **Bloque A** (Job Orders + Candidates CRUD): sin dependencia entre sí, arrancan el mismo día.
- **Compliance (escritura)** puede avanzar en paralelo a **Assignments** una vez que Workers exista — no se bloquean mutuamente.
- **Billing** puede desacoplarse de Payroll si se aprueba que derive directo de `TimeEntry` (reduce la cadena secuencial en un eslabón) — decisión a tomar antes de empezar el Bloque F/G, no después.
- **Dashboards** nunca es un bloque final aislado — cada pieza que cierra aporta su sección de inmediato.

---

## 14. Riesgos

### 14.1 Deuda técnica identificada

- **Cinco dashboards ya existentes** (ver §12.1) — riesgo de fragmentación si F5 agrega páginas nuevas en vez de extender `Dashboard.tsx`.
- **`ApprovalGate.ts` sigue sin leer `AgentInstance.autonomyLevel` en runtime** (deuda heredada de F4) — si el Matching por IA (§11) se implementa alguna vez, debe respetar la tabla estática actual, no asumir que el enforcement dinámico ya existe.

### 14.2 Modelos insuficientes (requieren decisión antes de migrar, no ahora)

- `JobOrder` sin `supervisorContactId` propio (§4.2).
- Sin multiplicador de overtime declarado en ningún lado (§4.2, §9.2) — hoy solo existiría como default hardcodeado en el servicio de cálculo hasta que se apruebe un campo/setting.
- `Document` no soporta dueño a nivel de `JobOrder` (P0-2 de `PROPUESTAS.md`, sigue sin resolver desde F0 — recomendación de este plan: resolver con `Contract`, no expandiendo `Document`).
- Sin modelo de pago (`Payment`) para Billing — decisión pendiente entre Opción A/B (§10.1).

### 14.3 Ambigüedades de negocio heredadas, sin resolver, que F5 no puede seguir evitando

- **P0-7 de `PROPUESTAS.md` (sincronización `Candidate.status`/`Worker.status`)** — este plan la resuelve parcialmente en §5.2 (conversión fuerza `PLACED`), pero el resto de las transiciones de `Candidate.status` mientras ya es Worker quedan sin regla explícita — a confirmar en la implementación.
- **P0-4 (`Company.status=LEAD` vs. modelo `Lead`)** — no es responsabilidad directa de F5, pero si el matching o el dashboard de Operations necesita filtrar "clientes con Job Orders activos", esta ambigüedad puede resurgir. Se señala, no se resuelve acá.
- **Storage real de archivos (P2 de `DECISION_LOG.md`)** — sigue sin decidir desde F0. F5 recomienda no bloquearse en esto (aceptar URLs externas por ahora), pero el bloqueante de fondo sigue vivo.

### 14.4 Duplicados

No se detectaron modelos duplicados nuevos que F5 introduciría — todo lo diseñado reutiliza modelos ya existentes. El único riesgo de duplicación es de **UI** (dashboards, §12.1), no de datos.

---

## 15. Definition of Done

*(Criterio para cuando la implementación real de F5 —una vez aprobada— se dé por terminada; este documento en sí mismo no tiene DoD porque no produce código.)*

- [x] Candidates: CRUD real completo (crear/editar) — **implementado y verificado en F5.2** (ver §17). Sin duplicar tipos frontend/backend (regla ya establecida desde el bug #5 de F0): un único `packages/shared/src/schemas/talent.ts`.
- [x] Conversión candidate→worker funcional, con `defaultPayRate`/`employmentType` provistos por un humano, nunca por un agente sin aprobación — **implementado y verificado en F5.2** (ver §17). Restringida deliberadamente a roles con `candidates.update` Y `workers.create` a la vez (hoy CEO/Admin), decisión explícita del PO como segunda validación tras el trabajo del Recruiter.
- [ ] Workers: CRUD completo, disponibilidad calculada (no almacenada), elegibilidad reflejando `complianceStatus` real. F5.2 solo entregó la superficie mínima aprobada (`GET /workers/:id` de solo lectura, sin listado/edición/filtros) — el CRUD completo queda para el bloque siguiente (§5).
- [x] Job Orders: CRUD completo + cierre — **implementado y verificado en F5.1** (ver §16). `workersFilled` sigue siendo de solo lectura en esta pasada (aún no hay `Assignment`s reales que lo recalculen — eso es Bloque C, todavía no construido); la UI ya lo muestra explícitamente como "solo lectura" para no sugerir que se edita a mano.
- [ ] Assignments: ciclo completo funcional (creación bloqueada por compliance no conforme, cierre con motivo en `Activity`, rates snapshot verificados).
- [ ] Compliance: upload/verificación real, alertas `EXPIRING`/`EXPIRED`/`MISSING` generadas automáticamente por un job periódico verificado con datos reales (no solo con código revisado).
- [ ] Timesheets: carga y aprobación en lote funcionando, `TimeEntry.status` transicionando correctamente a `LOCKED` al entrar a un payroll run.
- [ ] Payroll: `PayrollRun` completo `DRAFT→PENDING_APPROVAL→APPROVED`, separación de funciones verificada (creador ≠ aprobador) con un test automatizado, sin ningún cálculo de impuestos.
- [ ] Billing: `Invoice` generada con líneas reales, balance calculado correctamente tras registrar al menos un pago de prueba.
- [ ] Matching por IA: al menos un caso verificado end-to-end (Job Order real + Workers reales del seed) mostrando una lista priorizada con rationale, sin crear ninguna `Assignment` automáticamente.
- [ ] Dashboards: secciones nuevas visibles en `Dashboard.tsx` según rol, con datos reales (no mockeados) — verificado con al menos 2 roles distintos (`x-dev-user`).
- [ ] RBAC: los 24 permission keys ya existentes (`candidates`/`workers`/`jobOrders`/`documents`/`timeEntries`/`pricingScenarios` × 4 acciones) verificados con al menos un test de 403 por recurso.
- [ ] `pnpm typecheck`/`lint`/`test` limpios en todo el monorepo.
- [ ] F0–F4.9 intactos — ningún test existente se modifica ni se rompe.
- [ ] Verificación en navegador real (Playwright) del ciclo completo: candidato → worker → asignación → timesheet aprobado → payroll run aprobado → invoice con pago registrado.
- [ ] Cero cambios de schema aplicados sin tu aprobación explícita previa de cada uno (§4.2, §9.2, §10.1) — cada migración de F5 se presenta y se aprueba antes de correrla, mismo protocolo que F4.9 ya siguió.

---

---

## 16. F5.1 — Job Orders operativos — Resultado real (implementado, verificado, cerrado)

**Estado: completo.** Este bloque deja de ser planificación a partir de acá — documenta lo que efectivamente se construyó, no lo que se propuso en §4.

### 16.1 Cambios de schema aplicados (aprobados explícitamente antes de migrar)

- `JobOrderStatus` ganó el valor `DRAFT` (primero en el enum) — todo Job Order nuevo nace en `DRAFT`, nunca en `OPEN`.
- `JobOrder.description String?` (nuevo).
- `JobOrder.createdById String?` (nuevo, sin `@relation` — mismo patrón que `ownerId`/`approvedById`) — se resuelve siempre desde el contexto autenticado (`ctx.userId`), nunca se acepta desde el body.
- Default de `JobOrder.status` cambiado a `DRAFT`.
- **Migración partida en dos** por una limitación transaccional real de Postgres (`ALTER TYPE ... ADD VALUE` no puede usarse en la misma transacción que lo agrega — error 55P04): `20260713190000_f5_1_add_job_order_draft_status` (solo el enum) y `20260713190100_f5_1_job_order_operational_fields` (columnas + default). Ambas aplicadas con `prisma migrate deploy`, verificadas con SQL directo, sin pérdida de datos (los 6 Job Orders de seed quedaron intactos). Commit `db3af5c`.
- **No se tocó** ningún otro campo candidato de §4.2 (`supervisorContactId`, `otMultiplier`) — quedan diferidos, sin fecha, tal como se aprobó.

### 16.2 Alcance implementado

- Contratos compartidos (`packages/shared/src/schemas/jobs.ts`): `jobOrderListItemSchema`, `jobOrderQuerySchema`, `jobOrderDetailSchema`, `createJobOrderInputSchema`, `updateJobOrderInputSchema`, `updateJobOrderStatusInputSchema`, matriz de transición `JOB_ORDER_STATUS_TRANSITIONS` + `isValidJobOrderStatusTransition()`.
- Backend (`apps/api/src/modules/jobs/`): `service.ts` (list/detail/create/update/status con *verify-then-act*, validación de Company/Category contra el tenant real, `requirements` validado contra `DocumentType.key` reales — nunca texto libre) + `router.ts` (`GET/POST /job-orders`, `GET /job-orders/:id`, `PATCH /job-orders/:id`, `PATCH /job-orders/:id/status`). Sin `DELETE` (no estaba en el alcance aprobado).
- Frontend: `JobOrders.tsx` (listado real con filtros de búsqueda/estado/urgencia + paginación por cursor, formulario de creación real en drawer) y `JobOrderDetail.tsx` (nueva página: detalle, edición, botones de transición de estado derivados de la matriz aprobada, confirmación explícita para `CLOSED`/`CANCELLED` que aclara que el registro no se borra, `workersFilled`/`workersNeeded` mostrados como solo lectura, timeline de `Activity`).
- `Activity` y `AuditLog` reales en creación/edición/cambio de estado — reutilizando los helpers ya existentes de F1/F4.9 sin cambios.

### 16.3 Desviaciones explícitas frente al pedido original (documentadas, no silenciosas)

- **Paginación:** el pedido mencionaba `page`/`pageSize`; se mantuvo **cursor/`limit`**, la convención real y única usada en todo el resto del repo (Companies, Contacts, Leads, etc.) — cambiar esto habría introducido el único endpoint del proyecto con un esquema de paginación distinto, sin ningún beneficio.
- **`requirements`:** se reutilizó el patrón ya existente de `DocumentType.key` (array de strings validados contra filas reales), no una estructura nueva — exactamente como se pidió explícitamente.

### 16.4 Bugs reales encontrados y corregidos durante la implementación (no cosméticos)

1. **RBAC:** `GET /industries` y `GET /job-categories` exigían `candidates.view`, permiso que el rol `Operations` (el rol pensado para crear Job Orders, con `jobOrders.create`) no tiene en la matriz de seed — habría bloqueado con 403 los selectores de Company/Category del propio formulario de creación. Encontrado por inspección estática de `ROLE_PERMISSIONS` antes de escribir la UI, no por un test fallido. Corregido agregando `requireAnyPermission()` (middleware nuevo, genérico, no destructivo) y aplicándolo a ambos endpoints.
2. **`activityEntityTypeSchema`** (`packages/shared/src/schemas/activities.ts`) nunca incluía `"jobOrder"` en su enum de validación, pese a que el propio comentario del modelo `Activity` en `schema.prisma` ya lo listaba como valor válido desde F0 — `GET /activities?entityType=jobOrder` devolvía 400. Encontrado verificando la página real en un navegador (Playwright), no por un test unitario. `logActivity()` (escritura) nunca se vio afectado — las filas ya se creaban bien, solo la lectura del timeline fallaba. Corregido agregando `"jobOrder"` al enum.

### 16.5 Verificación (evidencia, no autodeclaración)

- **Backend:** 29/29 tests nuevos en `apps/api/src/modules/jobs/jobs.test.ts` (creación válida, DRAFT siempre forzado, `createdById` nunca aceptado del body, campos protegidos ignorados en edición, validación de Company/Category/tenant cruzado, `workersNeeded`/rates/fechas inválidos rechazados, las 7 transiciones válidas/inválidas/idempotentes de la matriz, cierre/cancelación sin borrado, Activity + AuditLog con before/after). **Regresión completa: 180/180 tests pasando** en los 21 archivos de test del backend (se detectó y documentó, sin corregir por estar fuera de alcance, que el script `pnpm test` del monorepo solo ejecuta 2 de los 21 archivos porque el glob `src/**/*.test.ts` no expande recursivamente bajo el shell no interactivo que usa pnpm — la regresión real se corrió expandiendo el glob manualmente).
- **Frontend/Playwright, en navegador real:** abrir listado → crear Job Order real (Company/Category/campos reales) → confirmar que aparece en el listado filtrado por búsqueda → abrir detalle → editar título → `DRAFT→OPEN` → `OPEN→CANCELLED` con diálogo de confirmación real → cero errores de consola, cero requests fallidos. Corrida dos veces (una reveló el bug de `activityEntityTypeSchema`, la segunda —tras el fix— limpia). Fixtures de prueba eliminados tras cada corrida, sin dejar datos de prueba residuales.
- `pnpm typecheck` y `pnpm lint` limpios en todo el monorepo tras cada paso.
- F0–F4.9 intactos: ningún test preexistente modificado ni roto.

### 16.6 Commits (uno por paso pequeño, sin regenerar/resetear la base en ningún momento)

`db3af5c` (migración) → `e12c38a` (contratos compartidos) → `66bf0cd` (service.ts) → `e0253a7` (router + fix RBAC) → `f1a6374` (tests backend) → `0ea4a24` (frontend + fix Activity.entityType).

### 16.7 Lo que F5.1 explícitamente no incluye (queda para bloques posteriores de §3.3)

Projects (CRUD), Workers, Assignments, Compliance (escritura), Timesheets, Payroll, Billing, Matching por IA, notificaciones externas — nada de esto se tocó, tal como se acordó.

---

## 17. F5.2 — Candidates CRUD real + conversión controlada a Worker — Resultado real (implementado, verificado, cerrado)

**Estado: completo.**

### 17.1 Cambio de schema aplicado (aprobado explícitamente antes de migrar)

- `Candidate.createdById String?` (nuevo, sin `@relation` — mismo patrón que `JobOrder.createdById` de F5.1) — se resuelve siempre desde el contexto autenticado, nunca del body. Sin backfill.
- Migración única `20260714120000_f5_2_add_candidate_created_by`, aplicada con `prisma migrate deploy`, verificada tras aplicar (columna nullable sin default, 40/40 Candidates de seed con `createdById=NULL`, regresión completa F5.1 intacta). Commit `1e98854`.
- **No se agregó ningún otro campo** de los diferidos en la auditoría (`preferredShift`, `willingToTravel`, `transportation`, disponibilidad estructurada, dirección completa, `expectedPayRate`, notas internas, fecha de nacimiento, SSN) — quedan sin fecha, tal como se aprobó.
- **El enum `CandidateStatus` no se amplió** — se mantiene `NEW/SCREENING/QUALIFIED/PLACED/REJECTED/INACTIVE`, con el mapeo aprobado (INTERVIEW/OFFERED → QUALIFIED, WITHDRAWN/ARCHIVED → INACTIVE, HIRED → PLACED).
- **El vínculo Candidate↔Worker no requirió ningún cambio de schema** — `Worker.candidateId @unique` ya existía desde F0.

### 17.2 Alcance implementado

- Contratos compartidos (`packages/shared/src/schemas/talent.ts`): `candidateStatusSchema`, `CANDIDATE_STATUS_TRANSITIONS` + `isValidCandidateStatusTransition` (matriz aprobada, PLACED nunca alcanzable manualmente, REJECTED/INACTIVE reabren únicamente a NEW), `candidateListItemSchema`/`candidateQuerySchema`/`candidateDetailSchema`, `createCandidateInputSchema`/`updateCandidateInputSchema`/`updateCandidateStatusInputSchema`, `convertCandidateToWorkerInputSchema`/`convertCandidateToWorkerResultSchema`, `workerDetailSchema` (con `documents` identificados por procedencia).
- Backend: `talent/service.ts` extendido con CRUD completo de Candidate (dedup por email normalizado insensible a mayúsculas + teléfono normalizado dentro del tenant, sin cruzar tenants), matriz de estados con reapertura auditada distinta ("reabierto"), y `convertCandidateToWorker` (transacción real vía `scopedDb.$transaction`, idempotente, nunca crea `Assignment`/`PayrollItem`). Módulo nuevo `workers/` con únicamente `GET /workers/:id` (superficie mínima aprobada).
- RBAC: `requireAllPermissions` (nueva, AND) — la conversión exige `candidates.update` Y `workers.create` a la vez, restringida hoy a CEO/Admin por decisión explícita del PO (Recruiter puede crear/editar/mover candidatos hasta QUALIFIED, pero no ejecutar la conversión final).
- Frontend: `Candidates.tsx` (creación real, filtros, búsqueda), `CandidateDetail.tsx` (nueva: edición, transiciones de estado, acción separada "Convert to Worker" con diálogo propio — gateada por permiso, con fallback de solo-texto para Recruiter), `WorkerDetail.tsx` (nueva, mínima: datos de empleo, vínculo de vuelta, documentos combinados con procedencia).

### 17.3 Desviaciones explícitas frente al pedido original (documentadas, no silenciosas)

- Paginación: se mantuvo cursor/`limit` (misma convención del resto del repo), no `page`/`pageSize`.
- Deduplicación: implementada 100% a nivel de servicio (sin índice único en DB sobre `email`/`phone`) — **riesgo de carrera concurrente documentado y aceptado explícitamente por el PO**, no resuelto en esta pasada.
- Workers: solo `GET /workers/:id` — listado completo, edición, filtros, disponibilidad y Assignments quedan para el bloque siguiente, tal como se aprobó.

### 17.4 Bugs reales encontrados y corregidos durante la implementación (no cosméticos)

1. **`activityEntityTypeSchema`** nunca incluía `"candidate"` ni `"worker"` (mismo tipo de gap que `"jobOrder"` en F5.1) — corregido proactivamente antes de conectar el timeline, no después de un 400 en el navegador.
2. **Rate limiter de `/public/*` filtrándose a toda la API real**: `publicRouter.use(readLimiter)` se aplicaba sin restricción de path, y como `publicRouter` se monta en `app.use("/api/v1", publicRouter)`, cualquier request a `/api/v1/lo-que-sea` (incluyendo `/candidates`, `/workers`, cualquier endpoint autenticado) consumía un cupo del mismo balde de 60/min pensado únicamente para tráfico anónimo del sitio de marketing. Encontrado al correr la propia suite de tests de F5.2 (>60 requests en <60s empezaron a recibir 429 en endpoints internos). En producción esto habría podido throttlear usuarios internos reales. Corregido aplicando `readLimiter` por ruta (mismo patrón que `writeLimiter`), nunca a nivel de router completo — sin cambiar el comportamiento del sitio público en sí.

### 17.5 Verificación (evidencia, no autodeclaración)

- **Backend:** 32 tests nuevos (`talent/talent.test.ts` 29 + `workers/workers.test.ts` 3) cubriendo CRUD, dedup (email case-insensitive, teléfono con formato/código de país distintos), tenancy, matriz de estados completa (incl. `PLACED` nunca alcanzable vía `PATCH /status`, reapertura auditada, salto directo `REJECTED→QUALIFIED` rechazado), conversión a Worker (RBAC combinado, no-QUALIFIED rechazado, idempotencia real con conteo de filas, **rollback real de transacción verificado con un overflow numérico genuino en `defaultPayRate` — sin mockear nada**, cero `Assignment`/`PayrollItem` creados), Activity + AuditLog (sin PII en metadata, intento de conversión duplicado también auditado). **Regresión completa: 212/212 tests** (180 preexistentes de F0–F5.1 + 32 nuevos).
- **Frontend/Playwright, en navegador real:** listado → crear Candidate real → aparece en búsqueda → detalle → editar → `NEW→SCREENING→QUALIFIED` → Convert to Worker con diálogo de confirmación real → `PLACED` → link "Ver Worker" → detalle de Worker correcto (sin duplicado). Corrida dos veces, ambas limpias tras el fix del rate limiter — cero errores de consola, cero requests fallidos. Fixtures eliminados sin dejar residuales (verificado con conteo directo en DB).
- `pnpm typecheck` y `pnpm lint` limpios en todo el monorepo (solo los 2 warnings preexistentes de F4.8/F4.9, sin relación con F5.2).
- F0–F5.1 intactos: ningún test preexistente modificado ni roto.

### 17.6 Commits (uno por paso pequeño, sin regenerar/resetear la base en ningún momento)

`1e98854` (migración) → `05ef7c1` (contratos compartidos) → `dd08826` (service.ts + `GET /workers/:id`) → `72403ff` (router + RBAC combinado + módulo workers) → `a518170` (fix rate limiter, encontrado corriendo la suite) → `b0e7cce` (tests backend) → `e2681fd` (frontend).

### 17.7 Lo que F5.2 explícitamente no incluye (queda para bloques posteriores de §3.3)

Projects (CRUD), Workers (CRUD/listado/edición/filtros/disponibilidad), Assignments, Compliance (escritura), Timesheets, Payroll, Billing, Invoices, Matching por IA, portal de candidatos, onboarding electrónico, notificaciones externas — nada de esto se tocó, tal como se acordó.

---

**Este documento fue de planificación para F5 completo; §16 y §17 documentan el resultado real de los dos primeros bloques implementados (F5.1, F5.2). El resto de F5 (§5–§12, salvo lo ya cerrado) sigue siendo planificación pendiente de aprobación bloque por bloque, empezando por el siguiente que se apruebe explícitamente.**
