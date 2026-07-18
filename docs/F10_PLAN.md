# F10 — Client and Worker Portals — Plan

**Autorización**: ejecución autónoma continua, fase previa de deuda de F9 + F10.1→F10.12, otorgada por el PO tras el cierre aprobado de F9 (commit `c07c5eb`, `docs/F9_FINAL_REPORT.md`). "F9 queda aprobado provisionalmente... No empieces F11."

## 1. Fase previa — auditoría de deuda de F9 que afecta F10

Leídos completos antes de escribir código: `docs/F9_FINAL_REPORT.md`, `docs/F8_FINAL_REPORT.md`, `docs/F4_9_PRODUCTION_AUTH_PLAN.md` (plan, nunca implementado como default — Clerk permanece diferido), estado real de `apps/api/src/modules/auth/*` (Clerk SÍ tiene código implementado -- `clerk.provider.ts`, `webhook-handlers.ts`, etc. -- pero `AUTH_MODE` sigue en `dev-bypass` por decisión explícita del PO, memoria de sesión: "F4.9/Clerk paused indefinitely").

### 1.1 Deuda identificada (de `docs/F9_FINAL_REPORT.md` §23-24) y su relación con F10

| Deuda | Afecta F10 | Decisión |
|---|---|---|
| Gap `PAUSED` en `matching/availability.ts` (`BLOCKING_ASSIGNMENT_STATUSES` solo tiene SCHEDULED/ACTIVE, comentario dice "solo los 4 valores reales" -- stale desde que F9.5 extendió `AssignmentStatus` a 8 valores) | SÍ -- el Worker Portal (F10.6) muestra Assignments/schedule; si `PAUSED` no bloquea disponibilidad, un Worker pausado podría aparecer "disponible" para nuevo matching mientras la UI del portal lo muestra con una Assignment activa pausada -- inconsistencia visible al usuario. | **Corregir.** Aditivo: agregar `"PAUSED"` al Set existente. Cero test rompe (ver §1.3). |
| UI pendiente para Incidents (F9.10) | Parcialmente -- el Worker/Client portal necesita ver incidentes relacionados (F10.4/F10.6), pero la UI INTERNA de gestión de incidentes no es prerequisito de F10. | **Diferir** la UI interna de gestión; **incluir** vista de solo lectura de incidentes propios dentro de los portales (ya es parte explícita del alcance de F10.4/F10.6). |
| UI pendiente para Reports (F9.11) | NO -- Reports es agregado tenant-wide para uso interno, ningún portal de cliente/worker lo necesita. | **Diferir**, fuera de alcance de F10. |
| Sin desglose día-por-día en Payroll/Billing Readiness | NO -- no lo usa ningún portal nuevo. | **Diferir.** |
| `Shift.delete` no expuesto | NO -- ningún portal necesita borrar turnos. | **Diferir.** |
| `clockInAt`/`clockOutAt` sin integrador real | Tangencial -- Time Entry UX (F10.7) es manual (draft→submit), no depende de un integrador de reloj checador. | **Diferir**, sin bloqueo. |

### 1.2 Deuda NO documentada en F9 pero descubierta en esta auditoría previa (crítica para F10)

1. **No existe ninguna identidad de portal.** `User` es exclusivamente personal interno (`tenantId`, `roleId`, sin vínculo a Company/Worker/Candidate). Un cliente, un worker o un candidato no tienen forma de autenticarse hoy -- ni siquiera en dev-bypass. **Bloqueante real para F10.1-F10.11**, resuelto en F10.1 (ver §2).
2. **Un solo tenant sembrado** (`tenant-titan`). Los tests de fuga entre tenants de F5-F9 usan `runWithTenancyContext` a nivel de Prisma (nunca HTTP real con dos tenants reales). F10.11 exige probar aislamiento entre tenants a nivel HTTP real. **Resuelto en F10.1**: se siembra un segundo tenant mínimo (`tenant-acme`) con los datos mínimos para probar fuga real.
3. **`cors()` abierto sin restricción** (`app.ts`, heredado de F0, documentado en el plan de F4.9 §1.5 como pendiente de esa fase, nunca crítico hasta que hay portales de terceros reales). Con portales de cliente/worker ahora en juego, sigue sin ser un problema de PRODUCCIÓN real (nada se despliega), pero se documenta como deuda diferida explícita -- no se toca en F10 porque tocar CORS es una decisión de despliegue (F4.9), no de portal.

### 1.3 Corrección aplicada (commit separado, antes de F10.1)

- `apps/api/src/modules/matching/availability.ts`: `BLOCKING_ASSIGNMENT_STATUSES` gana `"PAUSED"`. Comentario stale corregido. Verificado contra los tests existentes de `availability.test.ts` (F6.2) -- todos siguen pasando sin modificar ninguno, porque ninguno ejercitaba `PAUSED` (era, en efecto, un caso no cubierto, no un caso mal cubierto).

### 1.4 Deuda explícitamente diferida (no se toca en F10)

- UI interna de gestión de Incidents/Reports (F9.10/F9.11) -- fuera de alcance de portales.
- Desglose día-por-día de Payroll/Billing Readiness.
- `Shift.delete`.
- Integrador real de timeclock.
- CORS abierto -- decisión de despliegue, pertenece a F4.9 cuando se retome.
- Clerk -- permanece dormido, `AUTH_MODE=dev-bypass` es el único modo funcional en F10 (instrucción explícita del PO: "Clerk no debe convertirse en bloqueo para F10").

## 2. F10.1 — Roles and Permissions: decisión de arquitectura de identidad de portal

**Decisión (conservadora, aditiva, reutiliza antes de duplicar):** extender `User` (NO crear un modelo de identidad paralelo) con tres FKs nullable nuevas: `companyId` (identidad de portal de cliente), `workerId` (identidad de portal de worker), `candidateId` (identidad de portal de candidato). Cero cambio a filas existentes (todas nullable, todo el personal interno sigue con las 3 en `null`). Reutiliza el 100% de la infraestructura ya construida: `AuthProvider`/`ResolvedIdentity`, `dev-bypass` por header `x-dev-user`, `requirePermission`, `scopedDb`, `AuditLog`, RBAC por rol.

