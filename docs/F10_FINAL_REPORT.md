# F10 — Client and Worker Portals — Final Report

Estado global: **COMPLETE** (F10.1 a F10.11, más la fase previa de deuda de F9). Ninguna subfase declarada COMPLETE sin backend real, autorización backend, aislamiento de tenant, UI funcional, tests, y (donde aplica) e2e.

## 1. Resumen ejecutivo

F10 construyó tres portales reales (Client, Worker, Candidate) sobre la plataforma interna existente (F0-F9), extendiendo el modelo `User` con identidad de portal (`companyId`/`workerId`/`candidateId`) en vez de crear un sistema de autenticación paralelo. Se implementó una matriz RBAC completa con 8 roles (4 internos representativos + CLIENT_ADMIN/CLIENT_MANAGER/WORKER/CANDIDATE), un vocabulario de permisos `portal*` deliberadamente separado del vocabulario interno para prevenir IDOR, y verificación de ownership en dos capas (permiso + pertenencia real) en cada endpoint de portal. Se resolvió la deuda de F9 que bloqueaba F10 (gap de `PAUSED` en matching availability). Se construyeron 11 subfases completas: roles/permisos, portal de cliente, solicitudes de personal, portal de worker/candidato, edición de perfil y documentos, vista de assignments/horarios con solicitudes de cambio, registro de horas, centro de notificaciones, audit trail scoped, pase de accesibilidad/responsive, y cobertura e2e real. Durante la sesión ocurrió un incidente real de pérdida de datos (F10.6, ver §24) causado por un uso incorrecto de `prisma migrate diff --shadow-database-url`, reportado de inmediato y recuperado sin pérdida real (datos 100% sintéticos de seed). F10.11 encontró y corrigió 3 bugs reales mediante testing e2e genuino contra navegador real.

## 2. Punto de partida

F9 cerrado y aprobado provisionalmente (commit `c07c5eb`). `AUTH_MODE=dev-bypass` único modo funcional; Clerk implementado pero dormido (F4.9, nunca tocado en F10). Un solo tenant sembrado (`tenant-titan`). Ningún concepto de identidad de portal existía -- `User` era exclusivamente personal interno.

## 3. Deuda de F9 resuelta

- **`matching/availability.ts`**: `BLOCKING_ASSIGNMENT_STATUSES` no incluía `PAUSED` (comentario stale desde que F9.5 extendió `AssignmentStatus` a 8 valores) -- corregido, un Worker con Assignment `PAUSED` ya no aparece disponible para nuevo matching. Commit separado `bbcaab9`.
- UI interna de Incidents/Reports (F9.10/F9.11): diferida explícitamente -- fuera de alcance de portales, documentado en `docs/F10_PLAN.md` §1.
- Deuda NO documentada en F9 pero crítica para F10, descubierta en la auditoría previa: ausencia total de identidad de portal, un solo tenant sembrado (sin forma de probar fuga real entre tenants a nivel HTTP) -- ambas resueltas en F10.1.

## 4. Arquitectura de portales

Un portal user es un `User` con exactamente uno de `companyId`/`workerId`/`candidateId` seteado (nunca una tabla paralela). `PortalShell` genérico parametrizado por `items: NavItem[]` + `portalLabel`, usado por los 3 shells de portal. Rutas de portal en una rama separada del router (`/portal/client`, `/portal/worker`, `/portal/candidate`), nunca anidadas bajo el shell interno -- layout visualmente distinguible. `App.tsx` redirige automáticamente según la identidad resuelta (companyId→client, workerId→worker, candidateId→candidate); un usuario con identidad de portal nunca ve el backoffice interno.

## 5. Autenticación

Sin cambios al mecanismo de auth en sí (`DevBypassAuthProvider`, F4.9) -- extendido únicamente para poblar `companyId`/`workerId`/`candidateId` en `ResolvedIdentity`. Clerk permanece exactamente como quedó en F4.9: implementado, dormido, `AUTH_MODE=dev-bypass` sigue siendo el único modo activo. 4 personas deterministas de portal seedeadas (`client-admin@titan.dev`, `client-manager@titan.dev`, `worker-portal@titan.dev`, `candidate-portal@titan.dev`) más una company/tenant secundarios (`tenant-acme`) para probar aislamiento real entre tenants.

