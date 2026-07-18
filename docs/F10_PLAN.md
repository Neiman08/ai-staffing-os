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