`ResolvedIdentity`/`TenancyContext` ganan 3 campos nuevos opcionales (`companyId`/`workerId`/`candidateId`), poblados por `DevBypassAuthProvider` desde el `User` resuelto. Cada servicio de portal nuevo hace un chequeo de ownership explícito contra estos campos (`if (ctx.workerId !== entity.workerId) throw AppError.forbidden()`) -- autorización de dos capas (permiso + ownership), igual al patrón IDOR que exige F10.11. Se decide NO introducir sufijos de acción nuevos tipo `.viewOwn`/`.updateOwn` en el vocabulario de permisos (evita una explosión combinatoria de 180 llaves sin necesidad real) -- en su lugar, los recursos de portal nuevos (`portalProfile`, `clientJobs`, `notifications`) usan el mismo vocabulario CRUD ya establecido, y el "own" se aplica en el service layer, nunca en el nombre del permiso.

**Roles nuevos** (seed, `ROLE_PERMISSIONS`): `CLIENT_ADMIN`, `CLIENT_MANAGER`, `WORKER`, `CANDIDATE`. Los roles internos (CEO, Admin, Recruiter, Sales, Payroll, Compliance, Operations, Marketing, HR, Accounting, Manager) no se tocan ni se renombran -- el PO pidió `INTERNAL_ADMIN`/`RECRUITER`/`SALES`/`OPERATIONS` como vocabulario conceptual del portal; se documenta el mapping en vez de renombrar 11 roles reales ya en uso desde F0 (evita romper 1170+ tests que referencian esos nombres literales):

| Nombre conceptual del PO | Rol real existente |
|---|---|
| INTERNAL_ADMIN | Admin / CEO |
| RECRUITER | Recruiter |
| SALES | Sales |
| OPERATIONS | Operations |
| CLIENT_ADMIN | **nuevo** |
| CLIENT_MANAGER | **nuevo** |
| WORKER | **nuevo** |
| CANDIDATE | **nuevo** |

**Segundo tenant sembrado**: `tenant-acme` (nombre `"Acme Staffing"`), con un `Role`/`Permission` set idéntico (vía `seedRoles`/`seedPermissions`, ya son funciones tenant-parametrizadas), una `Company` mínima, y un `User` `CLIENT_ADMIN` -- exclusivamente para que F10.11 pruebe fuga real entre tenants vía HTTP (`x-dev-user` de un tenant no debe nunca ver datos del otro). No se le agregan Candidates/Workers/JobOrders completos -- alcance mínimo suficiente para el test de aislamiento, evita inflar el seed innecesariamente.

**Permission matrix**: documentada en `packages/shared/src/permissions.ts` con comentarios inline, resources nuevos (`clientJobs`, `portalProfile`, `notifications`) generan CRUD automático; acciones especiales nuevas solo donde CRUD no alcanza: `clientJobs.approve` (revisión interna → CONVERTED_TO_JOB_ORDER), `notifications.markRead`.

Continúa con la implementación real en la subfase correspondiente.

## 3. Resultado de F10.1 — Roles and Permissions

### 3.1 Implementado

- **Schema** (`User`): 3 columnas nuevas nullable (`companyId`/`workerId`/`candidateId`) + FKs `ON DELETE SET NULL` + 3 índices. Migración `20260718010000_f10_1_portal_identity`, 100% aditiva.
- **`ResolvedIdentity`/`TenancyContext`**: 3 campos opcionales nuevos, poblados por `DevBypassAuthProvider` desde el `User` resuelto.
- **`packages/shared/src/permissions.ts`**: 8 recursos nuevos (`clientJobs`, `portalProfile`, `notifications`, `portalAssignments`, `portalTimeEntries`, `portalDocuments`, `portalIncidents`, `auditLogs`) + 2 special keys (`clientJobs.approve`, `notifications.markRead`). Decisión de seguridad central documentada en el propio archivo (comentario inline): los recursos `portal*` están DELIBERADAMENTE separados de sus equivalentes internos para que un rol de portal nunca pueda alcanzar un endpoint interno sin ownership filtering.
- **4 roles nuevos** en el seed: `CLIENT_ADMIN`, `CLIENT_MANAGER` (subconjunto estricto de `CLIENT_ADMIN`, verificado por test), `WORKER`, `CANDIDATE` -- ninguno recibe un solo permiso interno de CRUD amplio (verificado por test exhaustivo de exclusión).
- **Segundo tenant** `tenant-acme` con una Company mínima (`company-acme-01`) y un `CLIENT_ADMIN` (`client-admin@acme.dev`), exclusivamente para pruebas de fuga real entre tenants.
- **4 usuarios de portal deterministas** bajo `tenant-titan`, enlazados a fixtures YA existentes del seed (nunca inventados): `client-admin@titan.dev`/`client-manager@titan.dev` → `company-01`; `worker-portal@titan.dev` → `worker-01`; `candidate-portal@titan.dev` → `candidate-029`.
- **`GET /auth/me`** extendido con `companyId`/`workerId`/`candidateId` -- el frontend los usará (F10.2+) para decidir a qué shell de portal enrutar, nunca inspeccionando el nombre del rol como string mágico.
- **`notifications.view`/`notifications.markRead`** agregados a los 11 roles internos preexistentes además de los 4 nuevos (bandeja de notificaciones universal, F10.8).
- **`auditLogs.view`** agregado a Manager (visibilidad amplia ya establecida en ese rol) además de CEO/Admin (vía `ALL_KEYS`) y los roles de portal (acotado por ownership en el service, F10.9).
- **`clientJobs.view`/`clientJobs.approve`** agregados a Sales y Operations (revisión interna de solicitudes de cliente, F10.3).

### 3.2 Tests nuevos

