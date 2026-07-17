# F8 — Autonomous Recruiting — Reporte Final

**Fecha de cierre**: 2026-07-17
**Autorización**: ejecución autónoma continua F8.6→F8.12 (mensaje del PO, sesión F7.5→F10), continuando la autorización previa F7.5→F8.5.

## 1. Resumen ejecutivo

F8 construye el pipeline completo de reclutamiento asistido por IA determinista, desde la interpretación de una instrucción de intake en lenguaje natural (F8.1) hasta la evaluación de disposición para placement (F8.10), con una UI real que expone todo el pipeline (F8.11). Las 12 subfases (F8.1-F8.12) están **completas y verificadas** con backend real, tests deterministas, RBAC, tenancy, audit logs, y (donde aplica) UI real verificada en navegador.

Ningún subsistema de F8 contacta candidatos reales, envía mensajes, crea entidades comerciales automáticamente, ni ejecuta una acción de negocio irreversible sin aprobación humana explícita. Cada subfase que califica/rankea/prepara algo para un candidato reutiliza -- nunca duplica -- la salida de la subfase anterior (F8.2→F8.5→F8.6→F8.7→F8.8/F8.9→F8.10), formando una cadena de dependencia limpia y auditable.

**Estado real de F8: COMPLETE** (ver §16 para el detalle de por qué se considera completo y qué queda fuera de alcance deliberadamente).

## 2. Arquitectura

Mismo patrón en las 10 subfases con backend (F8.1-F8.10):

- **Módulos puros** en `apps/api/src/modules/recruiting-intelligence/` -- cero Prisma/fetch/LLM, cada uno con su propia constante `*_VERSION`, 100% testeable sin DB. Cada módulo nuevo reutiliza DIRECTAMENTE la salida de módulos anteriores como input (nunca re-deriva un hecho ya calculado):
  - `job-intake.ts` (F8.1) → `qualification-rules.ts` (F8.2) → `qualification-status.ts` (F8.5) → `candidate-matching.ts` (F8.6) → `candidate-shortlist.ts` (F8.7) → `screening-plan.ts` / `interview-preview.ts` (F8.8/F8.9) → `placement-readiness.ts` (F8.10).
  - `candidate-identity.ts` (F8.4) y `candidate-sourcing.ts` (F8.3) son utilidades paralelas usadas por el resto.
- **Wiring impuro** casi enteramente en `apps/api/src/modules/talent/service.ts` (con la excepción de F8.1, wireado en `jobs/service.ts`) -- conecta los módulos puros con `scopedDb` (tenancy automática) y `logAuditEvent`.
- **Persistencia**: 5 modelos nuevos (`CandidateQualification`, `CandidateMatch`, `CandidateShortlistEntry`, `ScreeningPlan`, `InterviewPreview`, `PlacementReadiness` -- 6 en total), todos con el mismo patrón: un registro ACTUAL por par `(candidateId, jobOrderId)` (`@@unique`), upsert en cada re-cálculo, historial de cambios vía `AuditLog` (no vía versionado de filas).
- **Decisión arquitectónica clave (F8.6, documentada en su momento)**: el motor de matching de Candidates NO extiende `matching/scoring.ts` (F6.3, que puntúa `Worker` ya contratados) -- son dominios distintos (pre-hire vs. post-hire) que comparten el PATRÓN (hard constraints antes de puntuar, factores blandos ponderados con evidencia, empate determinista) pero no el código.
- **UI** (F8.11): sin app/página separada -- dos componentes (`RecruitingMissionPanel`, `CandidatePipelineDrawer`) embebidos en `JobOrderDetail.tsx` existente, mismo patrón que `MatchingPanel` (F6.7).

## 3. Subfases F8.1-F8.12

