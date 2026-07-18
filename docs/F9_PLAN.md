# F9 — Staffing Operations — Plan

**Autorización**: ejecución autónoma continua F9.1→F9.12 (mensaje del PO, tras el cierre aprobado de F8 en `56b7f76`). F8 cerrado (`docs/F8_FINAL_REPORT.md`). No se reabre F8 salvo regresión crítica comprobable durante F9.

## 1. Auditoría previa (hecha antes de escribir código)

Ya existe (F5.x-F8.x históricos — NO se reimplementa):

- **`Worker`**: `status` (`WorkerStatus`: AVAILABLE/ASSIGNED/ON_LEAVE/TERMINATED — disponibilidad OPERATIVA, no onboarding), `complianceStatus` (`ComplianceStatus`: COMPLIANT/PENDING/BLOCKED), `defaultPayRate Decimal(10,2)`, `candidateId` único 1:1 con `Candidate`. CRUD real en `workers/`.
- **`Assignment`**: `payRate`/`billRate Decimal(10,2)` (snapshot al momento de asignar), `status` (`AssignmentStatus`: SCHEDULED/ACTIVE/COMPLETED/TERMINATED), relaciones a `Shift[]`/`TimeEntry[]`/`PayrollItem[]`. CRUD real en `assignments/`.
- **`Shift`**: `assignmentId`, `date @db.Date`, `startTime`/`endTime` (String "HH:MM"), `breakMinutes`. **Sin status, sin timezone** — hueco real que F9.6 debe llenar (no un bug, un campo nunca agregado).
- **`TimeEntry`**: `assignmentId`, `date`, `regularHours`/`overtimeHours`/`doubleHours Decimal`, `perDiem`/`bonus Decimal?`, `status` (`TimeEntryStatus`: PENDING/APPROVED/LOCKED), `source` (`TimeEntryStatus`: MANUAL/TIMECLOCK/IMPORT), `@@unique([assignmentId, date])`. CRUD real en `payroll/service.ts` (`listTimeEntries`, `createTimeEntry`, `updateTimeEntry`, `bulkApproveTimeEntries`).
- **`PayrollRun`/`PayrollItem`**: `PayrollRunStatus` DRAFT→PENDING_APPROVAL→APPROVED→PAID→EXPORTED (estrictamente forward). `PayrollItem` usa un flag `invoiced: Boolean` (no enum) para evitar doble facturación. Motor real de cálculo regular/OT/double/bill/margin ya existe en `payroll/service.ts`.
- **`Invoice`/`Payment`**: `InvoiceStatus` DRAFT/SENT/PAID/OVERDUE/VOID -- PAID siempre DERIVADO (nunca seteado a mano), `Invoice.balance` nunca se guarda, siempre `total - sum(Payment.amount)` en lectura. Motor real en `billing/service.ts` (`createInvoice` toma `PayrollItem`s no facturados). Scheduler real de overdue ya existe (`billing/scheduler.ts`, sweep in-process cada 60min, mismo patrón que `compliance/scheduler.ts`).
- **`Document`/`DocumentType`/`ComplianceAlert`**: `DocumentStatus` PENDING_REVIEW/VERIFIED/REJECTED/EXPIRED. `DocumentType` es HYBRID_GLOBAL (catálogo compartido + override de tenant). `ComplianceAlert` sin enum de status propio (resolución vía `resolvedAt`/`resolvedById` nullable). Motor real en `compliance/service.ts` (`recomputeWorkerComplianceStatus`, `verifyDocument`, `runComplianceAlertSweepForTenant`).
- **`matching/`** (F6, Worker↔JobOrder, ya cerrado): NO se toca, dominio operativo distinto del F8 (Candidate↔JobOrder pre-hire).
- **`PlacementReadiness`** (F8.10): scoring/readiness-check por par (candidateId, jobOrderId) -- explícitamente NUNCA implica que se creó un Placement/Assignment ni que se activó un Worker. F9.1/F9.4 deben CONSUMIR su `readinessStatus` como señal de entrada, nunca recalcularlo.
- **RBAC**: recursos CRUD ya existen para `workers`/`assignments`/`payrollRuns`/`invoices`/`documents`/`timeEntries`, más los permisos especiales `payroll.approve`, `compliance.verify`, `compliance.block`, `invoices.send`.
- **Convención de dinero**: `Decimal @db.Decimal(p,s)` en schema, `Number()` en aritmética de service, número plano de vuelta a Prisma -- nunca floats sin casting, nunca una librería nueva.
- **Convención de timezone**: campo `String timezone` plano (nombre IANA), mismo patrón que `InterviewPreview.timezone` (F8.9) -- sin librería de conversión, el valor es descriptivo/de validación, no se usa para aritmética de fechas.
- **Convención de state machines**: `<MODELO>_STATUS_TRANSITIONS: Record<Status, Status[]>` + `isValidXTransition(from, to)` (idéntico → siempre válido), ya usado 8 veces (Candidate/Worker/JobOrder/Assignment/PayrollRun/Invoice/InterviewPreview/Shortlist).
- **Workaround de clave única compuesta**: la extensión de tenancy no soporta `findUnique`/`upsert` con `@@unique` compuesto -- usar `findFirst` por campos planos + `update`/`create` manual por `id` (ya usado 6 veces en F8.5-F8.10).

NO existe (esto es lo que F9 realmente agrega):

- Modelo `Placement` -- no existe en absoluto. Confirmado por grep exhaustivo del schema.
- Cualquier lifecycle de ONBOARDING de Worker -- `WorkerStatus` es disponibilidad operativa, no progreso de onboarding. Hueco real, no un bug.
- Modelo de checklist de documentos configurable -- hoy `Document`/`DocumentType` son records individuales sin agrupación de "checklist requerido para X".
- Motor de reglas de compliance CONFIGURABLE (por tenant/estado/industria/cliente/categoría) -- hoy `recomputeWorkerComplianceStatus` es lógica fija, no reglas parametrizables.
- `Shift.status`/`Shift.timezone` -- no existen.
- Evaluador de "listo para exportar nómina" -- `payroll/service.ts` calcula, pero no hay un readiness-check previo tipo F8.10.
- Evaluador de "listo para facturar" -- similar, `billing/service.ts` factura pero no hay un readiness-check previo.
- Registro de incidentes/excepciones operacionales -- no existe ningún modelo.
- Reportes operacionales agregados tenant-scoped -- no existen (más allá de dashboards puntuales ya existentes de otras fases).
- UI de operaciones de Worker -- no existe una vista integrada equivalente a la de F8.11.