`portal-identity.test.ts` (12 tests de integración): `/auth/me` resuelve correctamente cada identidad de portal (companyId/workerId/candidateId reales); aislamiento de tenant confirmado para `client-admin@acme.dev`; **los 4 roles de portal nunca reciben ni un solo permiso interno sin ownership** (lista explícita de 32 keys verificada por exact-match, nunca substring); CLIENT_MANAGER es subconjunto estricto y estrictamente menor que CLIENT_ADMIN, con los 3 bloqueadores explícitos del PO verificados uno por uno (`clientJobs.update`, `portalTimeEntries.update`, `auditLogs.view`); WORKER/CANDIDATE comparten la forma de autoservicio pero solo WORKER tiene assignments/time entries; un rol interno (Recruiter) nunca recibe un permiso de portal; fuga de tenant a nivel Prisma confirmada para el `User` de acme.

### 3.3 Suite completa

1189 tests, 1183 pass, 1 fail preexistente sin relación (`prospecting.test.ts`), 5 skip -- cero regresiones. La matriz legacy `rbac-403-matrix.test.ts` (F6.9) sigue pasando sin modificar -- su propio test de coherencia interna no asume un total fijo de roles en la base de datos.

### 3.4 Migraciones

`20260718010000_f10_1_portal_identity` -- 100% aditiva.

### 3.5 Decisión de seguridad documentada (la más importante de F10)

Un rol de portal JAMÁS recibe un permission key que gatee un endpoint interno sin ownership filtering (`workers.view`, `assignments.view`, `timeEntries.view`, `documents.view`, `companies.view`, `candidates.view`, `contacts.view`, `shifts.*`, `incidents.*`). Esto se verifica automáticamente en cada subfase siguiente: cualquier permiso nuevo que se le agregue a un rol de portal en el seed debe ser un recurso `portal*`/`clientJobs`/`notifications`/`auditLogs`, nunca uno de la lista anterior -- el test `portal-identity.test.ts` fallaría inmediatamente si esto se rompe.

### 3.6 Commit

`feat: F10.1 — portal roles and permissions`.

**F10.1 completo.**

## 4. Resultado de F10.2 — Client Portal

### 4.1 Implementado

- **Backend** (`apps/api/src/modules/portal/`, nuevo módulo standalone): `client-service.ts` (dashboard, job orders list/detail, shortlist con DTO safo de datos internos, placements, assignments, workers roster, time entries pendientes + approve/reject reutilizando la transición ya probada de F9.6, incidents) + `router.ts` montado en `/api/v1/portal/client/*`. TODA función exige `ctx.companyId` y filtra explícitamente por esa Company -- nunca confía en un id del query/path sin verificar ownership primero (404, nunca 403, cuando el recurso pertenece a otra Company -- no confirma su existencia).
- **Frontend**: `PortalShell`/`PortalSidebar`/`PortalTopbar` (shell visualmente distinguible del backoffice interno, sin las secciones internas de CRM/Pricing/Agentes/Settings) + `ClientPortalGate` (redirige fuera a quien no tenga `companyId`) + `App.tsx` extendido (redirige automáticamente a `/portal/client` a quien SÍ lo tenga). 6 páginas reales: Dashboard, Job Orders (lista + detalle con shortlist), Workers, Assignments, Time Entries (con aprobar/rechazar gateado por `portalTimeEntries.update`), Incidents.
- **DTO de shortlist deliberadamente reducido**: solo `candidateId`/`candidateName`/`rank`/`reviewStatus`, nunca `score`/`reasons`/`gaps`/`risks` (lógica interna de scoring) -- y solo entradas `READY_FOR_REVIEW`/`APPROVED`/`HOLD` (nunca `DRAFT`, todavía en trabajo interno, ni `REMOVED`, descartada internamente).

### 4.2 Tests nuevos

`client-portal.test.ts` (14 tests de integración): RBAC 403 para un rol interno; dashboard con conteos reales; **IDOR real dentro del MISMO tenant** verificado explícitamente (company-01 nunca ve el Job Order de company-03, ni por listado ni por ID directo, ni su shortlist -- 404 nunca 403); shortlist nunca expone score/reasons/gaps/risks ni entradas DRAFT/REMOVED; assignments/workers/time-entries/incidents todos scoped; CLIENT_MANAGER (sin `portalTimeEntries.update`) recibe 403 al intentar aprobar horas; tenancy real entre tenant-titan/tenant-acme verificada dos veces (listado y acceso directo por ID).

Bug de test (no de producción) encontrado y corregido durante la propia verificación: mis fixtures asumían `joborder-01` pertenecía a `company-01` -- confirmado por consulta directa a la base de dev que en realidad pertenece a `company-03` (y `joborder-02` a `company-04`); el único Job Order real de `company-01` es `joborder-03`. Corregido el test, cero cambio de código de producción -- el código ya estaba filtrando correctamente, la prueba tenía el fixture equivocado.

### 4.3 Suite completa

1203 tests, 1197 pass, 1 fail preexistente sin relación (`prospecting.test.ts`), 5 skip -- cero regresiones. Typecheck/lint/build limpios en `apps/web`. Verificación visual manual con capturas reales contra los dev servers: Dashboard con conteos reales (1 Job Order abierto, 2 Assignments activas), listado y detalle de Job Order con datos reales, cero errores de consola.

### 4.4 Migraciones

Ninguna -- F10.2 es 100% wiring sobre modelos ya existentes (JobOrder/CandidateShortlistEntry/Placement/Assignment/TimeEntry/OperationalIncident, todos de F5-F9).

### 4.5 Limitaciones conocidas / diferido a otra subfase

- Sin "operational reports" en el Client Portal -- decisión deliberada: los reportes agregados tenant-wide de F9.11 usan nombres/métricas internas, exponerlos a un cliente externo requeriría un rediseño completo de esa vista que no fue pedido explícitamente; se documenta como fuera de alcance en vez de exponer datos internos por default.
- Sin Notifications ni Audit Trail en el Client Portal todavía -- son F10.8/F10.9 explícitamente, se integran ahí para no mezclar subfases (el nav ya reserva los recursos de permiso `notifications`/`auditLogs` desde F10.1).
- Sin e2e dedicado a F10.2 -- F10.11 ("End-to-End Portal Tests") es la subfase designada para la suite e2e que cubre todos los portales juntos (roles/tenancy/flujos), evita fragmentar la cobertura en 10 archivos e2e separados.