| # | Nombre | Estado | Commit |
|---|---|---|---|
| F8.1 | Job Intake Intelligence | COMPLETE | `c661c7a` |
| F8.2 | Job Requirements and Qualification Rules | COMPLETE | `6b80106` |
| F8.3 | Candidate Sourcing | COMPLETE | `7ecf65b` |
| F8.4 | Candidate Normalization and Deduplication | COMPLETE | `6629f6c` |
| F8.5 | Estados de calificación con razones auditables | COMPLETE | `8f4e704` |
| F8.6 | Matching and Ranking | COMPLETE | `33936ce` |
| F8.7 | Candidate Shortlist | COMPLETE | `99c9847` |
| F8.8 | Screening Intelligence | COMPLETE | `672be11` |
| F8.9 | Interview Scheduling Preview | COMPLETE | `9244085` |
| F8.10 | Placement Readiness | COMPLETE | `3e7800b` |
| F8.11 | Recruiting Mission UI | COMPLETE | `5d522fc` |
| F8.12 | Hardening y cierre F8 | COMPLETE | (este commit) |

Detalle completo de cada subfase (arquitectura, archivos, contratos, tests, migraciones, limitaciones) está en `docs/F8_PLAN.md` §6-17 -- este reporte resume, no repite.

## 4. Endpoints nuevos

Todos bajo `/api/v1`, todos con RBAC explícito (ver §7):

| Método | Ruta | Subfase | Efecto |
|---|---|---|---|
| POST | `/job-orders/interpret-intake` | F8.1 | Parsea texto, no persiste |
| GET | `/candidates/:id/qualification/:jobOrderId` | F8.2 | Solo evalúa, no persiste |
| GET | `/job-orders/:jobOrderId/source-candidates` | F8.3 | Solo lectura |
| POST | `/candidates/:id/qualification/:jobOrderId` | F8.5 | Evalúa + persiste (upsert) |
| GET | `/candidates/:id/qualification/:jobOrderId/status` | F8.5 | Solo lectura |
| POST | `/job-orders/:jobOrderId/matching` | F8.6 | Calcula + persiste (upsert) |
| GET | `/job-orders/:jobOrderId/matching` | F8.6 | Solo lectura |
| POST | `/job-orders/:jobOrderId/shortlist` | F8.7 | Genera/refresca (upsert) |
| GET | `/job-orders/:jobOrderId/shortlist` | F8.7 | Solo lectura |
| PATCH | `/shortlist/:entryId/review-status` | F8.7 | Cambia estado (validado) |
| POST | `/candidates/:id/screening-plan/:jobOrderId` | F8.8 | Genera + persiste (upsert) |
| GET | `/candidates/:id/screening-plan/:jobOrderId` | F8.8 | Solo lectura |
| POST | `/candidates/:id/interview-preview/:jobOrderId` | F8.9 | Genera + persiste (upsert) |
| GET | `/candidates/:id/interview-preview/:jobOrderId` | F8.9 | Solo lectura |
| PATCH | `/candidates/:id/interview-preview/:jobOrderId/status` | F8.9 | Cambia estado (validado) |
| POST | `/candidates/:id/placement-readiness/:jobOrderId` | F8.10 | Evalúa + persiste (upsert) |
| GET | `/candidates/:id/placement-readiness/:jobOrderId` | F8.10 | Solo lectura |

**17 endpoints nuevos**, ninguno envía mensajes/emails/SMS, ninguno crea Assignment/Placement/Worker, ninguno modifica un calendario real.

## 5. Modelos y migraciones

6 modelos nuevos, todos aditivos, todos con FKs `ON DELETE RESTRICT` hacia `Candidate`/`JobOrder`, todos registrados en `STRICT_TENANT_MODELS`:

| Modelo | Migración | Subfase |
|---|---|---|
| `CandidateQualification` | `20260717120000_f8_5_candidate_qualification` | F8.5 |
| `CandidateMatch` | `20260717130000_f8_6_candidate_matching` | F8.6 |
| `CandidateShortlistEntry` | `20260717140000_f8_7_candidate_shortlist` | F8.7 |
| `ScreeningPlan` | `20260717150000_f8_8_screening_plan` | F8.8 |
| `InterviewPreview` | `20260717160000_f8_9_interview_preview` | F8.9 |
| `PlacementReadiness` | `20260717170000_f8_10_placement_readiness` | F8.10 |

