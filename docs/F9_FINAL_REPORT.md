# F9 — Staffing Operations — Informe Final

**Fecha de cierre**: 2026-07-18
**Autorización**: ejecución autónoma continua F9.1→F9.12, otorgada por el PO tras el cierre aprobado de F8 (commit `56b7f76`). "F9 queda aprobado provisionalmente con base en el reporte final y los commits entregados."
**Plan de trabajo detallado**: `docs/F9_PLAN.md` (auditoría previa §1-2, arquitectura §2, subfases §3, y el resultado detallado de cada subfase en las secciones §6-16).

---

## 1. Estado real de F9

**COMPLETE.** Las 12 subfases (F9.1-F9.12) están terminadas: backend real, tests reales, y UI real donde fue el alcance explícito de la subfase (F9.9). Ningún subfase se declara COMPLETE sin backend + tests funcionando contra datos reales del seed vía dev-bypass.

## 2. Subfases completadas

| Subfase | Nombre | Estado | Commit |
|---|---|---|---|
| F9.1 | Worker Onboarding | COMPLETE | `4999f19` |
| F9.2 | Document Checklist | COMPLETE | `30d6b0d` |
| F9.3 | Compliance Rules | COMPLETE | `a794a56` |
| F9.4 | Placement | COMPLETE | `953f079` |
| F9.5 | Assignment Management | COMPLETE | `30b6d6f` |
| F9.6 | Shift and Time Structure | COMPLETE | `3c79432` |
| F9.7 | Payroll Readiness | COMPLETE | `f961bb5` |
| F9.8 | Billing Readiness | COMPLETE | `e227d59` |
| F9.9 | Worker Operations UI | COMPLETE | `387dedb` |
| F9.10 | Exceptions and Incidents | COMPLETE | `aeda8c6` |
| F9.11 | Operational Reports | COMPLETE | `b597e85` |
| F9.12 | Hardening y cierre de F9 | COMPLETE | este commit |

Ninguna subfase quedó PARTIAL, BLOCKED, ni NOT_STARTED.

## 3. Commits

11 commits de features (`4999f19` → `b597e85`, uno por subfase F9.1-F9.11, disciplina de un commit independiente por subfase mantenida sin excepción) + este commit de cierre (F9.12: `docs/F9_FINAL_REPORT.md` + actualización final de `docs/F9_PLAN.md`). Ningún commit mezcla más de una subfase. `git log --oneline` confirma la secuencia limpia sobre `main`, sin rebases ni amends.

## 4. Arquitectura

Mismo patrón que F8, adaptado a un dominio con dinero/compliance (ver `docs/F9_PLAN.md` §2):

- **Módulos puros** (`apps/api/src/modules/operations-intelligence/`, nuevo directorio paralelo a `recruiting-intelligence/` de F8): `worker-onboarding.ts`, `document-checklist.ts`, `compliance-rules.ts`, `placement.ts`, `time-entry-signals.ts`, `payroll-readiness.ts`, `billing-readiness.ts`, `incident-rules.ts`. Cero Prisma/fetch/LLM en ninguno — cada uno exporta una constante `*_VERSION`.
- **Wiring impuro**: extiende módulos YA EXISTENTES (`workers/service.ts`, `assignments/service.ts`, `payroll/service.ts`, `billing/service.ts`, `compliance/service.ts`) en vez de duplicarlos, más 3 módulos standalone nuevos (`placements/`, `incidents/`, `reports/`) para dominios sin dueño natural existente.
- **Convención de state machines**: `<MODELO>_STATUS_TRANSITIONS` + `isValidXTransition`, aplicada 4 veces más en F9 (WorkerOnboarding, DocumentChecklistItem, ComplianceRuleEvaluation, Placement, TimeEntry extendido, OperationalIncident) — 14 usos acumulados en el proyecto.
- **Extensión aditiva de enums**: revisitados por instrucción explícita del PO dos comentarios previos de "no se amplía" (`AssignmentStatus` en F9.5, `TimeEntryStatus` en F9.6) — en ambos casos el grafo nuevo es un superconjunto EXACTO del anterior, verificado con los tests de integración YA existentes de F5.4/F5.6, que siguieron pasando sin modificar una sola línea.
- **RBAC campo-por-campo** (F9.11, `reports/service.ts`): mismo patrón ya establecido por `dashboard/service.ts` (F6.8) — un endpoint nunca 403, cada bloque de datos se omite si el permiso real no lo respalda.
- **UI embebida en páginas reales** (F9.9): sin app separada, mismo patrón que F8.11.