### 4.6 Commit

`feat: F10.2 — client portal`.

**F10.2 completo.**

## 5. Resultado de F10.3 — Client Job Request

### 5.1 Implementado

- **Modelo nuevo** `ClientJobRequest` (100% aditivo, migración `20260718020000_f10_3_client_job_request`) + enum `ClientJobRequestStatus` (8 valores). Relación 1:1 opcional a `JobOrder` (`convertedJobOrderId`, único) -- nunca infiere `categoryId`/`billRate`/`payRate` en el modelo, esos son decisiones internas explícitas al momento de convertir.
- **Grafo de transiciones puro** (`portal/client-job-request-rules.ts`): `DRAFT→SUBMITTED→UNDER_REVIEW→{NEEDS_INFORMATION,APPROVED,REJECTED}`, `NEEDS_INFORMATION` vuelve a `SUBMITTED` (nunca directo a `UNDER_REVIEW`), `CANCELLED` alcanzable desde cualquier estado no decidido, `APPROVED→CONVERTED_TO_JOB_ORDER` es la única vía de conversión (nunca automática).
- **Servicio lado cliente** (`client-job-request-service.ts`): create/list/get/update/submit/cancel, todo con el mismo patrón de ownership de F10.2 (`ctx.companyId`, 404 nunca 403). Solo editable en `DRAFT`/`NEEDS_INFORMATION`.
- **Servicio lado interno** (`internal-job-request-service.ts`): list/get tenant-wide (para revisión), `reviewClientJobRequest` (transición a los 4 estados de revisión real), `convertToJobOrder` -- reutiliza `createJobOrder` (jobs/service.ts, F5.1) sin duplicar su lógica, exige `categoryId`/`billRate`/`payRate` explícitos del reviewer, el JobOrder resultante nace en `DRAFT` como cualquier otro (nunca se auto-activa).
- **Frontend cliente**: `JobRequests.tsx` (lista + drawer de creación) + `JobRequestDetail.tsx` (ver/enviar/cancelar, edición inline pendiente de una fase futura si se pide -- por ahora la creación captura los campos mínimos, la edición completa de todos los campos no fue crítica para el flujo).
- **Frontend interno**: `ClientJobRequests.tsx` (lista con filtro de estado, nueva sección "Client Requests" en el Sidebar interno) + `ClientJobRequestDetail.tsx` (formulario de revisión + formulario de conversión con selector real de Job Category).

### 5.2 Tests nuevos

`client-job-request-rules.test.ts` (7, puro) + `client-job-request.test.ts` (17 de integración): RBAC 403 en ambos lados (cliente sin `clientJobs.create`, interno sin `clientJobs.approve`); CLIENT_MANAGER puede crear/enviar pero no editar/cancelar (verificado explícito); ownership/tenancy (una Company nunca ve la solicitud de otra, ni siquiera por tenancy cruzada); edición bloqueada fuera de DRAFT/NEEDS_INFORMATION; ciclo completo de revisión incluyendo el rebote NEEDS_INFORMATION→SUBMITTED con edición real en el medio; conversión exige APPROVED primero; conversión real crea un JobOrder DRAFT real con los rates/categoría exactos pasados, nunca inferidos; AuditLog verificado en las 4 acciones sensibles (created/submitted/reviewed/converted).

Verificación adicional en navegador real (Playwright ad-hoc): flujo completo cliente crea+envía → interno revisa, cero errores de consola, datos reales visibles en ambos shells.

### 5.3 Suite completa

1220 tests, 1214 pass, 1 fail preexistente sin relación, 5 skip -- cero regresiones. Typecheck/lint/build limpios en `apps/api` y `apps/web` (un error real de lint atrapado y corregido durante la propia verificación: `Date.now()` llamado directamente en un inicializador de `useState` viola la regla `react-hooks/purity` -- corregido con el inicializador perezoso `useState(() => ...)`, mismo patrón ya usado en `CreatePayrollRunForm`).

### 5.4 Migraciones

`20260718020000_f10_3_client_job_request` -- 100% aditiva.

### 5.5 Limitaciones conocidas

- El formulario de creación del cliente captura los campos mínimos (`requestedTitle`/`headcount`/`desiredStartDate`/`notes`); el resto de los campos del modelo (`shift`/`schedule`/`requiredSkills`/`certifications`/`languageRequirements`/`physicalRequirements`/`payRateExpectation`/`billBudget`) existen en el backend y se muestran en el detalle, pero no tienen UI de edición todavía -- se puede extender sin migración si se pide explícitamente.
- Sin notificación real al cliente cuando su solicitud cambia de estado -- eso es F10.8 (Notifications Center), se integra ahí.

### 5.6 Commit

`feat: F10.3 — client job requests`.

**F10.3 completo.**

## 6. Resultado de F10.4 — Candidate/Worker Portal

### 6.1 Implementado

- **Backend**: `worker-service.ts` (`ctx.workerId`) y `candidate-service.ts` (`ctx.candidateId`), mismo patrón de ownership de F10.2/F10.3. Ninguno de estos endpoints acepta un `:id` en la URL -- son intrínsecamente auto-scoped, sin superficie de IDOR vía manipulación de path (a diferencia de los endpoints `:id` del Client Portal).
- **Redacción explícita para el Candidate Portal**: `listCandidateApplications` nunca expone `rank`/`score`/`normalizedScore`/`reasons`/`gaps`/`risks`/`evidence`/`explanation` (lógica interna de scoring, y `rank` revelaría posición frente a otros candidatos -- prohibido explícito del PO) -- solo `qualificationStatus` + `shortlistReviewStatus`. Solo se listan matches `QUALIFIED`/`POSSIBLY_QUALIFIED` -- un `NOT_QUALIFIED` nunca aparece como "aplicación".
- **Refactor de `PortalShell`/`PortalSidebar`**: parametrizados con `items`/`portalLabel` en vez de triplicar el shell -- reutiliza el 100% de la infraestructura visual de F10.2 para los 3 tipos de portal.
- **`App.tsx`** extendido: redirige automáticamente `workerId`→`/portal/worker`, `candidateId`→`/portal/candidate` (además del `companyId`→`/portal/client` ya existente de F10.2).
- **10 páginas nuevas**: Worker Portal (Profile, Onboarding, Documents, Assignments, Time Entries de solo lectura, Incidents) + Candidate Portal (Profile, Applications, Onboarding, Documents).