## 6. Autorización

Deny by default en todo endpoint de portal (`requirePermission` explícito, ninguna ruta sin gate). Dos capas: (1) permiso RBAC, (2) ownership real verificado en el service contra la tabla real (nunca confiado del `entityId`). Violación de ownership → 404, nunca 403 (no confirma existencia del recurso a quien no tiene acceso). Verificado exhaustivamente con tests IDOR dentro del MISMO tenant (no solo cross-tenant) en cada subfase.

## 7. Matriz RBAC

8 roles cubiertos explícitamente: CEO/Admin (ALL_KEYS), Recruiter/Sales/Operations/Compliance/Payroll/Manager/HR/Accounting/Marketing (matrices internas ya existentes, extendidas solo con `auditLogs.view`/`notifications.*` donde correspondía), CLIENT_ADMIN, CLIENT_MANAGER (subconjunto estricto de CLIENT_ADMIN, verificado por test), WORKER, CANDIDATE (mismo shape de self-service, solo WORKER tiene claves de assignment/time-entry). Ningún rol de portal recibe jamás una de las ~32 claves internas sin scope (`workers.view`, `timeEntries.view`, etc.) -- verificado por test exhaustivo en F10.1.

## 8. Tenancy

`scopedDb` (extensión Prisma, F4/F5) sigue siendo el único punto de acceso a datos tenant-scoped -- ningún query nuevo de F10 lo bypasea. Ownership de recursos portal-scoped resuelto explícitamente por tipo de entidad (nunca inferido). Verificado con HTTP real (no solo `runWithTenancyContext` a nivel Prisma) usando el segundo tenant sembrado en F10.1, incluyendo manipulación directa de URL/ID.

## 9. Roles

Ver §7. Mapeo conservador: ningún rol interno existente fue renombrado o eliminado; los 4 roles de portal son estrictamente nuevos, sin colisión de nombres.

## 10. F10.1–F10.11 (estado por subfase)

| Subfase | Estado |
|---|---|
| Fase previa (deuda F9) | COMPLETE |
| F10.1 Roles and Permissions | COMPLETE |
| F10.2 Client Portal | COMPLETE |
| F10.3 Client Job Request | COMPLETE |
| F10.4 Candidate/Worker Portal | COMPLETE |
| F10.5 Profile and Document UX | COMPLETE |
| F10.6 Assignment and Schedule UX | COMPLETE |
| F10.7 Time Entry UX | COMPLETE |
| F10.8 Notifications Center | COMPLETE (5 de 14 tipos con trigger real wireado -- ver §27) |
| F10.9 Portal Audit Trail | COMPLETE |
| F10.10 Responsive and Accessibility Pass | COMPLETE |
| F10.11 End-to-End Portal Tests | COMPLETE |
| F10.12 Hardening and close | COMPLETE (este documento) |

No se declaró COMPLETE ninguna subfase sin backend real + autorización + aislamiento de tenant + UI funcional + tests.

## 11. Backend

11 módulos nuevos/extendidos: `modules/portal/*` (router + client/worker/candidate/client-job-request/internal-job-request services), `modules/audit/*`, `modules/notifications/*`, `core/document-storage/*`, `core/notifications.ts`, extensiones a `modules/assignments/service.ts` (schedule change requests), `modules/payroll/service.ts` (notes field, notification triggers).

## 12. Endpoints

~51 endpoints nuevos: 45 en `portalRouter` (`/portal/client/*`, `/portal/worker/*`, `/portal/candidate/*`, `/client-job-requests/*`), 3 en `notificationsRouter`, 1 en `auditRouter`, 2 en `assignmentsRouter` (`/schedule-change-requests*`). Todos gateados por `requirePermission`, ninguno público.

## 13. Frontend