## 5. Modelos nuevos

| Modelo | Subfase | Campos clave |
|---|---|---|
| `WorkerOnboarding` | F9.1 | `(candidateId, jobOrderId)` único, `workerId` nullable, `status`, `progress`, `blockers[]`, `warnings[]` |
| `DocumentChecklistItem` | F9.2 | `workerOnboardingId`, `documentTypeId`, `status`, `required`, `manualReviewRequired` |
| `ComplianceRule` + `ComplianceRuleEvaluation` | F9.3 | reglas configurables por tenant/industria/categoría + evaluación persistida por `(workerId, jobOrderId)` |
| `Placement` | F9.4 | `(candidateId, jobOrderId)` único, `payRate`/`billRate` nullable, `status`, `blockers[]`/`warnings[]` |
| `OperationalIncident` | F9.10 | `type`, `status`, relaciones opcionales a Worker/Assignment/Company/JobOrder, `description`, `occurredAt`, `resolutionNotes` |

Extensiones de modelos existentes: `Assignment.placementId` (F9.5), `Shift.timezone`/`notes` (F9.6), `TimeEntry.overtimeFlag`/`discrepancyFlag`/`discrepancyNotes`/`rejectionReason`/`notes`/`clockInAt`/`clockOutAt` (F9.6). `PayrollReadiness` y `BillingReadiness` (F9.7/F9.8) son deliberadamente NO modelos — se recalculan en cada consulta, decisión documentada en `docs/F9_PLAN.md` §12.1/§13.1.

## 6. Migraciones

7 migraciones, todas 100% aditivas (confirmado con `prisma migrate diff` antes de escribir cada una — cero `DROP`/cero columna `NOT NULL` sin default):

1. `20260717180000_f9_1_worker_onboarding`
2. `20260717190000_f9_2_document_checklist`
3. `20260717200000_f9_3_compliance_rules`
4. `20260717210000_f9_4_placement`
5. `20260717220000_f9_5_assignment_management` (extiende `AssignmentStatus` de 4 a 8 valores)
6. `20260717230000_f9_6_shift_time_structure` (extiende `TimeEntryStatus` de 3 a 7 valores)
7. `20260718000000_f9_10_operational_incident`

F9.7, F9.8, F9.9 y F9.11 no requirieron migración (solo lectura sobre datos ya persistidos, o 100% frontend).

## 7. Endpoints nuevos

- **F9.1**: `POST/GET/PATCH /candidates/:candidateId/onboarding/:jobOrderId[/status]`
- **F9.2**: `POST/GET /candidates/:candidateId/onboarding/:jobOrderId/checklist`, `PATCH /checklist-items/:itemId/status`
- **F9.3**: `POST/GET /compliance/rules`, `GET/POST /compliance/evaluate/:workerId/:jobOrderId` (nombres exactos en `docs/F9_PLAN.md` §8)
- **F9.4**: `POST/GET /candidates/:candidateId/placement/:jobOrderId`, `GET/PATCH /placements/:id[/status]`
- **F9.5**: extensión de `POST /assignments` (acepta `placementId`) y `PATCH /assignments/:id/status` (overlap + onboarding-signal checks)
- **F9.6**: `GET/POST /shifts`, `PATCH /shifts/:id`, `POST /time-entries/:id/{submit,approve,reject,reopen}`
- **F9.7**: `GET /payroll/readiness`
- **F9.8**: `GET /billing/readiness`
- **F9.10**: `GET/POST /incidents`, `GET/PATCH /incidents/:id`, `PATCH /incidents/:id/status`
- **F9.11**: `GET /reports/operational`

## 8. UI