## 2. Arquitectura (mismo patrón que F8, adaptado a un dominio con dinero/compliance)

- Módulos puros donde el cálculo es realmente puro (reglas de compliance, readiness de nómina/facturación, state machines) en `apps/api/src/modules/operations-intelligence/` (nuevo directorio, paralelo a `recruiting-intelligence/`).
- Wiring impuro extendiendo los módulos YA EXISTENTES (`workers/service.ts`, `assignments/service.ts`, `payroll/service.ts`, `billing/service.ts`, `compliance/service.ts`) en vez de crear duplicados -- cada subfase audita primero cuál módulo existente es el dueño natural del dominio.
- Todo modelo nuevo: aditivo, registrado en `STRICT_TENANT_MODELS`, con `<MODELO>_STATUS_TRANSITIONS` si tiene estado, `AuditLog` en cada escritura sensible, RBAC explícito, mismo workaround de clave compuesta que F8.

## 3. Subfases

| # | Nombre | Nuevo/Extiende |
|---|---|---|
| F9.1 | Worker Onboarding | Nuevo modelo `WorkerOnboarding` (keyed por candidateId, workerId opcional hasta que se cree) -- consume `PlacementReadiness`, reutiliza `createWorkerFromQualifiedCandidate`/`convertCandidateToWorker` ya existente para NO duplicar la creación de Worker |
| F9.2 | Document Checklist | Nuevo modelo `DocumentChecklistItem` -- reutiliza `Document`/`DocumentType` ya existentes, nunca los duplica |
| F9.3 | Compliance Rules | Nuevo módulo puro de reglas configurables -- extiende `compliance/service.ts`, no lo reescribe |
| F9.4 | Placement | Nuevo modelo `Placement` -- conecta a `PlacementReadiness` (consumida, no recalculada), antecede a `Assignment` |
| F9.5 | Assignment Management | Extiende `Assignment` (ya existe casi todo el lifecycle) -- agrega `placementId` opcional + refuerza validaciones de overlap/aprobación |
| F9.6 | Shift and Time Structure | Extiende `Shift` (agrega status+timezone, aditivo) + `payroll/service.ts` (ya tiene TimeEntry CRUD, se refuerzan discrepancy/overtime flags) |
| F9.7 | Payroll Readiness | Nuevo módulo puro + wiring -- consume `Assignment`/`TimeEntry`/`Worker.complianceStatus` ya existentes |
| F9.8 | Billing Readiness | Nuevo módulo puro + wiring -- consume `PayrollItem`/`Assignment`/`Contract` ya existentes |
| F9.9 | Worker Operations UI | Nuevo, mismo patrón que F8.11 (sin app separada, embebido en páginas reales) |
| F9.10 | Exceptions and Incidents | Nuevo modelo `OperationalIncident` |
| F9.11 | Operational Reports | Nuevo módulo de agregación, solo lectura |
| F9.12 | Cierre F9 (hardening, e2e, `docs/F9_FINAL_REPORT.md`) | — |

## 4. Restricciones (heredadas de la autorización global)

Sin procesar nómina real, sin transferir dinero, sin ACH, sin cobrar tarjetas, sin facturas reales enviadas, sin contactar workers/clientes, sin activar Workers automáticamente, sin aprobar horas automáticamente, sin Assignment ACTIVE automático, sin afirmar cumplimiento legal definitivo, sin PII inventada, sin migraciones destructivas.

## 5. Estado

Auditoría completa.

## 6. Resultado de F9.1 — Worker Onboarding

### 6.1 Arquitectura

- **`operations-intelligence/worker-onboarding.ts`** (nuevo, puro): `WORKER_ONBOARDING_TRANSITIONS` (grafo explícito, mismo criterio que `SHORTLIST_REVIEW_TRANSITIONS` F8.7) + `isValidOnboardingTransition()` + `evaluateOnboardingProgress()` (progreso fijo por etapa 0-100, blockers/warnings/nextBestAction). Reutiliza DIRECTAMENTE `PlacementReadiness.readinessStatus` (F8.10) como señal de entrada -- nunca la recalcula. `requiresApproval` siempre `true`.
- **Nuevo modelo `WorkerOnboarding`** (schema, aditivo): un registro por par `(candidateId, jobOrderId)`, `workerId` nullable hasta que el Candidate se convierte en Worker.
- **`workers/service.ts` → `startWorkerOnboarding()`** (impuro, nuevo): exige una `PlacementReadiness` YA evaluada (400 si no existe); idempotente (devuelve el registro existente sin duplicar). **`getWorkerOnboarding()`** (solo lectura). **`updateWorkerOnboardingStatus()`**: valida la transición, RECHAZA `ACTIVE` sin un Worker ya existente, y re-vincula `workerId` leyendo la relación `candidate.worker` en el momento del cambio (nunca crea el Worker -- reutiliza el flujo YA EXISTENTE `convertCandidateToWorker`/`createWorkerFromQualifiedCandidate`, F5.2/F5.3, sin duplicar ni una línea de esa lógica).
- **`POST /candidates/:candidateId/onboarding/:jobOrderId`** (`workers.update`+`jobOrders.view`), **`GET`** (`workers.view`+`jobOrders.view`), **`PATCH .../status`** (`workers.update`+`jobOrders.view`).

### 6.2 Bug real encontrado y corregido durante la implementación

El guard que impide activar sin Worker (`if (status === "ACTIVE" && !existing.workerId)`) comparaba contra el `workerId` YA PERSISTIDO del registro (que seguía en `null` si la conversión Candidate→Worker ocurrió DESPUÉS del último cambio de estado registrado) en vez del valor recién resuelto desde `candidate.worker` en la misma llamada. Un test de integración end-to-end (convertir a Worker real y luego intentar activar) lo detectó de inmediato; corregido moviendo la relectura de `candidate.worker` ANTES del guard.

### 6.3 Tests — 26 nuevos (todos passing)