### 6.2 Tests nuevos

`worker-candidate-portal.test.ts` (11 de integración): RBAC 403 para un rol interno en ambos portales; el caso específico de que `CLIENT_ADMIN` (que SÍ tiene `portalProfile.view`) igual recibe 403 en `/portal/worker/*` porque `ctx.workerId` no existe -- confirma que el permission-check por sí solo no alcanza, el ownership-check es la segunda capa real; contenido real de `worker-01`/`candidate-029` verificado; todos los sub-recursos devuelven la forma esperada; **verificación exhaustiva de que `/portal/candidate/applications` nunca expone las 8 llaves internas de scoring**; solo se muestran calificaciones `QUALIFIED`/`POSSIBLY_QUALIFIED`; un WORKER nunca puede resolver un `candidateId` (ni viceversa).

Verificación visual en navegador real (Playwright ad-hoc): Worker Portal y Candidate Portal renderizan con datos reales (`Valeria Mendoza`, `worker-01`; `Daniela Ortiz`, `candidate-029`), shells visualmente distintos entre sí y del backoffice interno, cero errores de consola.

### 6.3 Suite completa

1231 tests, 1225 pass, 1 fail preexistente sin relación, 5 skip -- cero regresiones (una corrida intermedia mostró 2 fallas transitorias no reproducibles, mismo patrón de flakiness ya documentado en F9.8 -- una segunda corrida limpia lo confirmó). Typecheck/lint/build limpios en `apps/web`.

### 6.4 Migraciones

Ninguna -- F10.4 lee exclusivamente modelos ya existentes (WorkerOnboarding/DocumentChecklistItem/Placement/Assignment/Shift/TimeEntry/OperationalIncident/CandidateMatch/CandidateShortlistEntry, todos de F8/F9).

### 6.5 Limitaciones conocidas

- Perfil de solo lectura -- la edición real (F10.5, Profile and Document UX) llega en la siguiente subfase, deliberadamente.
- Time Entries de solo lectura en el Worker Portal -- crear/enviar horas propias es F10.7 (Time Entry UX), subfase dedicada.
- Sin preview de screening/entrevista en el Candidate Portal -- decisión conservadora: redactar esos datos de forma segura (sin exponer `rationale`/`expectedEvidence` de `ScreeningPlan`, lógica interna) exigiría más diseño del que se pidió explícito para F10.4; se documenta como diferido, no se expone información sin la redacción correcta.

### 6.6 Commit

`feat: F10.4 — candidate and worker portal`.

**F10.4 completo.**

## 7. Resultado de F10.5 — Profile and Document UX

### 7.1 Auditoría previa

Confirmado por auditoría: ningún campo self-service editable existía más allá de `phone`/`city`/`state`/`languages` (ya de solo lectura desde F10.4); `Document.fileUrl` siempre fue un `String?` de texto libre, sin ningún endpoint real de upload de bytes en todo el proyecto. `DocumentChecklistItem.documentId → Document?` ya existía desde F9.2 pero nunca se había usado -- el vínculo real entre "seguimiento de checklist" y "archivo real" estaba modelado pero sin ningún caller.

### 7.2 Modelos y migraciones

Aditivo únicamente: `Candidate.availabilityNotes String?` y `Candidate.skills String[] @default([])` (migración `20260718030000_f10_5_profile_self_service`, verificada con `prisma migrate diff` -- solo `ADD COLUMN`). Viven en `Candidate` (no en `Worker`) porque tanto `worker-service.ts` como `candidate-service.ts` ya hacen join a `Candidate`, así que un solo punto de adición sirve a ambos portales sin duplicar el campo.

### 7.3 DocumentStorageAdapter

`apps/api/src/core/document-storage/{adapter.ts, local-mock.provider.ts}` -- interfaz desacoplada (mismo patrón que `AuthProvider`, F0/F4.9) con una única implementación mock hoy: nunca toca disco/red, genera una referencia `mock://pending-storage-adapter/<uuid>/<filename-sanitizado>`, marcada explícitamente `status: "pending"`. Cuando exista un proveedor real, se agrega una segunda implementación sin tocar ningún módulo de negocio.

### 7.4 Backend

- `updateWorkerProfile`/`updateCandidateProfile`: whitelist estricta (`phone`, `city`, `state`, `languages`, `availabilityNotes`, `skills`) -- nunca `employmentType`/`defaultPayRate`/`status`/`complianceStatus`/`yearsExperience`/`aiScore` (juicio interno). Router valida tipos (arrays de strings) antes de llegar al service. AuditLog en cada update (`portal.worker_profile_updated`/`portal.candidate_profile_updated`).
- `submitWorkerDocument`/`submitCandidateDocument`: valida ownership (404, no 403, si el `DocumentChecklistItem` no pertenece a la identidad actual -- mismo criterio IDOR de F10.1-F10.4), valida la transición vía `isValidChecklistItemTransition(from, "SUBMITTED")` (el grafo de F9.2 solo permite esa transición desde `PENDING`), crea un `Document` real (`fileUrl` = referencia mock, `status: PENDING_REVIEW`) y lo enlaza vía `DocumentChecklistItem.documentId` -- **bug propio detectado y corregido antes de testear**: la primera versión escribía la referencia mock en `DocumentChecklistItem.source`, pisando su significado original de F9.2 ("cómo se originó este item", texto libre tipo `"agent_extracted"`); la versión corregida usa `source: "worker_upload"`/`"candidate_upload"` (un valor de ese mismo vocabulario) y deja la referencia de storage donde siempre debió vivir: `Document.fileUrl`, enlazado vía `documentId`. AuditLog en cada submit (`portal.worker_document_submitted`/`portal.candidate_document_submitted`).
- Rutas nuevas: `PATCH /portal/worker/profile` y `PATCH /portal/candidate/profile` (gateadas por `portalProfile.update`), `POST /portal/worker/documents/:id/submit` y `POST /portal/candidate/documents/:id/submit` (gateadas por `portalDocuments.update`, una llave nueva -- `portalDocuments.view` no implica poder escribir). `ROLE_PERMISSIONS.WORKER`/`.CANDIDATE` (seed) extendidos con `portalDocuments.update`.