3 shells de portal completos (~29 páginas), componentes compartidos nuevos: `PortalShell`/`PortalSidebar`/`PortalTopbar`, `Drawer` (corregido en F10.10), `NotificationBell`/`NotificationsCenter`, `AuditTrail`, `ProfileEditForm`/`SubmitDocumentDrawer` (compartidos worker/candidate), `NotFoundState` (F10.11). Página interna nueva: `ScheduleChangeRequests.tsx`. 2 páginas internas nuevas de F10.3: `ClientJobRequests`/`ClientJobRequestDetail`.

## 14. Modelos

Extendidos: `User` (+companyId/workerId/candidateId), `Candidate` (+availabilityNotes/skills), `Notification` (+recipientRole/entityType/entityId/priority, userId ahora nullable), `NotificationType` (+14 valores). Nuevos: `ClientJobRequest` (+`ClientJobRequestStatus`), `ScheduleChangeRequest` (+`ScheduleChangeRequestStatus`). Ninguno duplica una entidad ya existente -- auditados antes de crear (`Notification` ya existía desde F0, extendido en vez de crear `PortalNotification`).

## 15. Migraciones

5 migraciones nuevas, todas aditivas (`ADD COLUMN`/`CREATE TABLE`/`CREATE TYPE`/`ADD VALUE`/`CREATE INDEX`/`ADD CONSTRAINT` únicamente, verificado por inspección de schema post-aplicación): `20260718010000_f10_1_portal_identity`, `20260718020000_f10_3_client_job_request`, `20260718030000_f10_5_profile_self_service`, `20260718040000_f10_6_schedule_change_request`, `20260718050000_f10_8_notification_center`. Cero `DROP`/`TRUNCATE`/`DELETE` masivo, cero renombrado destructivo, cero `NOT NULL` sin default sobre datos existentes.

## 16. Notificaciones

Canal in-app únicamente (nunca email/SMS). Idempotente por (recipiente, type, entityId) mientras no leída. `recipientRole` restringido a roles internos tenant-wide (nunca un rol de portal, para no cruzar companies). 5 triggers reales wireados: `JOB_REQUEST_SUBMITTED` (→Sales, corregido en F10.11 desde un `Recruiter` incorrecto), `JOB_REQUEST_NEEDS_INFORMATION`, `TIME_ENTRY_APPROVED`/`TIME_ENTRY_REJECTED`, `SCHEDULE_CHANGED`. 9 tipos definidos sin trigger real todavía (ver §27).

## 17. Auditoría

`AuditLog` (F1) usado en cada escritura sensible de F10 sin excepción. 3 niveles de visibilidad nuevos en F10.9: interno (tenant completo, `auditLogs.view`), cliente (acotado a su Company, resuelto por tipo de entidad), Worker/Candidate (`actorId === ctx.userId`, sin superficie de IDOR). `before`/`after`/`ip` nunca expuestos en ningún nivel.

## 18. Seguridad

RBAC deny-by-default + ownership de dos capas en el 100% de endpoints nuevos. IDOR verificado exhaustivamente (mismo tenant Y cross-tenant) a nivel HTTP e2e real (F10.11). CORS sigue abierto (deuda preexistente de F0/F4.9, deliberadamente no tocada -- decisión de despliegue). Rate limiting: no implementado en ningún punto de la plataforma (preexistente, fuera de alcance de F10). CSRF: arquitectura de API stateless con Bearer/dev-bypass header, sin cookies de sesión -- no aplica el vector clásico de CSRF.

## 19. PII

Ningún dato de identificación sensible (SSN, pasaporte, licencia) almacenado en fixtures ni en el `DocumentStorageAdapter` mock (F10.5) -- este último nunca guarda bytes reales, solo una referencia `mock://` explícitamente marcada "pending". Candidate Portal nunca expone scoring interno (`rank`/`score`/`reasons`/`gaps`/`risks`/`evidence`) -- verificado por test exhaustivo de claves prohibidas.

## 20. Accesibilidad