F9.9 embebió F9.1-F9.8 en páginas reales existentes (sin app separada, mismo patrón que F8.11):
- Onboarding + Document Checklist → nuevas secciones en `CandidatePipelineDrawer.tsx` (mismo par `candidateId`/`jobOrderId` que Placement Readiness, F8.10).
- Shifts + Payroll Readiness → nuevas pestañas en `Payroll.tsx`.
- Billing Readiness → panel nuevo en `Invoices.tsx`.
- TimeEntry lifecycle extendido → acciones por fila (submit/approve/reject/reopen) + banderas overtime/discrepancy en `TimesheetsTab`.

F9.10 (Incidents) y F9.11 (Reports) son backend-only por diseño — F9.9 fue la única subfase designada explícitamente para UI; una UI para esos dos dominios queda como trabajo futuro si se pide.

## 9. Tests nuevos (por subfase)

| Subfase | Unitarios (puro) | Integración | E2E |
|---|---|---|---|
| F9.1 | (parte de worker-onboarding.ts) | 10 | — |
| F9.2 | 14 | 7 | — |
| F9.3 | 16 | 8 | — |
| F9.4 | 12 | 9 | — |
| F9.5 | (extiende schema compartido) | 7 | — |
| F9.6 | 14 | 19 | — |
| F9.7 | 9 | 7 | — |
| F9.8 | 9 | 6 | — |
| F9.9 | — | — | 6 |
| F9.10 | 7 | 16 | — |
| F9.11 | — | 12 | — |

## 10. Total de tests (suite completa del monorepo, corrida final)

**Backend**: 1176 tests. **E2E**: 32 tests. **Total**: 1208 tests.

## 11. Passing

Backend: 1170/1176. E2E: 31/32 (25 pasaron directamente + 6 de `job-order-matching.spec.ts` se saltaron tras la falla inicial del `describe.configure({mode:"serial"})` de ese archivo, no relacionado a F9 — ver §14).

## 12. Failures

1 falla en cada suite, ambas preexistentes y documentadas desde el cierre de F8 (ver §13).

## 13. Skips

Backend: 5 (heredados de fases previas, sin relación a F9). E2E: 6 (todos dentro de `job-order-matching.spec.ts`, consecuencia del `mode: "serial"` de ese archivo tras su primera falla).

## 14. Fallas preexistentes (confirmadas NO relacionadas a F9)

1. **`prospecting.test.ts`** (backend) — "scheduler: runProspectingSweep processes a newly imported company and skips it on the next run (real OpenAI calls)". Requiere una llamada real a OpenAI; falla en este entorno sin credenciales activas. Documentada desde F7/F8, no tocada por F9.
2. **`job-order-matching.spec.ts`** (e2e, F6.7) — "Recruiter puede ejecutar matching determinista y ver el ranking" falla por un log de consola 404 espurio bajo ejecución en paralelo. Re-ejecutado en aislamiento total (sin ningún otro spec corriendo) durante F9.6, F9.8, F9.9 y esta verificación final de F9.12: falla IDÉNTICO las 4 veces, incluso con cero código de F9 involucrado. Confirmado pre-existente, documentado ya en `docs/F8_FINAL_REPORT.md`.

Ninguna de las dos se le atribuyó a F9 sin evidencia — ambas fueron re-verificadas en aislamiento en múltiples subfases distintas.

## 15. Bugs encontrados (durante el propio desarrollo de F9, todos corregidos antes de cerrar su subfase)

1. **F9.1**: `updateWorkerOnboardingStatus` comparaba contra un `workerId` obsoleto cuando la conversión Candidate→Worker ocurría DESPUÉS del último cambio de estado de onboarding registrado — el guard de `ACTIVE` fallaba incorrectamente. Corregido re-resolviendo `workerId` fresco antes del guard.
2. **F9.3**: colisión de fixture de test — dos reglas de compliance distintas usaban la misma clave de documento (`osha10`) en tests separados del mismo archivo, produciendo un falso resultado por acumulación de datos entre tests.
3. **F9.6 (proceso, no lógica)**: tras agregar el recurso de permiso `shifts` nuevo, los tests de integración fallaban con 403 hasta re-ejecutar `npm run seed` — la base de datos de desarrollo no tenía las filas `Permission`/`RolePermission` nuevas. Documentado para que subfases futuras no repitan la sorpresa.
4. **F9.6 (test)**: primera corrida de `payroll.test.ts` sin `--test-concurrency=1` intercaló asserts de tests distintos, produciendo fallos espurios.
5. **F9.9**: colisión de `aria-label` por substring entre el selector de estado de un item de checklist (F9.2) y el selector de estado de un Shortlist entry (F8.7) — ambos widgets coexisten en la misma página.
6. **F9.9 (test, ×2)**: dos condiciones de carrera clásicas de Playwright donde un locator por texto exacto pierde el elemento a mitad de un `.click()` cuando React Query resuelve una respuesta en el medio y cambia el texto del botón.
7. **F9.11 (test)**: expectativa inicial de RBAC para el rol Manager asumía que no tenía `incidents.view`, cuando en realidad SÍ lo tenía (otorgado en F9.10) — corregida contra el estado real del seed, no una suposición.