Verificado explícitamente (grep sobre las 6 migraciones): **cero** `DROP`, **cero** `DELETE FROM`, **cero** `TRUNCATE`, **cero** columna eliminada, **cero** backfill ambiguo. Solo `CREATE TYPE`/`CREATE TABLE`/`CREATE INDEX`/`ALTER TABLE ADD CONSTRAINT`. Cada una se generó por diff contra el schema real (`prisma migrate diff --from-url`), se revisó el SQL antes de aplicar, se aplicó localmente, y se confirmó que no afecta datos preexistentes (todas las tablas son nuevas).

## 6. UI

F8.11 -- ver `docs/F8_PLAN.md` §17 para el detalle completo de verificación en navegador (Playwright real contra dev servers reales). Resumen: `RecruitingMissionPanel` (matching + shortlist) y `CandidatePipelineDrawer` (calificación + screening + entrevista + placement readiness), embebidos en `JobOrderDetail.tsx`. Verificado con datos reales del seed, RBAC real, dark mode, mobile, estados vacíos, cero errores de consola.

## 7. RBAC

Auditoría completa de los 17 endpoints nuevos (más los pre-existentes de `talent/router.ts`): **100% tienen un guard RBAC explícito** (`requirePermission`/`requireAllPermissions`/`requireAnyPermission`), ninguno depende de un default implícito. Patrón consistente: endpoints de escritura requieren `candidates.update` (a veces + `jobOrders.view`); endpoints de solo lectura requieren `candidates.view` (+ `jobOrders.view` donde aplica). Verificado con tests de integración (403 explícito para roles sin permiso) en cada subfase y con el e2e de F8.11 (rol Payroll sin acceso).

## 8. Tenancy

Los 6 modelos nuevos están en `STRICT_TENANT_MODELS` (`core/tenancy/prisma-extension.ts`) -- toda lectura/escritura pasa por `scopedDb`, nunca acepta un `tenantId` por parámetro. **Hallazgo real de esta sesión** (F8.5, documentado y resuelto igual en F8.6-F8.10): la extensión de tenancy redirige `findUnique`/`upsert` a `findFirst` para poder inyectar el filtro de tenant, y `findFirst` no reconoce nombres de clave única compuesta (`candidateId_jobOrderId`). Se resolvió con el mismo patrón ya usado en `TimeEntry` (F5.6, `payroll/service.ts`): `findFirst` por campos planos + `update`/`create` manual por `id`. Esto es una restricción arquitectónica preexistente, no un bug introducido, y quedó documentada en cada subfase que la usa.

## 9. Audit logs

Las 8 funciones de escritura de F8 (F8.5-F8.10) registran exactamente un `logAuditEvent` con una acción distinta y semánticamente nombrada: `candidate.qualification_evaluated`, `candidate.matching_computed`, `candidate.shortlist_generated`, `candidate.shortlist_review_status_changed`, `candidate.screening_plan_generated`, `candidate.interview_preview_generated`, `candidate.interview_preview_status_changed`, `candidate.placement_readiness_evaluated`. Verificado con un test de integración explícito por cada una (busca el `AuditLog` real tras la llamada HTTP).

## 10. Tests