`worker-onboarding.test.ts` (16, puro): transiciones idempotentes/válidas/inválidas; `BLOCKED` reversible; `OFFBOARDED` terminal; blockers/warnings derivados de Placement Readiness y compliance del Worker; progreso fijo por etapa; `requiresApproval` siempre `true`; determinismo. `workers.test.ts` (+10): RBAC 403; 400 sin Placement Readiness previa; inicio real en INVITED sin tocar `Candidate.status`; idempotencia; GET 404→200; camino feliz completo con rechazo de salto de etapa; **ACTIVE rechazado sin Worker** (verifica que ningún Worker se crea como efecto secundario); **ACTIVE exitoso tras conversión real** (vía el endpoint YA EXISTENTE, nunca duplicado); BLOCKED reversible; AuditLog en inicio y cambio de estado.

### 6.4 Suite completa

1003 tests, 997 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones. Typecheck y lint limpios.

### 6.5 Migraciones

`20260717180000_f9_1_worker_onboarding` -- 100% aditiva: 1 enum nuevo (`OnboardingStatus`), 1 tabla nueva (`WorkerOnboarding`) con 3 FKs (Candidate/JobOrder `ON DELETE RESTRICT`, Worker `ON DELETE SET NULL` por ser nullable), 2 índices.

### 6.6 Limitaciones conocidas

- El progreso (0-100) es fijo por etapa, no un checklist real todavía -- F9.2 lo refinará sin romper el contrato (`progress: number` se mantiene).
- `INVITED` es un estado puramente interno -- no dispara ningún email/SMS real (no existe esa integración en el proyecto), documentado explícitamente en el código.

### 6.7 Commit

`feat: F9.1 — worker onboarding lifecycle`.

**F9.1 completo.**

## 7. Resultado de F9.2 — Document Checklist

### 7.1 Arquitectura

- **`operations-intelligence/document-checklist.ts`** (nuevo, puro): `CHECKLIST_ITEM_TRANSITIONS` + `isValidChecklistItemTransition()` (WAIVED/REJECTED/EXPIRED siempre reversibles -- nunca un callejón sin salida), `buildChecklistFromRequirements()` (mapea `JobOrder.requirements`, YA existente, a items PENDING -- nunca inventa un tipo de documento), `isChecklistItemExpired()`, `summarizeChecklist()`.
- **Nuevo modelo `DocumentChecklistItem`** (schema, aditivo): un item de SEGUIMIENTO por `(workerOnboardingId, documentTypeId)` -- reutiliza `DocumentType` (catálogo ya existente) y enlaza opcionalmente al `Document` real (F0/F5) vía `documentId`, nunca lo duplica. Solo metadata (label, fechas, referencias por id) -- cero PII inventada, cero archivo/imagen guardado.
- **`workers/service.ts` → `generateChecklistForOnboarding()`** (impuro, nuevo): exige un `WorkerOnboarding` ya iniciado (F9.1); idempotente -- solo CREA items faltantes, nunca pisa el estado de uno ya existente (mismo criterio que `generateShortlistForJobOrder`, F8.7). **`getChecklistForOnboarding()`** (solo lectura). **`updateChecklistItemStatus()`**: valida la transición, registra `verifiedAt`/`verifiedById` del contexto de tenancy al marcar `VERIFIED` (nunca del body).
- **`POST /candidates/:candidateId/onboarding/:jobOrderId/checklist`** (`workers.update`+`jobOrders.view`), **`GET`** (`workers.view`+`jobOrders.view`), **`PATCH /checklist-items/:itemId/status`** (`workers.update`).

### 7.2 Tests — 30 nuevos (todos passing)

`document-checklist.test.ts` (14, puro): transiciones idempotentes/válidas/inválidas; WAIVED/REJECTED/EXPIRED siempre reversibles; construcción del checklist desde requirements reales; `manualReviewRequired` solo para tipos con `requiresExpiration`; detección de expiración solo para VERIFIED con fecha pasada; resumen (`summarizeChecklist`) distingue missing/expired/pendingReview correctamente. `workers.test.ts` (+7 test aunque cubren múltiples aserciones): RBAC 403; 404 sin onboarding iniciado; generación real desde `forklift_cert`; idempotencia que preserva progreso ya hecho (SUBMITTED no se resetea a PENDING al regenerar); camino feliz completo con rechazo de salto de etapa; WAIVED reversible; AuditLog en generación y cambio de estado.

### 7.3 Suite completa

1024 tests, 1018 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones. Typecheck y lint limpios.

### 7.4 Migraciones

`20260717190000_f9_2_document_checklist` -- 100% aditiva: 1 enum nuevo (`ChecklistItemStatus`), 1 tabla nueva (`DocumentChecklistItem`) con 3 FKs (WorkerOnboarding/DocumentType `ON DELETE RESTRICT`, Document `ON DELETE SET NULL`), 2 índices.

### 7.5 Limitaciones conocidas

- El checklist se genera únicamente a partir de `JobOrder.requirements` -- no incluye documentos "universales" (I-9/W-4) salvo que el Job Order los liste explícitamente; documentado como decisión conservadora (nunca inventar una lista de requisitos no presente en los datos).
- `source` es texto libre (mismo criterio ya aprobado para `Payment.method`), no un enum -- el frontend/integraciones futuras deciden el vocabulario.

### 7.6 Commit

`feat: F9.2 — worker document checklists`.

**F9.2 completo.**

## 8. Resultado de F9.3 — Compliance Rules

### 8.1 Arquitectura

- **`operations-intelligence/compliance-rules.ts`** (nuevo, puro): `selectApplicableRules()` (scope AND -- todo campo no-nulo debe coincidir exactamente, null = aplica a cualquier valor) + `evaluateComplianceRules()` (agrega requiredChecks/satisfiedChecks/missingChecks/expiredChecks/blockers/warnings/manualReviewFlags/complianceStatus) + `describeComplianceStatus()`. **Nunca afirma cumplimiento legal** -- textos deliberados "checklist completed"/"operationally ready"/"requires manual compliance review", verificado con test explícito.
- **Extiende `compliance/service.ts`** (F5.5, sin reescribirlo): `createComplianceRule()`/`listComplianceRules()` (CRUD de reglas configurables, valida las keys contra `DocumentType` ya existente) + `evaluateComplianceForWorkerJobOrder()` (deriva el contexto de scope -- estado del Candidate, industria/cliente de la Company del Job Order, categoría del Job Order, `employmentType` del Worker -- de datos YA reales, nunca inventados) + `getComplianceRuleEvaluation()`. Reutiliza `Worker.complianceStatus` (F5.5) como señal, nunca lo recalcula; nunca lo cambia.
- **2 modelos nuevos**: `ComplianceRule` (definición configurable) y `ComplianceRuleEvaluation` (resultado persistido, un registro por par workerId+jobOrderId).
- **`POST/GET /compliance/rules`**, **`POST/GET /workers/:workerId/compliance-evaluation/:jobOrderId`** -- todos gateados por `compliance.verify` (escritura) o `documents.view` (lectura), mismo criterio que el resto de `compliance/router.ts`.