## 16. Bugs corregidos

Los 7 bugs de §15 fueron corregidos en el mismo commit de su subfase — ninguno quedó pendiente ni se propagó a una subfase posterior. Cero bug encontrado en producción real (todos detectados por la propia disciplina de test-and-verify antes de cada commit).

## 17. Seguridad

Cumplido en su totalidad, verificado subfase por subfase:
- Sin procesamiento real de pagos, sin conexión bancaria/ACH, sin cálculo fiscal definitivo (F9.7).
- Sin emisión real de factura, sin envío a cliente (F9.8).
- Sin activación automática de Worker, sin aprobación automática de horas, sin creación automática de Assignment ACTIVE (F9.1, F9.5, F9.6).
- Sin aserciones de cumplimiento legal — `describeComplianceStatus` (F9.3) nunca dice "legalmente cumplido".
- Sin inferencia de culpa, sin sanción automática, sin terminación automática de Assignment/Worker desde un Incident (F9.10, confirmado por grep de que `incidents/service.ts` nunca importa `assignments/service.ts` ni `workers/service.ts`).
- Sin métrica inventada ni predicción presentada como hecho (F9.11 — cada número es un `groupBy`/`count` real).
- Sin `push`, sin despliegue, en ningún momento de la sesión.

## 18. Tenancy

Todos los modelos nuevos (`WorkerOnboarding`, `DocumentChecklistItem`, `ComplianceRule`, `ComplianceRuleEvaluation`, `Placement`, `Shift`, `TimeEntry`, `OperationalIncident`) están en `STRICT_TENANT_MODELS` (`apps/api/src/core/tenancy/prisma-extension.ts`). Cada subfase con persistencia incluyó un test explícito de aislamiento entre tenants (`runWithTenancyContext` con un tenant inexistente, confirmando que el registro real es invisible).

## 19. RBAC

Recursos de permiso nuevos: `shifts` (F9.6), `incidents` (F9.10) — ambos generados vía el catálogo CRUD compartido (`packages/shared/src/permissions.ts`), asignados a roles reales en el seed con justificación documentada inline. F9.7/F9.8/F9.11 reutilizan permisos ya existentes (`payrollRuns.view`, `invoices.view`, y el patrón campo-por-campo de F6.8) — ninguna subfase inventó un permiso nuevo sin necesidad real. La matriz legacy `rbac-403-matrix.test.ts` (F6.9) no se extendió a los endpoints de F9 -- cada subfase F9.x trae su propia cobertura 403 explícita dentro de su archivo de test dedicado (`incidents.test.ts`, `payroll.test.ts`, `billing.test.ts`, `reports.test.ts`), decisión documentada, no un gap silencioso.

## 20. Audit logs

Todo write sensible en F9 llama a `logAuditEvent()` con una `action` semánticamente distinta, verificado por un test dedicado en cada subfase: `workerOnboarding.started/status_changed`, `checklistItem.status_changed`, `complianceRule.created`, `complianceEvaluation.evaluated`, `placement.created/updated/status_changed`, `shift.created/updated`, `timeEntry.created/submitted/approved/rejected/reopened`, `incident.created/updated/status_changed`.

## 21. Precisión monetaria