Corregido en F10.10 (no solo documentado): `Drawer` sin trampa de foco/semántica de diálogo (afectaba every drawer desde F10.2) -- agregado `role="dialog"`/`aria-modal`/foco inicial/trampa de Tab/restauración de foco. Toast sin `aria-live` (afectaba cada confirmación desde F10.5). Nav sin `aria-current`. `NotificationBell` con `role="menu"` incorrecto (implicaba semántica no implementada). `LoadingTable` sin `aria-label`.

## 21. Responsive

Bug real corregido en F10.10: los 3 portales no tenían NINGUNA navegación en mobile (`<aside>` simplemente `hidden` por debajo de `md`, sin reemplazo) -- agregado nav off-canvas real con hamburguesa. Bug real corregido en F10.11: `<main>` sin `min-w-0` como hijo `flex-col` permitía que tablas anchas empujaran overflow horizontal real en mobile -- corregido, verificado con diagnóstico DOM completo.

## 22. Tests

Backend: 1283 tests (1278 pass, 1 fallo preexistente no atribuible, 5 skip). Cada subfase agregó su propio archivo de integración HTTP real (nunca solo unit tests aislados): `portal-identity.test.ts` (12), `client-portal.test.ts` (14), `client-job-request.test.ts`/`client-job-request-rules.test.ts` (17+7), `worker-candidate-portal.test.ts` (11+14 tras F10.9), `profile-document-ux.test.ts` (12), `local-mock.provider.test.ts` (3), `assignment-schedule-ux.test.ts` (12), `time-entry-ux.test.ts` (12), `notifications.test.ts` (6), `audit-trail.test.ts` (7).

## 23. E2E

3 archivos Playwright nuevos (47 tests entre nuevos y preexistentes, todos passing salvo la falla preexistente ya documentada): `portal-tenancy.spec.ts` (7), `portal-flows.spec.ts` (8), `portal-responsive.spec.ts` (7), sobre los 7 archivos preexistentes de F4.9-F9.9. Corren contra backend/DB reales (`webServer` de Playwright, nunca mocks de frontend).

## 24. Bugs encontrados

1. **Incidente de pérdida de datos (F10.6)**: `prisma migrate diff --shadow-database-url` apuntado por error a la `DATABASE_URL` principal en vez de una base descartable -- Prisma reinicializó la base real como "shadow", vaciando todas las filas (esquema intacto). Reportado de inmediato al usuario antes de cualquier recuperación (bloqueo genuino explícito de la autorización). Con autorización del usuario: `_prisma_migrations` reconstruida vía `prisma migrate resolve --applied` (sin re-ejecutar SQL), datos 100% sintéticos restaurados vía `prisma/seed.ts` (idempotente). Verificado: suite completa corrida dos veces post-incidente, resultado idéntico al esperado.
2. **`JOB_REQUEST_SUBMITTED` dirigido a un rol sin permiso** (F10.8, encontrado en F10.11): notificaba a `Recruiter`, que nunca tuvo `clientJobs.view`.
3. **6 páginas de portal atascadas en "Cargando…" para siempre ante un error** (encontrado en F10.11): `isLoading || !data` nunca distinguía "falló" de "cargando".
4. **Overflow horizontal real en mobile** (encontrado en F10.11): `<main>` sin `min-w-0` como hijo flex-col.
5. **Higiene de datos de prueba retroactiva** (F10.8): conectar triggers reales a flujos ya probados en F9.6/F10.3/F10.6/F10.7 hizo que esos archivos de test empezaran a generar `Notification` reales sin limpiarlas -- corregido en los 4 archivos afectados.

## 25. Bugs corregidos

Los 5 de §24 -- todos corregidos, no solo documentados, cada uno con test de regresión.

## 26. Fallas preexistentes (no atribuibles a F10)