### 8.2 Bug real encontrado y corregido durante la implementación

Un test de "regla scoped nunca aplica fuera de su categoría" usaba la key `osha10` para verificar que NO se requiriera -- pero un test anterior en el mismo archivo ya había creado una regla UNIVERSAL (sin `jobCategoryId`) que también requiere `osha10`, y esa regla persiste en la DB del tenant de test durante toda la corrida. El test fallaba correctamente detectando una interferencia real entre fixtures, no un bug del motor. Corregido usando una key (`background_check`) que ninguna otra prueba del archivo solicita.

### 8.3 Tests — 44 nuevos (todos passing)

`compliance-rules.test.ts` (16, puro): scope AND (todos los campos no-nulos deben coincidir); reglas inactivas nunca seleccionadas; READY/INCOMPLETE/BLOCKED/NEEDS_REVIEW derivados correctamente; unión deduplicada de `requiredDocumentTypeKeys` entre reglas; determinismo; **fairness de lenguaje** (nunca "legally compliant"). `compliance.test.ts` (+8): RBAC 403; rechazo de document type key inventada; **flujo real completo** INCOMPLETE→READY tras verificar un documento real, con upsert (nunca duplica la fila); scope real por categoría del Job Order; AuditLog en creación de regla y evaluación.

### 8.4 Suite completa

1048 tests, 1042 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones. Typecheck y lint limpios.

### 8.5 Migraciones

`20260717200000_f9_3_compliance_rules` -- 100% aditiva: 1 enum nuevo (`ComplianceEvaluationStatus`), 2 tablas nuevas (`ComplianceRule` con 3 FKs `ON DELETE SET NULL` por ser todas nullable; `ComplianceRuleEvaluation` con 2 FKs `ON DELETE RESTRICT`), 3 índices.

### 8.6 Limitaciones conocidas

- La evaluación es por (Worker, JobOrder) -- no existe todavía un Assignment real para derivar `assignmentType` de forma más precisa (F9.5 lo agregará); hoy se deriva de `Worker.employmentType`, una aproximación razonable documentada.
- El motor de reglas no reemplaza el sweep de alertas de F5.5 -- son sistemas complementarios (F5.5 genera alertas reactivas por vencimiento/falta; F9.3 evalúa un snapshot bajo demanda contra reglas configurables).

### 8.7 Commit

`feat: F9.3 — configurable compliance rules`.

**F9.3 completo.**

## 9. Resultado de F9.4 — Placement

### 9.1 Arquitectura

- **`operations-intelligence/placement.ts`** (nuevo, puro): `PLACEMENT_TRANSITIONS` (DRAFT→PENDING_APPROVAL→APPROVED→READY_FOR_ONBOARDING→ACTIVE→COMPLETED, CANCELLED reversible a DRAFT) + `checkPlacementTransition()` -- valida reglas de negocio ADEMÁS del grafo: compensación (`payRate`/`billRate`) debe estar explícita antes de avanzar más allá de DRAFT/CANCELLED (nunca inferida), y Placement Readiness NOT_READY bloquea cualquier estado operativo.
- **Nuevo módulo `placements/`** (paralelo a `assignments/`/`workers/`, no forzado dentro de un módulo existente dado que Placement es un dominio genuinamente nuevo): `createPlacement()` (idempotente, exige `PlacementReadiness` YA evaluada, 400 si no existe; enlaza `workerId` automáticamente si el Candidate ya tiene Worker, nunca crea uno), `getPlacement()`/`getPlacementById()`, `updatePlacement()` (campos no sensibles al estado), `updatePlacementStatus()` (único camino para cambiar `status`, registra `approverId`/`approvedAt` al llegar a APPROVED).
- **Nuevo modelo `Placement`**: un registro por par `(candidateId, jobOrderId)`. `payRate`/`billRate` nullable -- si faltan, el registro nace en DRAFT con un blocker explícito en el propio registro (`blockers: string[]`), nunca una compensación inventada.
- **`POST/GET /candidates/:candidateId/placement/:jobOrderId`**, **`GET/PATCH /placements/:id`**, **`PATCH /placements/:id/status`** -- gateados por `assignments.{create,view,update}` (mismo permiso que Assignments, ya que Operations gestiona ambos y un Placement antecede a un Assignment en el flujo).

### 9.2 Tests — 21 nuevos (todos passing)

`placement.test.ts` (12, puro): transiciones idempotentes/válidas/inválidas; CANCELLED reversible solo a DRAFT; COMPLETED terminal; compensación faltante bloquea cualquier avance salvo DRAFT/CANCELLED; NOT_READY bloquea estados operativos; readiness no-READY_FOR_APPROVAL es warning, no blocker. `placements.test.ts` (+9): RBAC 403; 400 sin Placement Readiness previa; creación real con blocker de compensación visible, sin tocar `Candidate.status`; idempotencia; PATCH status rechaza PENDING_APPROVAL sin compensación, permite tras setearla; **rechazo real de salto DRAFT→ACTIVE** (nunca se activa automáticamente); camino feliz completo DRAFT→...→COMPLETED con `approverId`/`approvedAt` reales; CANCELLED reversible; AuditLog en creación y cambio de estado.

### 9.3 Suite completa

1069 tests, 1063 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones. Typecheck y lint limpios.

### 9.4 Migraciones

`20260717210000_f9_4_placement` -- 100% aditiva: 1 enum nuevo (`PlacementStatus`), 1 tabla nueva (`Placement`) con 4 FKs (Candidate/Company/JobOrder `ON DELETE RESTRICT`, Worker `ON DELETE SET NULL`), 2 índices.

### 9.5 Limitaciones conocidas

- `@@unique([candidateId, jobOrderId])` significa un único registro de Placement por par para siempre -- un Placement CANCELLED se reabre a DRAFT (mismo registro), nunca se crea uno nuevo para el mismo par. Decisión conservadora documentada: evita la complejidad de "múltiples placements históricos, solo uno activo" sin que la instrucción lo pidiera explícitamente.
- `shiftType` reutiliza el enum `ShiftType` ya existente (DAY/NIGHT/WEEKEND/ROTATING) en vez de un campo de texto libre para "shift" -- más estructurado y consistente con `JobOrder.shiftType`.