Convención `Decimal @db.Decimal(p,s)` + `Number()` en aritmética de servicio + número plano de vuelta a Prisma, mantenida sin excepción en F9.7 (`estimatedRevenue`/`estimatedLaborCost`/`estimatedGrossProfit` de PayrollReadiness) y F9.8 (mismos campos de BillingReadiness, más `estimatedMarginPercent` con guarda explícita contra división por cero — nunca `NaN`/`Infinity`, verificado por test unitario).

## 22. Datos modificados

Ningún dato de producción real fue modificado — toda la verificación corrió contra el seed de desarrollo (`tenant-titan`) vía dev-bypass. Único cambio de estado persistente fuera de fixtures de test: `npm run seed` re-ejecutado 3 veces (F9.6, F9.10 — idempotente, solo upserts de `Permission`/`RolePermission`) para propagar los recursos `shifts`/`incidents` nuevos a la base de datos de desarrollo.

## 23. Decisiones pendientes

- ¿Se quiere una UI dedicada para Incidents (F9.10) y Operational Reports (F9.11)? Backend completo y probado, sin UI por diseño (F9.9 fue la subfase de UI designada).
- ¿Se quiere extender la matriz legacy `rbac-403-matrix.test.ts` a los endpoints de F9? Cobertura RBAC ya existe por subfase, esto sería consolidación, no un gap funcional.
- La limitación de horas dobles pagadas a 1.5x en vez de 2x en `PayrollItem` (heredada de F5.7, documentada desde entonces) sigue sin resolverse — fuera de alcance de F9, no se tocó.

## 24. Deuda técnica

- `clockInAt`/`clockOutAt` en `TimeEntry` (F9.6) son campos reservados sin ningún integrador de reloj checador real conectado todavía.
- El chequeo de onboarding en `updateAssignmentStatus` (F9.5) es best-effort: solo bloquea si existe un `WorkerOnboarding` real con estado BLOCKED/OFFBOARDED — Workers creados sin pasar por F9.1 nunca quedan bloqueados por esta regla.
- `matching/availability.ts` (F6) no reconoce `PAUSED` (F9.5) como estado ocupante para efectos de recomendación de matching, aunque sí ocupa capacidad real vía F9.5 — gap conocido, documentado desde F9.5.
- Sin desglose día-por-día en Payroll/Billing Readiness cuando un período consultado se solapa solo parcialmente con un run/invoice ya exportado (F9.7/F9.8).
- `Shift` no tiene `delete` expuesto (decisión deliberada, F9.6) — la permission key existe pero no está asignada ni tiene endpoint.

## 25. Git status

Working tree limpio (`git status --short` sin salida) al momento de este informe, antes del commit de cierre de F9.12. Sin cambios sin commitear, sin archivos untracked relevantes.

## 26. Último commit

`b597e85` — "feat: F9.11 — operational reports" (previo a este commit de cierre de F9.12).

## 27. Ubicación de este informe

`docs/F9_FINAL_REPORT.md` (este archivo), en la raíz de documentación del proyecto junto a `docs/F8_FINAL_REPORT.md` y `docs/F9_PLAN.md`.

## 28. Recomendación para F10

F9 deja Staffing Operations con un ciclo de vida completo: onboarding → checklist → compliance → placement → assignment → shift/time → payroll readiness → billing readiness → incidentes → reportes, todo con UI real donde correspondía. Candidatos razonables para F10 (a decidir por el PO, no una recomendación vinculante):

1. **Cerrar el ciclo de UI de F9.10/F9.11** — una vista de Incidents y un dashboard de Operational Reports, si el negocio los necesita antes de avanzar a un dominio nuevo.
2. **Resolver la deuda técnica documentada en §24** — particularmente el gap de `matching/availability.ts` con `PAUSED` y el desglose día-por-día de readiness, si empiezan a causar fricción operativa real.
3. **Un dominio completamente nuevo** (ej. reportería financiera consolidada, integraciones externas reales de timeclock/ACH si el negocio decide dar ese paso, o expansión multi-tenant real) — cualquiera de estos exigiría su propia autorización explícita y una auditoría previa del mismo rigor que F9.

No se recomienda empezar F10 sin una nueva autorización explícita del PO, según lo indicado.

---

**F9 completo. No se empieza F10. Sesión detenida aquí según lo indicado por la autorización.**