### 7.5 Frontend

`ProfileEditForm`/`SubmitDocumentDrawer` (`apps/web/src/pages/portal/shared/`) -- compartidos entre Worker y Candidate Portal (mismo shape editable exacto), evita duplicar el formulario dos veces. `WorkerProfilePage`/`CandidateProfilePage` ahora incluyen el formulario editable junto a la vista de solo lectura existente. `WorkerDocumentsPage`/`CandidateDocumentsPage` agregan un botón "Enviar" solo visible en items `PENDING`, que abre un `Drawer` con `SubmitDocumentDrawer` -- deliberadamente NO es un file picker real (etiqueta explícita "Almacenamiento de archivos real pendiente de integración" visible en la UI), solo captura `fileName`/`notas`.

### 7.6 Tests nuevos

- `local-mock.provider.test.ts` (3): prefijo `mock://` garantizado, sanitización de nombre de archivo, unicidad por llamada.
- `profile-document-ux.test.ts` (12, integración vía HTTP real): 403 sin `portalProfile.update`/`portalDocuments.update`; update persiste solo los campos whitelisted; campos internos (`status`, `yearsExperience`) ignorados silenciosamente aunque se envíen; 400 si `languages`/`skills` no son arrays; el update del candidato nunca toca la fila de otro candidato; 404 (no 403) al intentar enviar el checklist item de otra identidad; 400 en una transición inválida (`VERIFIED`→`SUBMITTED`); submit exitoso crea un `Document` real con `fileUrl` `mock://`, lo enlaza vía `documentId`, y genera AuditLog.

### 7.7 Suite completa

1246 tests, 1240 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, depende de OpenAI real), 5 skip -- cero regresiones. Typecheck/lint/build limpios en `apps/api` y `apps/web`.

### 7.8 Verificación visual

Playwright ad-hoc contra los dev servers ya corriendo (no se relanzaron): Worker Portal -- edición de perfil persiste y se refleja de inmediato (`Chicago`, `555-0199`, skills, disponibilidad), envío de un documento `PENDING` transiciona visualmente a `Submitted` con toast de confirmación. Candidate Portal -- mismo flujo de edición de perfil confirmado. Cero errores de consola en las 4 páginas. Fixture temporal (`WorkerOnboarding`/`DocumentChecklistItem` para `worker-01`/`candidate-029`, que no tenían checklist real seedeado) creada y eliminada después de verificar; los campos de `Candidate` mutados durante la verificación manual fueron restaurados a su estado determinístico de seed.

**Higiene de datos de prueba**: se detectó que la primera versión de `profile-document-ux.test.ts` solo restauraba `availabilityNotes`/`skills` en su `after()`, dejando `phone`/`city` mutados permanentemente en la persona seed compartida `candidate-034` (worker-01). Corregido: el `before()` ahora captura el estado original completo (`phone`/`city`/`state`/`languages`/`availabilityNotes`/`skills`) y el `after()` lo restaura exacto, en vez de asumir `null`.

### 7.9 Deuda/observaciones (no bloqueantes para F10.5)

- **Inconsistencia de seed pre-existente (F10.1, no introducida por F10.5)**: el `User` de portal `candidate-portal@titan.dev` tiene su propio `firstName`/`lastName` ("Daniela Ortiz") distinto del `Candidate` real al que apunta (`candidate-029` = "Jordan Taylor"). El topbar muestra el nombre del `User`; la página de perfil muestra correctamente el nombre del `Candidate` real (dato correcto, fuente de verdad). Cosmético, no afecta autorización ni tenancy -- diferido, no se toca en F10.5 (tocar identidad de seed es territorio de F10.1).

### 7.10 Commit

`feat: F10.5 — profile and document experience`.

**F10.5 completo.**

## 8. Resultado de F10.6 — Assignment and Schedule UX

### 8.1 Incidente operativo durante esta subfase (reportado y resuelto)

Al verificar que la migración de F10.6 fuera puramente aditiva con `prisma migrate diff --shadow-database-url`, se pasó por error la MISMA `DATABASE_URL` de desarrollo como `--shadow-database-url` (en vez de una base descartable separada). Prisma reinicializa cualquier base que reciba como "shadow" para reproducir el historial de migraciones -- al apuntar accidentalmente a la base real, esto vació TODAS las filas de TODAS las tablas (el esquema/34 tablas quedó intacto, cero pérdida de estructura). Reportado de inmediato al usuario antes de tomar cualquier acción de recuperación (ver sección "riesgo de pérdida de datos" de la autorización de F10 -- bloqueo genuino explícitamente permitido). Con autorización del usuario: 1) se re-generó `_prisma_migrations` marcando las 33 migraciones existentes como aplicadas (`prisma migrate resolve --applied`, sin re-ejecutar SQL, ya que las tablas ya existían); 2) se re-corrió `prisma/seed.ts` (idempotente, ya usado varias veces en esta sesión) para reconstruir el 100% de los datos sintéticos (tenants, companies, candidates, workers, users, portal personas, JobOrders, Assignments); 3) se confirmó el estado restaurado exacto (conteos, valores determinísticos de F10.5) contra el estado documentado antes del incidente; 4) se corrió la suite completa (1246→1258 tests con las nuevas de F10.6, mismo resultado limpio). Ningún dato real de producción existía en este entorno -- 100% seed sintético de desarrollo. Lección aplicada: nunca volver a pasar `DATABASE_URL` como `--shadow-database-url`; para verificar diffs de ahora en más, usar exclusivamente el flag `--script` contra el historial de migraciones sin `--shadow-database-url`, o una base explícitamente descartable.

### 8.2 Modelos y migraciones