### 9.6 Commit

`feat: F9.4 — approval-gated placements`.

**F9.4 completo.**

## 10. Resultado de F9.5 — Assignment Management

### 10.1 Decisión de arquitectura (documentada antes de implementar)

`packages/shared/src/schemas/assignments.ts` tenía un comentario explícito de F5.4: *"enum real... no se amplía"*. F9.5 lo revisita por instrucción explícita del PO en esta sesión (lifecycle extendido DRAFT/PENDING_APPROVAL/CONFIRMED/ACTIVE/PAUSED/COMPLETED/CANCELLED). Decisión conservadora: en vez de reemplazar el enum, se EXTIENDE aditivamente -- `SCHEDULED` pasa a jugar el rol de "CONFIRMED" (conserva el nombre y el 100% de su semántica/transiciones previas hacia `ACTIVE`/`TERMINATED`), y se agregan `DRAFT`/`PENDING_APPROVAL` (antes de `SCHEDULED`), `PAUSED` (entre `SCHEDULED`/`ACTIVE`) y `CANCELLED` (alternativa reversible a `TERMINATED`, que sigue terminal). Cero transición previa se eliminó -- el grafo nuevo es un superconjunto exacto del anterior. Verificado con las 24 pruebas de integración YA existentes de F5.4, que siguen pasando sin modificar una sola.

### 10.2 Arquitectura

- **`packages/shared/src/schemas/assignments.ts`**: `assignmentStatusSchema` extendido a 8 valores; `ASSIGNMENT_STATUS_TRANSITIONS` extendido preservando el subgrafo original; `createAssignmentInputSchema` gana `placementId` opcional.
- **`assignments/service.ts`** (extendido, no reescrito): `createAssignment()` -- si viene `placementId`, exige que el `Placement` (F9.4) esté `APPROVED`/`READY_FOR_ONBOARDING`/`ACTIVE` (400 si no), y el Assignment nace en `DRAFT` en vez de `SCHEDULED` (comportamiento F5.4 sin cambios cuando no se provee `placementId`). `updateAssignmentStatus()` -- al ENTRAR a un estado que ocupa al Worker (`SCHEDULED`/`ACTIVE`/`PAUSED`, nuevo `OCCUPYING_STATUSES`) desde uno que no ocupaba, verifica: (a) solapamiento de fechas real contra otras Assignments del mismo Worker en estado ocupante (reutiliza `doDateRangesOverlap`, F6.2, sin duplicar la fórmula -- mismo primitivo ya reusado por F8.9); (b) si existe un `WorkerOnboarding` (F9.1) real para el mismo par, que no esté `BLOCKED`/`OFFBOARDED` (señal consumida, nunca recalculada, chequeo no bloqueante si nunca se usó F9.1 para ese Worker). `recomputeJobOrderFillState`/`recomputeWorkerAssignedState` ahora cuentan `PAUSED` como ocupante (antes solo `SCHEDULED`/`ACTIVE`) -- una Assignment pausada sigue reservando el cupo.
- **`Assignment.placementId`** (nullable, aditivo) enlaza opcionalmente al `Placement` de origen.

### 10.3 Tests — 7 nuevos en `assignments.test.ts` (todos passing, más las 24 preexistentes verificadas sin regresión)

Rechazo real de crear un Assignment desde un Placement DRAFT (no aprobado); creación real DRAFT desde un Placement APROBADO, nunca SCHEDULED directo; un Assignment DRAFT nunca ocupa Worker/JobOrder; camino feliz completo DRAFT→...→PAUSED→ACTIVE→COMPLETED con verificación de que PAUSED sigue ocupando al Worker; CANCELLED reversible solo a DRAFT; **solapamiento real detectado y rechazado** (dos Assignments DRAFT para el mismo Worker con fechas solapadas, confirmar la segunda bloquea la primera); AuditLog en cambios de estado incluyendo PAUSED.

### 10.4 Suite completa

1076 tests, 1070 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones. Typecheck y lint limpios en `apps/api`, `packages/shared`, y `apps/web` (build de producción exitoso, confirmando que el enum extendido no rompe ningún switch exhaustivo del frontend).

### 10.5 Migraciones

`20260717220000_f9_5_assignment_management` -- 100% aditiva: `ALTER TYPE "AssignmentStatus" ADD VALUE` ×4 (DRAFT/PENDING_APPROVAL/PAUSED/CANCELLED, cero valor eliminado/renombrado), `ALTER TABLE "Assignment" ADD COLUMN "placementId"` (nullable) + FK `ON DELETE SET NULL`.

### 10.6 Limitaciones conocidas

- `matching/availability.ts` (F6, `BLOCKING_ASSIGNMENT_STATUSES = {SCHEDULED, ACTIVE}`) NO se tocó -- fuera de alcance de "extiende Assignment". Implicación real: una Assignment `PAUSED` no bloquea una recomendación de matching F6 para ese Worker en esa ventana de fechas, aunque sí sigue ocupando capacidad real de JobOrder/Worker vía F9.5. Documentado como gap conocido, no un bug silencioso.
- El chequeo de onboarding es best-effort: solo bloquea si existe un `WorkerOnboarding` real con estado BLOCKED/OFFBOARDED -- Workers creados sin pasar por F9.1 nunca quedan bloqueados por esta regla nueva.

### 10.7 Commit

`feat: F9.5 — assignment lifecycle management`.

**F9.5 completo.**

## 11. Resultado de F9.6 — Shift and Time Structure

### 11.1 Decisión de arquitectura (documentada antes de implementar)

`packages/shared/src/schemas/payroll.ts` tenía el mismo comentario "no se amplía" que Assignment tuvo antes de F9.5 -- mismo criterio: EXTENSIÓN ADITIVA, no reemplazo. `TimeEntryStatus` pasa de 3 a 7 valores (DRAFT/PENDING/SUBMITTED/NEEDS_REVIEW/APPROVED/REJECTED/LOCKED); PENDING conserva su rol original exacto ("ya enviado, sin submit explícito" -- `createTimeEntry` lo sigue produciendo por default salvo que se pida `startAsDraft`), APPROVED/LOCKED conservan sus transiciones previas sin cambio. `TIME_ENTRY_STATUS_TRANSITIONS`/`isValidTimeEntryStatusTransition` viven en `packages/shared` (mismo patrón que Assignment/Candidate/Worker) -- el módulo puro `apps/api/.../time-entry-signals.ts` los re-exporta en vez de duplicarlos.