- `prospecting.test.ts` -- depende de OpenAI real, comportamiento intermitente ya documentado desde antes de F10.
- `job-order-matching.spec.ts` (F6.7) -- confirmado en F10.11 con diagnóstico de red que su falla (`GET /job-orders/joborder-04/matching` → 404) es 100% ajena a F10, reproducible incluso con `--workers=1`.
- `GET /dashboard/audit-log` (F1) sin `requirePermission` -- cualquier usuario autenticado puede ver el audit trail interno completo vía ese endpoint específico. Deliberadamente no tocado en F10.9 (romper ese widget para la mayoría de roles operativos que dependen de él sería una regresión mayor que el hueco de permisos en sí, que predata F10 por varias fases). Documentado como deuda real, no silenciada.
- CORS abierto sin restricción (F0/F4.9).
- Salto de jerarquía `h1`→`h3` en `PageHeader`/`CardTitle` (patrón preexistente en toda la app desde F0).
- Mismo gap de navegación mobile de §21 en el shell INTERNO (Sidebar/Topbar/AppShell, F0/F1) -- F10.10 solo corrigió los 3 shells de portal (superficies nuevas), el interno predata F10.

## 27. Deuda técnica

- 9 de 14 tipos de `NotificationType` sin trigger real wireado todavía (`SHORTLIST_READY`, `DOCUMENT_REQUIRED`, `DOCUMENT_EXPIRING`, `ONBOARDING_BLOCKED`, `ASSIGNMENT_UPDATED`, `INCIDENT_UPDATED`, `COMPLIANCE_ACTION_REQUIRED`, `PLACEMENT_READY`, `SYSTEM_NOTICE`) -- infraestructura completa, agregar uno es una llamada a `emitNotification`/`notifyPortalUsers` sin cambios de arquitectura.
- Inconsistencia cosmética de seed (F10.1): el `User` de `candidate-portal@titan.dev` tiene su propio nombre ("Daniela Ortiz") distinto del `Candidate` real al que apunta ("Jordan Taylor") -- no afecta autorización, solo el nombre mostrado en el topbar vs. la página de perfil.
- `GET /dashboard/audit-log` sin gate de permisos (§26).
- CORS abierto (§26), gap de nav mobile del shell interno (§26), heading skip (§26) -- todas preexistentes, documentadas, no tocadas por decisión conservadora explícita.

## 28. Decisiones pendientes

- Si se retoma F4.9-12 (Clerk real), confirmar que los 3 `AuthProvider` (dev-bypass/Clerk) sigan poblando `companyId`/`workerId`/`candidateId` de forma idéntica.
- Si se decide dar los 9 tipos de notificación restantes triggers reales, definir su recipiente exacto caso por caso (algunos son ambiguos entre notificar al Worker vs. al equipo interno).
- Si se decide cerrar el gap de `/dashboard/audit-log`, decidir si se gatea con `auditLogs.view` (rompe el widget de actividad de IA para la mayoría de roles) o se reduce su payload a algo ya cubierto por un permiso más amplio.

## 29. Limitaciones

- Sin almacenamiento real de documentos -- `DocumentStorageAdapter` es un mock explícito, nunca bytes reales.
- Sin integrador de timeclock real -- Time Entry es 100% manual (draft→submit).
- Sin notificaciones por email/SMS -- solo in-app, por diseño explícito de la spec.
- Sin rate limiting en ningún punto de la plataforma (preexistente).

## 30. Estado real de F10

**COMPLETE.** Backend funcional real, autorización backend real (nunca solo UI), aislamiento de tenant verificado a nivel HTTP real, UI funcional en los 3 portales, tests unitarios/integración/e2e reales pasando, documentación completa (`docs/F10_PLAN.md`, 13 secciones + este reporte). Ningún componente crítico quedó en estado NOT_STARTED o BLOCKED.

## 31. Preparación para F11

La arquitectura de identidad de portal (`User.companyId/workerId/candidateId`), el vocabulario de permisos `portal*`, el patrón de ownership de dos capas, `DocumentStorageAdapter`, y el centro de notificaciones quedan como infraestructura reutilizable. Recomendación: si F11 amplía cualquier portal, seguir exactamente el mismo patrón de auditoría-antes-de-construir + reutilizar-antes-de-duplicar ya aplicado en las 11 subfases de F10.