Nuevo modelo `ScheduleChangeRequest` (aditivo, migración `20260718040000_f10_6_schedule_change_request`, verificada vía `prisma migrate diff` -- solo `CREATE TYPE`/`CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT`) -- el mecanismo exacto que pide la spec: "Solicitudes de cambios quedan como request/acción pendiente de aprobación", nunca una mutación directa de `Assignment`/`Shift`. Campos: `requestType`/`requestedChange` texto libre (mismo criterio ya aprobado para `DocumentChecklistItem.source`/`Payment.method`), `status` (`PENDING`/`APPROVED`/`REJECTED`), `reviewedById`/`reviewNotes`. Agregado a `STRICT_TENANT_MODELS`.

### 8.3 Backend

- `listWorkerAssignments` (worker-service.ts) enriquecido con `location`/`shiftType`/`scheduleNotes` (de `JobOrder`, F5.1, ya existían pero nunca se exponían acá) y `supervisorName` (resuelto desde `Project.supervisorContactId` -- campo sin relación Prisma directa desde F5.4, resuelto con un segundo query batched a `Contact`). Nunca expone `billRate`/`payRate`/margen -- verificado por test explícito.
- `listWorkerShifts` extendido con `breakMinutes` (ya existía en `Shift`, F9.6, nunca expuesto al portal).
- `listWorkerIncidents` extendido con `assignmentId` para permitir filtrar "incidents relacionados" por Assignment en el frontend.
- `requestScheduleChange`/`listWorkerScheduleChangeRequests` (worker-service.ts): el Worker SOLO puede crear un `ScheduleChangeRequest` -- ownership verificado (404, no 403, si el Assignment no es suyo, mismo criterio IDOR del resto de F10). Nunca toca `Assignment.status`/`Shift` directamente -- verificado por test explícito ("never mutates the Assignment").
- `listScheduleChangeRequests`/`reviewScheduleChangeRequest` (modules/assignments/service.ts, F9.5): revisión INTERNA -- reutiliza deliberadamente las llaves internas ya existentes `assignments.view`/`assignments.update` (a diferencia de los recursos `portal*` de F10.1, esto es un endpoint interno, así que reusar la llave existente es correcto, no crea riesgo de IDOR para roles de portal). No permite revisar una solicitud que ya no está `PENDING` (idempotencia de la decisión, nunca una segunda revisión silenciosa).
- Nueva llave de permiso `portalAssignments.create` agregada solo a `WORKER` (crear una solicitud, nunca mutar el Assignment).

### 8.4 Frontend

- `WorkerAssignmentsPage`: tabla clickeable → `Drawer` de detalle con ubicación/turno/supervisor/fechas/instrucciones, turnos programados (con breaks/timezone), incidents relacionados, historial de solicitudes propias, y un formulario para crear una nueva solicitud (`RequestScheduleChangeForm`) -- sin ningún control para activar/pausar/completar/cancelar el Assignment (deliberadamente ausente, cumple la prohibición explícita de la spec).
- Nueva página interna `ScheduleChangeRequests.tsx` (ruta `/schedule-change-requests`, agregada al Sidebar bajo "Operations" junto a Assignments) -- lista con filtro por estado y botones Aprobar/Rechazar inline para el personal interno con `assignments.update`.

### 8.5 Tests nuevos

`assignment-schedule-ux.test.ts` (12, integración vía HTTP real): enriquecimiento de campos verificado contra el Assignment real de `worker-01` (`assignment-01`); `breakMinutes` presente en shifts; 403 sin `portalAssignments.create`; 404 (no 403) al pedir un cambio sobre el Assignment de OTRO worker; 400 sin `requestedChange`; creación exitosa confirmada como PENDING + AuditLog + Assignment.status sin cambios; el listado propio filtra correctamente por `assignmentId`; 403 interno sin `assignments.view`/`assignments.update`; 400 en un status de revisión inválido; aprobación exitosa con AuditLog, y una segunda revisión sobre una solicitud ya decidida es rechazada con 400.

### 8.6 Suite completa

1258 tests, 1253 pass, 0 fail (la falla conocida de `prospecting.test.ts`, dependiente de OpenAI real, no se manifestó en esta corrida -- comportamiento intermitente ya documentado, no una regresión), 5 skip. Typecheck/lint/build limpios en `apps/api` y `apps/web`.

### 8.7 Verificación visual

Playwright ad-hoc: Worker Portal -- click en un Assignment abre el detalle con datos reales (`Apprentice Electricians — Commercial Build`, `Lakeshore Electrical Contractors`, `Chicago, IL`, turno `Day`), formulario de solicitud envía y refleja `Pending` de inmediato con toast de confirmación. Vista interna -- la solicitud aparece con el nombre real del Worker (`Valeria Mendoza`) y del Job Order resueltos correctamente; aprobarla la remueve del filtro "Pending" con toast de confirmación. Cero errores de consola. Artefacto de verificación (`ScheduleChangeRequest` de prueba) eliminado de la base después de confirmar.

### 8.8 Commit

`feat: F10.6 — assignment and schedule experience`.

**F10.6 completo.**

## 9. Resultado de F10.7 — Time Entry UX

### 9.1 Decisión de arquitectura: reutiliza el lifecycle de F9.6/F5.6 completo, sin duplicarlo

Auditoría previa confirmó que `TimeEntry` (F5.6, extendido F9.6) YA modela exactamente el ciclo de vida pedido por la spec (`DRAFT→SUBMITTED/NEEDS_REVIEW→APPROVED/REJECTED→LOCKED`, `REJECTED` siempre reabre a `DRAFT`) y ya tiene `createTimeEntry`/`updateTimeEntry`/`submitTimeEntry`/`rejectTimeEntry`/`reopenTimeEntry` completamente construidos y probados (payroll/service.ts) -- exactamente el mismo patrón de reuso ya usado por F10.2 (`approveClientTimeEntry`/`rejectClientTimeEntry` delegan a estas mismas funciones). F10.7 NO reescribe esa lógica: `worker-service.ts` agrega una capa fina de ownership (Assignment pertenece al Worker actual, 404 si no) + conversión de hora inicio/fin/break (lo que el Worker realmente ingresa) a `regularHours` (lo único que `TimeEntry` almacena) antes de delegar.