Las banderas `overtimeFlag`/`discrepancyFlag` son SEÑALES, nunca una decisión automática: ningún código las usa para aprobar/rechazar por sí solo, solo para enrutar el submit determinísticamente (discrepancia real → `NEEDS_REVIEW`; sin discrepancia → `SUBMITTED`) y para que un humano las vea en el listado antes de aprobar. Sin Shift programado para el mismo Assignment+fecha, nunca hay discrepancia que evaluar -- no se inventa una expectativa (mismo criterio que `PlacementReadiness.missingInformation`, F8.10).

### 11.2 Arquitectura

- **`apps/api/.../operations-intelligence/time-entry-signals.ts`** (nuevo, puro, `TIME_ENTRY_SIGNALS_VERSION = 1`): `computeOvertimeFlag()` (>8h totales o overtime/double ya declaradas), `computeDiscrepancyFlag()` (compara total registrado vs. duración programada de un Shift real, umbral 1h de ruido), `computeShiftScheduledHours()` (maneja turnos que cruzan medianoche), `computeSubmissionTargetStatus()`. Re-exporta `TIME_ENTRY_STATUS_TRANSITIONS`/`isValidTimeEntryStatusTransition` desde `@ai-staffing-os/shared`. 14 tests unitarios.
- **`packages/shared/src/schemas/payroll.ts`**: `timeEntryStatusSchema` extendido a 7 valores + `TIME_ENTRY_STATUS_TRANSITIONS`/`isValidTimeEntryStatusTransition` (canónicos); `createTimeEntryInputSchema` gana `startAsDraft` opcional; nuevo `rejectTimeEntryInputSchema` (rejectionReason obligatorio); `timeEntryListItemSchema` gana `overtimeFlag`/`discrepancyFlag`/`discrepancyNotes`/`rejectionReason`; nuevos `createShiftInputSchema`/`updateShiftInputSchema`/`shiftQuerySchema`/`shiftListItemSchema` (Shift CRUD, gap real confirmado por grep antes de implementar -- no existía).
- **`packages/shared/src/permissions.ts`**: nuevo recurso `shifts` (CRUD keys `shifts.view/create/update/delete` generadas automáticamente). Asignado en el seed: Operations gana `shifts.view/create/update`; Payroll/Manager ganan `shifts.view` (solo lectura, para evaluar discrepancyFlag).
- **`payroll/service.ts`** (extendido): Shift CRUD (`listShifts`/`createShift`/`updateShift`, sin delete -- no pedido). `createTimeEntry()`/`updateTimeEntry()` ahora calculan `overtimeFlag`/`discrepancyFlag` vía `computeSignalsForEntry()` (busca un Shift real para el mismo Assignment+fecha); `updateTimeEntry` ahora también acepta edición en DRAFT, no solo PENDING. Nuevas transiciones de una sola entrada: `submitTimeEntry()` (DRAFT → SUBMITTED/NEEDS_REVIEW, recalcula señales en el momento del submit por si las horas cambiaron mientras seguía DRAFT), `approveTimeEntry()`, `rejectTimeEntry()` (exige `rejectionReason`), `reopenTimeEntry()` (REJECTED → DRAFT, limpia el motivo -- nunca un rechazo permanente). `bulkApproveTimeEntries()` ahora acepta SUBMITTED además de PENDING como elegible (NEEDS_REVIEW queda excluido a propósito: exige revisión manual antes de aprobar).
- **`payroll/router.ts`**: `GET/POST /shifts`, `PATCH /shifts/:id`, `POST /time-entries/:id/{submit,approve,reject,reopen}`. Todos los verbos de un solo TimeEntry reutilizan `timeEntries.update` (mismo criterio ya establecido en F5.6 para bulk-approve -- no se inventa un permiso nuevo por cada verbo).
- **`packages/db/prisma/schema.prisma`**: `TimeEntryStatus` extendido (4 valores nuevos, aditivo). `Shift` gana `timezone String?` (mismo patrón que `InterviewPreview.timezone`, F8.9) + `notes String?`. `TimeEntry` gana `overtimeFlag`/`discrepancyFlag`/`discrepancyNotes`/`rejectionReason`/`notes`/`clockInAt`/`clockOutAt` (los dos últimos solo almacenan lo que un integrador real reporte vía `source=TIMECLOCK`, nunca inventan horas -- sin wiring de un integrador real todavía, campos reservados).

### 11.3 Tests nuevos

`time-entry-signals.test.ts` (14, puro) + 19 tests de integración nuevos en `payroll.test.ts` (Shift CRUD + RBAC + tenancy + AuditLog; startAsDraft; DRAFT editable; submit → SUBMITTED sin Shift/sin discrepancia; submit → NEEDS_REVIEW con discrepancia real y notas verificadas; overtimeFlag en creación; submit rechaza no-DRAFT; approve/reject/reopen RBAC 403; approve fija approvedById; reject exige motivo y reopen lo limpia; transición inválida DRAFT→APPROVED rechazada; bulk-approve ahora acepta SUBMITTED; AuditLog en approve). Total: 44/44 en `payroll.test.ts`.

### 11.4 Suite completa

1110 tests, 1104 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones nuevas. Typecheck y lint limpios en `apps/api` y `packages/shared`. RBAC 403 matrix (13 tests) verificado en aislamiento tras agregar el recurso `shifts`.

### 11.5 Migraciones

`20260717230000_f9_6_shift_time_structure` -- 100% aditiva: `ALTER TYPE "TimeEntryStatus" ADD VALUE` ×4 (DRAFT/SUBMITTED/NEEDS_REVIEW/REJECTED, cero valor eliminado/renombrado), `ALTER TABLE "Shift" ADD COLUMN` ×2, `ALTER TABLE "TimeEntry" ADD COLUMN` ×7 (todas nullable o con default, cero columna NOT NULL sin default).

Además: `npm run seed` re-ejecutado (idempotente, solo upserts) para propagar el recurso de permiso `shifts` nuevo a la base de datos de desarrollo -- sin esto, todos los endpoints de Shift devuelven 403 aunque el código esté correcto (detectado y corregido durante la propia verificación de F9.6, ver §11.6).

### 11.6 Bugs encontrados y corregidos durante F9.6