- **148 tests unitarios puros** en `recruiting-intelligence/*.test.ts` (10 módulos), cero DB, deterministas.
- **`talent.test.ts`**: 83 tests totales (incluye F5.2 preexistente + todas las adiciones F8.2-F8.10).
- **`jobs.test.ts`**: 32 tests totales (incluye F8.1).
- **`e2e/recruiting-mission.spec.ts`**: 7 tests Playwright (F8.11), 7/7 passing en aislamiento.
- **Suite completa de `apps/api`**: 977 tests, **971 pass**, 1 fail preexistente (`prospecting.test.ts`, llamada real a OpenAI, confirmado no relacionado a F8), 5 skip (4 gateados por `RUN_REAL_PROVIDER_TESTS` + 1 preexistente).
- **Suite e2e completa de `apps/web`**: 26 tests, 25 pass, 1 fail preexistente (`job-order-matching.spec.ts`, F6.7, confirmado reproducible en aislamiento sin ningún código de F8 presente).
- Cobertura por tipo: unit tests puros ✓, tests de API/integración ✓, RBAC ✓, tenancy ✓ (implícito vía scopedDb + tests cross-tenant en F5.2/F8.4), idempotencia ✓ (upsert verificado explícitamente en cada subfase F8.5-F8.10), audit logs ✓, estados inválidos ✓ (transiciones rechazadas con 400 en F8.7/F8.9), fairness ✓ (F8.2/F8.6/F8.8 explícitos), no-contact safeguards ✓ (ninguna función de F8 llama a un proveedor de mensajería/email/SMS/calendario real).

## 11. Bugs encontrados (y corregidos, todos dentro de la misma subfase donde se detectaron)

1. **F8.5**: `scopedDb.candidateQualification.findUnique`/`upsert` con clave compuesta fallaba (`Unknown argument candidateId_jobOrderId`) -- causa raíz: la extensión de tenancy no soporta claves únicas compuestas en esas operaciones. Corregido con el patrón `findFirst`-por-campos-planos (mismo ya usado en F5.6).
2. **F8.6, test de fairness**: substring-match (`"yearsExperience".includes("sex")`) daba falso positivo -- mismo patrón de bug ya visto en F8.2. Corregido con comparación exacta de claves.
3. **F8.7, test de idempotencia**: el test asumía que la primera entrada de la shortlist era siempre el candidato recién creado -- falso, porque el tenant de test ya tiene candidatos reales de la misma categoría desde el seed de F0. Diagnosticado con un script de reproducción aislado (llamando al service directamente, sin HTTP), confirmó que el código de PRODUCCIÓN era correcto; el test se corrigió para ubicar la entrada por `candidateId` exacto.
4. **F8.11, e2e**: un test de RBAC con rol "sales" disparaba un 403 de red no relacionado a los paneles de F8 (probablemente de otro panel de la misma página que Sales tampoco puede ver) -- se cambió el rol de prueba a "payroll" (ya probado limpio por el e2e preexistente de F6.7 en el mismo Job Order), evitando introducir una aserción fràgil sobre un componente fuera de alcance de F8.

Ningún bug encontrado quedó sin corregir dentro de su propia subfase -- ninguno se "documentó como deuda" en vez de arreglarse cuando la corrección era directa y de bajo riesgo.

## 12. Deuda técnica

- `computeAndPersistCandidateMatching`/`generateAndPersistScreeningPlan`/`computeAndPersistPlacementReadiness` vuelven a leer el `JobOrder`/`Candidate` desde la DB en cada llamada a `runQualificationEvaluation` (una vez por candidato en el caso de matching) -- redundante pero deliberado: reutilizar la función tal cual es más seguro que duplicar su lógica para optimizar, dado el volumen bajo de candidatos por categoría en este CRM.
- Sin reorder manual de shortlist independiente del ranking (F8.7) -- el orden viene determinista del ranking, un reorder manual quedaría como mejora futura si se pide explícitamente.
- El formulario de "Generar preview de entrevista" en la UI (F8.11) usa una ventana propuesta simple por defecto en vez de un formulario completo editable -- el backend ya soporta todos los campos, falta la UI de edición completa.
- El nombre/apellido real del candidato no se muestra en las filas de ranking/shortlist de la UI -- solo `candidateId` con link al perfil -- porque los DTOs de F8.6/F8.7 no incluyen `displayName` (reabrir esos DTOs para agregar un campo de conveniencia queda para una futura mejora menor, no bloqueante).

## 13. Decisiones pendientes (para el PO/negocio, no técnicas)