`computeRegularHoursFromRange` reutiliza `computeShiftScheduledHours` (F9.6, misma aritmética HH:MM/cruce-de-medianoche ya usada para la duración programada de un Shift) -- decisión conservadora: nunca se duplica la fórmula, nunca se agregan columnas `startTime`/`endTime` nuevas a `TimeEntry` (el modelo ya decidió en F5.6/F9.6 almacenar horas totales, no marcas de tiempo). "Validar end>start" se interpreta como rechazar duración cero (`startTime === endTime`) -- un turno nocturno real que cruza medianoche (`endTime < startTime`) se sigue permitiendo, mismo criterio ya establecido para `Shift` (no se inventa una restricción que rompería turnos nocturnos reales, varios ya seedeados con `shiftType: NIGHT`). "Validar timezone" se satisface mostrando el timezone del Shift ya visible en el detalle de Assignment (F10.6) -- no se agrega una columna de timezone redundante a `TimeEntry`.

### 9.2 Deuda corregida en el camino (F9.6/F5.6, no F10.7 en sí)

`notes` existía como columna en `TimeEntry` desde F0 pero ningún input schema la exponía todavía (`createTimeEntryInputSchema`/`updateTimeEntryInputSchema` no la declaraban) -- "agregar una nota" (spec F10.7) es el primer caller real. Agregada de forma aditiva a ambos schemas + `timeEntryListItemSchema` (packages/shared) + `toListItem` (payroll/service.ts). Cambio mínimo, estrictamente necesario para F10.7, documentado acá en vez de abrir una reescritura general de F9.6.

### 9.3 Backend

- `createWorkerTimeEntry`/`updateWorkerTimeEntryDraft`/`submitWorkerTimeEntry`/`reopenWorkerTimeEntry` (worker-service.ts): ownership verificado (404, no 403) antes de delegar a `payrollService`; edición solo mientras `DRAFT` (mismo criterio F5.6); `startTime`/`endTime` deben venir SIEMPRE en par (nunca uno solo); `breakMinutes` sin par de horas es rechazado (no hay forma de recalcular sin ambos extremos, ya que no se persisten). AuditLog en cada acción (`portal.worker_time_entry_created/updated/submitted/reopened`).
- `listClientPendingTimeEntries` (client-service.ts, F10.2) extendida con `overtimeFlag`/`discrepancyFlag`/`discrepancyNotes`/`notes` -- el cliente que aprueba/rechaza ahora ve el mismo contexto que el Worker generó, nunca una caja negra.
- Endpoints nuevos: `POST/PATCH /portal/worker/time-entries[/:id]`, `POST /portal/worker/time-entries/:id/submit`, `POST /portal/worker/time-entries/:id/reopen` -- gateados por `portalTimeEntries.create`/`.update` (llaves ya existentes en `ROLE_PERMISSIONS.WORKER` desde F10.1, sin cambios de permisos necesarios).

### 9.4 Frontend

- `WorkerTimeEntriesPage` reescrita: tabla con badge de overtime (⚠ "OT", nunca una decisión legal, solo advertencia visual) y nota de discrepancia visible en línea; botón "Nuevo borrador" (Drawer con hora inicio/fin/break/nota); "Editar" solo visible en `DRAFT` (Drawer con guardar-borrador + enviar); "Corregir y reenviar" solo visible en `REJECTED` (reabre a `DRAFT` automáticamente y abre el editor).
- `ClientTimeEntries.tsx` (F10.2) actualizada con el mismo badge de overtime + nota de discrepancia + nota del Worker, visible antes de aprobar/rechazar.

### 9.5 Tests nuevos

`time-entry-ux.test.ts` (12, integración vía HTTP real): 403 sin `portalTimeEntries.create`; 404 (no 403) sobre el Assignment de otro Worker; 400 en duración cero y en `startTime` malformado; creación real con `regularHours` calculado correctamente desde hora inicio/fin/break (verificado con aritmética exacta) y nota persistida; 409 en fecha duplicada (constraint ya existente de F5.6); 404 al editar el TimeEntry de otro Worker; edición válida solo en `DRAFT`; 400 al enviar `startTime` sin `endTime`; submit exitoso y confirmación de que un `SUBMITTED` deja de ser editable; **ciclo completo reject→reopen→edit→resubmit** (rechazo vía endpoint interno ya probado en F9.6, reopen exclusivo del Worker dueño, 403 para un rol interno intentando reabrir, 400 al reabrir algo que no es `REJECTED`); confirmación final de que el listado del Worker refleja la nota corregida.

### 9.6 Suite completa

1270 tests, 1265 pass, 0 fail, 5 skip -- cero regresiones. Typecheck/lint/build limpios en `apps/api` y `apps/web`.

### 9.7 Verificación visual

Playwright ad-hoc: creación de un borrador con hora 08:00-16:30/break 30min calculó correctamente 8h regulares, nota visible en la tabla; "Editar" abrió el Drawer con guardar/enviar; "Enviar" transicionó visualmente `Draft`→`Submitted` con toast de confirmación, sin discrepancia (coincide con el Shift programado). Cero errores de consola. Artefacto de verificación (`TimeEntry` de prueba, fecha 2026-09-01) eliminado de la base después de confirmar.

### 9.8 Limitación conocida (pre-existente, no introducida por F10.7)

Las fechas mostradas vía `new Date(isoDateString).toLocaleDateString()` pueden desplazarse un día según el timezone del navegador (parseo UTC de una fecha-only ISO, renderizado en hora local) -- mismo patrón ya presente en `JobRequests.tsx`/`ClientJobRequests.tsx` y otras páginas desde F10.2/F10.3, no un bug nuevo de esta subfase. Fuera de alcance corregirlo acá (tocaría múltiples páginas ya existentes fuera del límite de F10.7); queda como deuda técnica general, no atribuible a F10.

### 9.9 Commit

`feat: F10.7 — worker time entry experience`.

**F10.7 completo.**