- Bug de proceso (no de lógica): tras agregar el recurso `shifts` a `packages/shared/src/permissions.ts`, los tests de integración fallaban con 403 en todos los endpoints de Shift -- la base de datos de desarrollo no tenía las filas `Permission`/`RolePermission` nuevas hasta re-ejecutar `npm run seed`. Documentado acá para que F9.7-F9.12 no repitan la misma sorpresa si agregan más recursos de permiso nuevos.
- Bug de test (no de producción): la primera corrida de `payroll.test.ts` se ejecutó sin `--test-concurrency=1` (el flag que sí usa `npm test`), lo que intercaló asserts de tests distintos y produjo fallos espurios con mensajes de otro test. Confirmado no-bug re-ejecutando con el flag correcto: 44/44 pass.

### 11.7 Limitaciones conocidas

- Shift no tiene `delete` expuesto -- no fue pedido explícitamente y evita huérfanos silenciosos en cálculos de discrepancia ya persistidos en TimeEntries existentes. La permission key `shifts.delete` existe (generada automáticamente por el catálogo CRUD) pero no está asignada a ningún rol ni tiene endpoint.
- `clockInAt`/`clockOutAt` son campos reservados sin wiring real todavía (ningún integrador de reloj checador existe en el sistema) -- documentado como gap conocido para una fase futura, no un bug oculto.
- Un Assignment puede tener más de un Shift el mismo día (split shift) por diseño -- `findScheduledHoursForEntry()` usa el primero por orden de creación cuando calcula la discrepancia, sin sumar turnos múltiples en una sola expectativa inventada.

### 11.8 Commit

`feat: F9.6 — shifts and time entry structure`.

**F9.6 completo.**

## 12. Resultado de F9.7 — Payroll Readiness

### 12.1 Decisión de arquitectura (documentada antes de implementar)

Confirmado por §3 de este plan (escrito antes de F9.1): F9.7 es "nuevo módulo puro + wiring -- consume Assignment/TimeEntry/Worker.complianceStatus ya existentes", A DIFERENCIA explícita de F9.1/F9.2/F9.4/F9.10 que sí agregan un modelo Prisma nuevo. Decisión conservadora tomada en consecuencia: `PayrollReadiness` NO se persiste -- se recalcula en cada consulta a partir de datos que ya existen (TimeEntry.status/overtimeFlag/discrepancyFlag, Worker.complianceStatus, PayrollItem+PayrollRun.status). Cero migración nueva en esta subfase.

Alcance elegido: por (Worker, período) -- no por Assignment individual, porque un PayrollRun (F5.7) ya agrega por Worker across todas sus Assignments dentro del período; una señal de "listo para nómina" coherente con eso debe evaluarse al mismo nivel, no fragmentada por Assignment.

### 12.2 Arquitectura

- **`apps/api/.../operations-intelligence/payroll-readiness.ts`** (nuevo, puro, `PAYROLL_READINESS_VERSION = 1`): `evaluatePayrollReadiness()`. Estados `NOT_READY | NEEDS_REVIEW | READY_FOR_EXPORT | EXPORTED | BLOCKED`, prioridad determinística: `EXPORTED` (hecho histórico, nunca se reescribe por cambios posteriores de compliance) > `BLOCKED` (compliance real) > `NOT_READY` (sin entradas, o con entradas DRAFT/PENDING/SUBMITTED/REJECTED todavía en flujo) > `NEEDS_REVIEW` (alguna entrada NEEDS_REVIEW) > `READY_FOR_EXPORT`. Entradas ya APPROVED/LOCKED con bandera overtime/discrepancy no bloquean (un humano ya las aprobó a pesar de la señal) -- se listan en `reviewNotes`, informativo. 9 tests unitarios.
- **`packages/shared/src/schemas/payroll.ts`**: `payrollReadinessStatusSchema` (5 valores), `payrollReadinessQuerySchema` (workerId/periodStart/periodEnd), `payrollReadinessResultSchema`.
- **`payroll/service.ts`** (extendido): `getPayrollReadiness(query)` -- resuelve el Worker real (404 si no existe), junta sus TimeEntries del período vía `assignment.workerId` (filtro relacional, ningún modelo nuevo), determina `alreadyExported` consultando si existe un `PayrollItem` de ese Worker dentro de un `PayrollRun` `EXPORTED` cuyo rango se solapa con el período consultado, y delega el cálculo al módulo puro.
- **`payroll/router.ts`**: `GET /payroll/readiness`. Reutiliza `payrollRuns.view` (mismo criterio ya establecido repetidamente: no se inventa un permiso nuevo para una vista de lectura sobre datos que ya exigen ese permiso).
- Sin cambios en `schema.prisma` -- ninguna migración en esta subfase.

### 12.3 Tests nuevos

`payroll-readiness.test.ts` (9, puro: EXPORTED gana siempre; BLOCKED por compliance incluso con entradas limpias; sin entradas es NOT_READY; DRAFT/PENDING/SUBMITTED mantienen NOT_READY; REJECTED mantiene NOT_READY con mensaje distinto; NEEDS_REVIEW se respeta cuando el resto ya está resuelto; todo APROBADO/LOCKED sin banderas es READY_FOR_EXPORT sin reviewNotes; banderas en entradas ya aprobadas generan reviewNotes informativos sin bloquear; compliance PENDING nunca bloquea, solo BLOCKED) + 7 tests de integración nuevos en `payroll.test.ts` (RBAC 403; sin entradas; con una entrada PENDING; con entradas APROBADAS; compliance BLOCKED real vía `prisma.worker.update`; ciclo completo hasta EXPORTED real verificando que el readiness lo refleja; Worker inexistente devuelve 404). Total: 51/51 en `payroll.test.ts`.

### 12.4 Suite completa

1126 tests, 1120 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones nuevas. Typecheck y lint limpios en `apps/api` y `packages/shared`.

### 12.5 Migraciones

Ninguna -- F9.7 no agrega columnas ni modelos, solo lee datos ya persistidos por F9.6/F5.6/F5.7.

### 12.6 Limitaciones conocidas

- La ventana de "ya exportado" se detecta por solapamiento de rango de fechas entre el período consultado y el `PayrollRun` EXPORTED (`periodStart <= periodEnd consultado` y `periodEnd >= periodStart consultado`) -- un período consultado que solo se solapa PARCIALMENTE con un run ya exportado también se reporta como `EXPORTED` en su totalidad, sin desglosar qué días específicos ya se pagaron. Documentado como simplificación real, no un bug oculto: no se pidió una vista día-por-día.
- Sin cálculo de impuestos, sin conexión bancaria/ACH, sin procesamiento real de pago -- exactamente como exige la autorización. `getPayrollReadiness` es una vista de solo lectura.