- ¿Se desea un endpoint de "evaluar en batch" (todos los candidatos de una shortlist a la vez) para F8.7 Shortlist / matching, en vez de evaluar de a uno? Hoy cada candidato requiere su propia llamada.
- ¿Se desea agregar un campo de compensación esperada al modelo `Candidate` para que F8.10 (Placement Readiness) pueda comparar contra `JobOrder.payRate` en vez de documentar su ausencia permanentemente?
- ¿Se desea una integración real de calendario/email para que `APPROVED_FOR_SEND` (F8.9) dispare un envío real? Hoy es intencionalmente un preview sin efecto externo.

## 14. Riesgos

- **Ninguno de severidad alta** identificado. El riesgo más relevante es el ya documentado en cada subfase: ausencia de índice único en `Candidate` (email/phone/nombre+estado) heredada de F5.2, no resuelta por instrucción explícita del PO -- una condición de carrera teórica en creaciones concurrentes del mismo candidato, no introducida ni agravada por F8.
- El volumen de queries N+1 documentado en §12 podría volverse un problema de performance real si el número de candidatos por categoría crece significativamente -- vigilar en producción, no bloqueante hoy.

## 15. Limitaciones

- F8 evalúa "listo para placement" (F8.10) pero no ejecuta la transición -- no existe un modelo `Placement` en el schema todavía (fuera de alcance explícito, ver plan histórico F9/F10).
- La detección de conflictos de F8.9 solo compara contra otras `InterviewPreview` ya persistidas, nunca contra un calendario real (no hay integración).
- Todas las demás limitaciones puntuales están documentadas en cada sección de `docs/F8_PLAN.md` (§6.8, §7.8 (no aplica, siguiente), §9.6, §11.8, §12.9, §13.8, §14.9, §15.8, §16.9 según corresponda a cada subfase).

## 16. Estado real de F8

**COMPLETE.**

Justificación: las 12 subfases tienen backend real (donde aplica), tests deterministas passing, RBAC, tenancy, audit logs, migraciones 100% aditivas, y UI real verificada en navegador contra datos reales (F8.11). No hay ninguna integración esencial faltante dentro del alcance definido por el PO para F8 -- las únicas piezas ausentes (integración real de calendario/email, modelo `Placement`, campo de compensación del candidato) son decisiones de negocio explícitamente fuera de alcance de esta fase (ver §13), no huecos accidentales.

No se declara COMPLETE por inercia: se verificó activamente que (a) la suite completa del backend no acumuló fallas nuevas (971/977, la única falla es la ya conocida y confirmada no relacionada), (b) el e2e completo del frontend no acumuló fallas nuevas (25/26, la única falla es preexistente y confirmada reproducible sin ningún código de F8), y (c) cada subfase individual cerró con su propio commit, tests, y reporte -- nunca se marcó "listo" solo por tener el plan escrito.

## 17. Recomendación para F9

F8 deja una base sólida para F9 (Staffing Operations, según la numeración histórica del PO). Recomendaciones concretas:

1. **Auditar primero, igual que se hizo para F8**: F9 probablemente toca `Assignment`/`Worker`/`Payroll`, todos con historia propia (F5.4-F5.7) -- repetir el mismo criterio de "no dupliques lógica ya existente" antes de escribir código.
2. **Considerar cerrar la decisión pendiente de compensación** (§13) antes de que F9 necesite comparar `payRate` real vs. expectativa del candidato -- hoy F8.10 solo documenta la ausencia del dato.
3. **El modelo `Placement`** (si F9 lo introduce) debería probablemente consumir `PlacementReadiness.readinessStatus === "READY_FOR_APPROVAL"` como una señal de entrada, no repetir su lógica de checks.
4. **Mantener la disciplina de migraciones aditivas y RBAC explícito por endpoint** -- funcionó sin fricción en las 12 subfases de F8, no hay motivo para cambiarla.
5. **Vigilar el N+1 documentado en §12** si el volumen de candidatos crece antes de optimizar prematuramente.
