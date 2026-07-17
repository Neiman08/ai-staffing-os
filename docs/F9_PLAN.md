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