### 12.7 Commit

`feat: F9.7 — payroll readiness evaluator`.

**F9.7 completo.**

## 13. Resultado de F9.8 — Billing Readiness

### 13.1 Decisión de arquitectura (documentada antes de implementar)

Mismo criterio que F9.7: §3 de este plan ya anticipaba "nuevo módulo puro + wiring -- consume PayrollItem/Assignment/Contract ya existentes", sin modelo Prisma nuevo. `BillingReadiness` se recalcula en cada consulta, cero migración.

Alcance elegido: por (Company, período) -- mismo nivel de agregación que `createInvoice` (F5.8) ya usa (`assignment.jobOrder.companyId`), para que la señal de "listo para facturar" sea coherente con lo que realmente se facturaría.

Decisión sobre `Contract`: una Company puede tener 0 o más Contracts (`Company.contracts Contract[]`, confirmado por grep del schema). Se prefiere uno `ACTIVE` si existe; si ninguno lo está, el más reciente por `createdAt`. Una Company SIN Contract en archivo nunca bloquea -- el sistema no exige contrato para operar (dato real: `company-01` del seed no tiene ningún Contract) -- solo genera un `reviewNote` informativo. Sí bloquea (`BLOCKED`) un Contract real cuyo `status` es `EXPIRED` o `TERMINATED`.

### 13.2 Arquitectura

- **`apps/api/.../operations-intelligence/billing-readiness.ts`** (nuevo, puro, `BILLING_READINESS_VERSION = 1`): `evaluateBillingReadiness()`. Estados `NOT_READY | NEEDS_REVIEW | READY_FOR_INVOICE | EXPORTED | BLOCKED`, prioridad determinística: `BLOCKED` (Contract EXPIRED/TERMINADO) > si hay `PayrollItem` elegibles ahora (no facturados + su `PayrollRun` ya es facturable, mismo criterio `BILLABLE_PAYROLL_RUN_STATUSES` de F5.8): `NEEDS_REVIEW` si ADEMÁS existen otros items del mismo período todavía no facturables (facturación parcial, requiere juicio humano) o `READY_FOR_INVOICE` si no > si NO hay items elegibles ahora: `NOT_READY` si hay items pendientes de aprobación de nómina, `EXPORTED` si el período ya se facturó por completo (todos los items ya `invoiced`), o `NOT_READY` si nunca hubo nada que facturar. Dinero Decimal-safe: `estimatedRevenue`/`estimatedLaborCost`/`estimatedGrossProfit`/`estimatedMarginPercent` (strings de 2 decimales, `marginPercent` nunca `NaN`/`Infinity` con ingresos en cero) calculado SOLO sobre los items elegibles (nunca sobre los ya facturados ni sobre los todavía pendientes). 9 tests unitarios.
- **`packages/shared/src/schemas/billing.ts`**: `billingReadinessStatusSchema` (5 valores), `billingReadinessQuerySchema` (companyId/periodStart/periodEnd), `billingReadinessResultSchema`.
- **`billing/service.ts`** (extendido): `getBillingReadiness(query)` -- resuelve la Company real (404 si no existe), selecciona el Contract relevante, junta TODOS los `PayrollItem` de esa Company+período (mismo filtro relacional que `createInvoice`, pero sin restringir por `invoiced`/estado del run -- el evaluador puro necesita ver el cuadro completo para distinguir elegible/pendiente/ya facturado), y delega el cálculo.
- **`billing/router.ts`**: `GET /billing/readiness`. Reutiliza `invoices.view` (mismo criterio ya establecido repetidamente: sin permiso nuevo para una vista de lectura).
- Sin cambios en `schema.prisma` -- ninguna migración en esta subfase.

### 13.3 Tests nuevos

`billing-readiness.test.ts` (9, puro: Contract EXPIRED/TERMINATED bloquea; Contract ausente nunca bloquea, solo reviewNote; sin PayrollItems es NOT_READY con dinero en cero; items elegibles sin pendientes es READY_FOR_INVOICE con dinero verificado incluyendo margen 33.33%; mezcla elegible+pendiente es NEEDS_REVIEW y el dinero solo cuenta lo elegible; solo pendientes (sin elegibles) es NOT_READY, no EXPORTED; todo ya facturado es EXPORTED con dinero en cero; margen nunca produce NaN/Infinity con ingresos cero) + 6 tests de integración nuevos en `billing.test.ts` (RBAC 403; Company inexistente 404; sin PayrollItems + reviewNote real sobre `company-01` sin Contract seedeado; PayrollRun APPROVED real -> READY_FOR_INVOICE con dinero verificado contra billRate/payRate reales; Invoice real generado -> EXPORTED; Contract EXPIRED real creado directo por Prisma -- sin endpoint de Contract CRUD en el sistema, confirmado por grep -- -> BLOCKED). Total: 20/20 en `billing.test.ts`.

### 13.4 Suite completa

1141 tests, 1135 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones nuevas (una corrida intermedia mostró 5 fallas transitorias no reproducibles; una segunda corrida limpia confirmó que era flakiness de red/timing, no una regresión real -- documentado, no ignorado). Typecheck y lint limpios en `apps/api` y `packages/shared`.

### 13.5 Migraciones

Ninguna -- F9.8 no agrega columnas ni modelos, solo lee datos ya persistidos por F5.7/F5.8 más el `Contract` ya existente desde F0.

### 13.6 Limitaciones conocidas

- No existe ningún endpoint de Contract CRUD en el sistema (confirmado por grep) -- el test de Contract EXPIRED lo crea directo vía Prisma, igual que otros fixtures de compliance en subfases previas. Real gap documentado, fuera de alcance de F9.8 (no fue pedido).
- El mismo criterio de solapamiento de rango que F9.7 aplica acá: un período consultado que se solapa solo PARCIALMENTE con Invoices/PayrollRuns ya facturados no se desglosa día-por-día.
- Sin emisión real de factura, sin envío a cliente, sin conexión bancaria -- exactamente como exige la autorización. `getBillingReadiness` es una vista de solo lectura.

### 13.7 Commit

`feat: F9.8 — billing readiness evaluator`.

**F9.8 completo.**
