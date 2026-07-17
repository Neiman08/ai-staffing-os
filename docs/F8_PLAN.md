# F8 — Autonomous Recruiting — Plan

**Autorización**: ejecución autónoma continua F7.5→F10 (mensaje del PO, ver `docs/F7_CEO_INTELLIGENCE_AND_AUTONOMOUS_CLIENT_ACQUISITION_PLAN.md` §17). F7 cerrado (`docs/F7_FINAL_REPORT.md`). Este documento cubre la auditoría previa y el plan de F8, y se actualiza a medida que avanza cada subfase — nunca se declara "completado" solo por tener este plan; cada subfase exige backend real + tests + (UI donde aplique) antes de marcarse.

## 1. Auditoría de lo que ya existe (hecho antes de escribir código)

Hallazgo crítico de numeración: el roadmap **interno** de este repo ya usó la etiqueta "F6" para "Autonomous Recruiting and Operations" (`docs/F6_AUTONOMOUS_RECRUITING_AND_OPERATIONS_PLAN.md`, cerrado, F6.0-F6.10) — un motor de matching determinista completo. La numeración que me dio el PO en la autorización de esta sesión (F7 CEO Intelligence → **F8** Autonomous Recruiting → F9 Staffing Operations → F10 Portales) es una secuencia NUEVA y distinta de la numeración histórica del repo — coincide en tema con el "F6" viejo pero no es lo mismo. Se usa la etiqueta **F8** tal como la dio el PO en toda esta documentación nueva, dejando F6 histórico intacto, sin renombrar nada retroactivamente.

Ya existe (F5.1-F5.4, F6.0-F6.10 históricos — NO se reimplementa):

- **JobOrder** (`packages/db/prisma/schema.prisma`): `title`, `description`, `workersNeeded`/`workersFilled`, `billRate`/`payRate`, `location` (Json), `shiftType` (enum), `scheduleNotes`, `startDate`/`endDate`, `status` (DRAFT/OPEN/PARTIALLY_FILLED/FILLED/CLOSED/CANCELLED), `requirements` (Json array de DocumentType), `urgency` (RiskLevel), `categoryId`. CRUD real en `apps/api/src/modules/jobs/`.
- **Candidate**: `firstName/lastName/email/phone/languages[]/city/state/zip/categories/yearsExperience/resumeUrl/aiSummary/aiScore/status/source/smsOptIn`. `status`: `CandidateStatus` (NEW/SCREENING/QUALIFIED/PLACED/REJECTED/INACTIVE) — INTERVIEW/OFFERED colapsados en QUALIFIED, WITHDRAWN/ARCHIVED en INACTIVE (ver `apps/web/src/pages/Candidates.tsx`). CRUD real en `apps/api/src/modules/talent/` (nombrado "talent", no "candidates").
- **Worker**: `status` (AVAILABLE/ASSIGNED/ON_LEAVE/TERMINATED), `complianceStatus` (COMPLIANT/PENDING/BLOCKED).
- **Assignment**: `status` (SCHEDULED/ACTIVE/COMPLETED/TERMINATED).
- **Matching engine** (`apps/api/src/modules/matching/scoring.ts`): 5 descalificadores duros (terminated, on_leave, compliance no COMPLIANT, categoría no coincide, solapamiento de fechas) evaluados ANTES de puntuar — separación limpia hard/soft ya existente. 7 factores blandos ponderados (requiredDocuments 25, experience 20, location 15, payRate 15, assignmentHistory 15, languages 5, dataRecency 5) sumando 100. Salida ya incluye score, evidencia por factor, strengths/gaps, disqualifiers, explicación. Test explícito de fairness (`scoring.test.ts`) confirma que NINGÚN atributo protegido (raza, género, edad, religión, nacionalidad, discapacidad, embarazo, salud, etnia, fecha de nacimiento, SSN) alimenta el score. **F8.6 se apoya en este motor sin reescribirlo.**
- **RBAC**: recursos CRUD genéricos `candidates`/`workers`/`jobOrders` (view/create/update/delete) + `matching.view`/`matching.run` ya existen.

NO existe (esto es lo que F8 realmente agrega):

- Extracción estructurada de una instrucción de intake en lenguaje natural hacia campos de JobOrder (F8.1) — hoy JobOrder se crea vía formulario estructurado, no vía texto libre con ambigüedades.
- Un estado de calificación DETERMINISTA con razones auditables por candidato-por-job (QUALIFIED/POSSIBLY_QUALIFIED/NEEDS_REVIEW/NOT_QUALIFIED) distinto del `CandidateStatus` genérico del CRM (F8.5).
- Sourcing autónomo de candidatos desde fuentes permitidas (F8.3).
- Shortlist como concepto propio (nunca contacta, nunca rechaza permanentemente sin acción humana) (F8.7).
- Generación de plan de screening (preguntas/criterios/evidencia esperada/descalificadores) (F8.8).
- Preview de programación de entrevistas (sin tocar Google Calendar real) (F8.9).
- Determinación de "listo para placement" sin crear Assignment sin aprobación (F8.10).
- UI de "Recruiting Mission" mostrando el pipeline completo con evidencia (F8.11).

## 2. Arquitectura (mismo patrón que F7)

Pure functions en `apps/api/src/modules/recruiting-intelligence/` (sin Prisma/fetch/LLM, mismo espíritu que `ceo-intelligence/`), wiring impuro en `apps/api/src/modules/recruiting/` o extendiendo `matching/` donde aplique. Cada módulo puro con su `*_VERSION`. Cada nuevo modelo/campo de schema, aditivo únicamente, revisado antes de aplicar.

## 3. Subfases

| # | Nombre | Nuevo/Extiende |
|---|---|---|
| F8.1 | Job Intake Intelligence | Nuevo (puro: parseo de texto -> campos estructurados + ambigüedades) |
| F8.2 | Reglas de calificación (sin atributos protegidos) | Nuevo, con tests de fairness explícitos (mismo criterio que F6/scoring.ts) |
| F8.3 | Candidate sourcing (fuentes permitidas, sin scraping prohibido, sin mensajes) | Nuevo |
| F8.4 | Normalización + deduplicación de candidatos | Extiende (talent/service.ts ya tiene dedup parcial — verificar y reforzar) |
| F8.5 | Estados de calificación con razones auditables | Nuevo modelo/campo aditivo sobre Candidate o JobOrder-Candidate |
| F8.6 | Mejora del matching existente (hard/soft/score/explicación/confianza/riesgos) | Extiende `matching/scoring.ts`, sin reescritura innecesaria |
| F8.7 | Shortlist (nunca contacta, nunca rechaza permanentemente sin acción humana) | Nuevo |
| F8.8 | Plan de screening | Nuevo |
| F8.9 | Preview de programación de entrevistas | Nuevo, sin integración real de calendario |
| F8.10 | Placement readiness (nunca crea Assignment activo sin aprobación) | Nuevo |
| F8.11 | Recruiting Mission UI | Nuevo |
| F8.12 | Cierre F8 (hardening, e2e, `docs/F8_FINAL_REPORT.md`) | — |

## 4. Restricciones (heredadas de la autorización global)

Sin mensajes reales a candidatos. Sin scraping prohibido. Sin candidatos falsos salvo fixtures de test inequívocos. Sin datos protegidos en reglas de calificación. Sin creación de Assignment activo sin aprobación humana. Sin integración real de Google Calendar.

## 5. Estado

Auditoría completa.

---

## 6. Resultado de F8.1 — Job Intake Intelligence

### 6.1 Arquitectura

- **`recruiting-intelligence/job-intake.ts`** (puro) — `interpretJobIntake()`: convierte una instrucción de intake en lenguaje natural en campos estructurados de `JobOrder`. Nunca inventa: título/categoría solo matchea contra `JobCategory` reales del tenant (pasadas como input, más específica gana — "Journeyman Electrician" sobre "Electrician"); certificaciones/compliance requirements solo matchean contra `DocumentType` reales; ubicación reutiliza `detectCitiesAndStates` (`ceo-intelligence/geo.ts`, ya probado desde F7.1); idiomas de un vocabulario cerrado; fecha de inicio SOLO literal (nunca interpreta "el lunes"/"next week" como fecha real, ya que eso requeriría inyectar "hoy" y renunciar a pureza/determinismo). Todo lo no detectado queda `null`/vacío + entrada explícita en `ambiguities`.
- **`jobs/service.ts` → `interpretJobOrderIntake()`** (impuro) — única responsabilidad: cargar `JobCategory`/`DocumentType` reales del tenant (`scopedDb`, ya tenant+global) y llamar al módulo puro. **Nunca crea un JobOrder** — mismo patrón "plan-only" que `planMissionOnly` (F7.2): el humano revisa el preview y decide si completa/corrige antes de `POST /job-orders`.
- **`POST /job-orders/interpret-intake`** (`jobOrders.create`, mismo permiso que crear ya que es un paso previo a esa misma acción) — nuevo endpoint, no modifica ninguno existente.

### 6.2 Contratos

`jobIntakeInputSchema`/`jobIntakeResultSchema` nuevos en `packages/shared/src/schemas/jobs.ts` — espejo de `JobIntakeResult`.

### 6.3 Tests — 14 nuevos (todos passing)

`job-intake.test.ts` (11): extracción completa de una instrucción con todos los campos; preferencia por la categoría más específica; sin categoría real matcheada → `null` + ambigüedad (nunca inventa); campos sin detectar quedan `null` con su propia ambigüedad; exclusiones no contaminan el resto del parseo; certificaciones nunca inventadas fuera del catálogo; idiomas de vocabulario cerrado; experiencia con patrón numérico explícito; fecha de inicio solo literal, nunca relativa; determinismo; versión estable. `jobs.test.ts` (+3): RBAC 403 sin `jobOrders.create`; interpretación real contra el catálogo seed (`category-forklift-operator`, `Forklift Certification`) y confirmación de que **cero JobOrder se crea**; sin categoría matcheada, `jobTitle: null` + ambigüedad.

### 6.4 Suite completa

787 tests, 781 pass, 1 fail preexistente sin relación (`prospecting.test.ts`), 5 skip (4 gateados por real-provider-tests + 1 preexistente sin relación).

### 6.5 UI

Ninguna en esta subfase — se surfacea en F8.11 (Recruiting Mission UI), mismo criterio que F7.1 (el intérprete de intención tampoco tuvo UI propia hasta integrarse en Mission Detail en F7.2).

### 6.6 Limitaciones conocidas

- `schedule` (horario detallado, ej. "Lunes a Viernes 8am-5pm") y `skills` (habilidades sueltas no atadas a una categoría/certificación) quedan siempre vacíos — no existe un catálogo real de habilidades en el CRM contra el cual matchear sin inventar; documentado como limitación en vez de adivinar.
- Fechas relativas ("el lunes", "next week") nunca se resuelven a una fecha real — requeriría romper la pureza del módulo (inyectar "hoy"); decisión conservadora deliberada.

### 6.7 Commit

`feat: F8.1 — job intake intelligence`.

**F8.1 completo.**

## 7. Estado

Continuando automáticamente con la implementación de F8.2.

---

## 8. Resultado de F8.2 — Job Requirements and Qualification Rules

### 8.1 Arquitectura

- **`recruiting-intelligence/qualification-rules.ts`** (puro) — `evaluateCandidateQualification()`: evalúa un `Candidate` (etapa de reclutamiento) contra los requisitos de un `JobOrder` -- distinto y ANTERIOR al motor de matching de F6 (`matching/scoring.ts`), que opera sobre `Worker` ya activos/operacionales. 3 disqualifiers duros: `candidate_status_ineligible` (REJECTED/INACTIVE, terminal por diseño del CRM), `category_mismatch`, `missing_required_document:<key>`/`document_expired:<key>` (documento requerido sin uno `VERIFIED` y vigente). 2 gaps blandos (nunca descalifican): `experienceGap`, `languageGaps`. Cero atributos protegidos en el contrato de entrada -- ver `qualification-rules.test.ts`, tests de fairness explícitos (mismo criterio que `matching/scoring.test.ts:373`, F6.4).
- **`talent/service.ts` → `evaluateCandidateQualificationForJobOrder()`** (impuro) — carga `Candidate` (con `categories`/`documents.documentType`) y `JobOrder` reales, llama al módulo puro. **Nunca cambia `Candidate.status` ni crea nada** -- solo evalúa. Limitación documentada: `JobOrder` todavía no tiene columnas de experiencia mínima/idiomas requeridos (F8.1 los extrae del texto de intake, pero no se persisten en el schema) -- se evalúan como "sin requisito" hasta que exista esa columna, nunca se inventa un valor.
- **`GET /candidates/:id/qualification/:jobOrderId`** (`candidates.view` + `jobOrders.view`, `requireAllPermissions`) — nuevo endpoint, solo lectura.

### 8.2 Tests — 20 nuevos (todos passing)

`qualification-rules.test.ts` (16): categoría coincide/no coincide; status REJECTED/INACTIVE siempre descalifica, NEW/SCREENING/QUALIFIED/PLACED nunca por sí solos; documento ausente vs. vencido vs. `PENDING_REVIEW`/`REJECTED` (ninguno de estos últimos cuenta como válido); experiencia insuficiente y no declarada son gap blando, nunca hard disqualifier; idiomas faltantes son gap blando; `reasons` siempre no vacío; determinismo; versión estable; **fairness**: el contrato de `QualificationCandidateInput` declara EXACTAMENTE 6 claves (ninguna protegida) y dos candidatos idénticos en lo relevante producen el mismo resultado exacto. `talent.test.ts` (+4): RBAC 403 sin `candidates.view`; documento faltante → `missing_required_document`, `Candidate.status` nunca cambia (verificado directo contra Prisma); documento `VERIFIED` vigente → sin disqualifiers de documento; categoría distinta → `category_mismatch`.

### 8.3 Suite completa

807 tests, 801 pass, 1 fail preexistente sin relación (`prospecting.test.ts`), 5 skip (4 gateados por real-provider-tests + 1 preexistente sin relación).

### 8.4 UI

Ninguna en esta subfase — igual que F8.1, se surfacea en F8.11 (Recruiting Mission UI).

### 8.5 Migraciones

Ninguna.

### 8.6 Limitaciones conocidas

- `JobOrder` no persiste experiencia mínima/idiomas requeridos todavía (ver 8.1) -- esos dos gaps quedan siempre `false`/`[]` hasta que se agregue esa columna, decisión conservadora documentada en vez de una migración apurada.
- La persistencia del estado de 4 valores (QUALIFIED/POSSIBLY_QUALIFIED/NEEDS_REVIEW/NOT_QUALIFIED) es F8.5, deliberadamente no implementada acá.

### 8.7 Commit

`feat: F8.2 — job requirements and qualification rules`.

**F8.2 completo.**

---

## 9. Resultado de F8.3 — Candidate Sourcing

### 9.1 Arquitectura

- **`recruiting-intelligence/candidate-sourcing.ts`** (puro) — `sourceCandidatesForJob()`: filtra y ordena una lista de Candidate YA existentes en el tenant (única fuente permitida -- nunca scraping externo, nunca un candidato inventado). Excluye status `REJECTED`/`INACTIVE` y cualquier candidato sin la categoría exacta requerida (razón explícita en `excluded`). Score de relevancia (0-1) por: categoría (base 0.5), mismo estado que el Job Order (+0.25), años de experiencia (+hasta 0.25) -- nunca una exclusión dura por experiencia/ubicación, solo prioridad.
- **`talent/service.ts` → `sourceCandidatesForJobOrder()`** (impuro) — única fuente de datos: `scopedDb.candidate` filtrado por la categoría del Job Order (nunca trae candidatos de otro tenant ni de fuera del CRM). Solo lectura -- nunca crea, contacta, ni cambia `Candidate.status`.
- **`GET /job-orders/:jobOrderId/source-candidates`** (`candidates.view` + `jobOrders.view`) — nuevo endpoint, solo lectura.

### 9.2 Tests — 14 nuevos (todos passing)

`candidate-sourcing.test.ts` (11): categoría coincide/no coincide; REJECTED/INACTIVE siempre excluidos; NEW/SCREENING/QUALIFIED/PLACED nunca excluidos solo por status; mismo estado puntúa más alto; más experiencia puntúa más alto pero nunca excluye; orden descendente por score; score acotado [0,1]; reasons siempre no vacío; determinismo; versión estable. `talent.test.ts` (+3): RBAC 403 sin `candidates.view`; sourcing real incluye/excluye correctamente por categoría, `Candidate.status` nunca cambia; candidato `REJECTED` excluido aunque su categoría coincida.

### 9.3 Suite completa

821 tests, 815 pass, 1 fail preexistente sin relación (`prospecting.test.ts`), 5 skip (4 gateados por real-provider-tests + 1 preexistente sin relación).

### 9.4 UI

Ninguna en esta subfase — igual que F8.1/F8.2, se surfacea en F8.11.

### 9.5 Migraciones

Ninguna.

### 9.6 Limitaciones conocidas

- El score de relevancia es una heurística fija (pesos 0.5/0.25/0.25), no calibrada contra resultados de colocación reales.
- El endpoint trae hasta `limit*3` candidatos antes de filtrar (margen para lo excluido por status) -- en un tenant con un catálogo de candidatos muy grande por categoría, esto podría acercarse al límite de 100 sin agotar el pool real; documentado como límite pragmático, no un bug.

### 9.7 Commit

`feat: F8.3 — candidate sourcing`.

**F8.3 completo.**

## 10. Resultado de F8.4 — Candidate Normalization and Deduplication

### 10.1 Arquitectura

- **`recruiting-intelligence/candidate-identity.ts`** (nuevo, puro) — mirrorea exactamente el patrón de `ceo-intelligence/discovery-identity.ts` (F7.3): `normalizeCandidateEmail()`/`normalizeCandidatePhone()` (movidas desde `talent/service.ts`, comportamiento preservado byte a byte), `CandidateIdentityInput`/`CandidateIdentityKeys`, `buildCandidateIdentityKeys()`, y `deduplicateCandidates()` (utilidad de dedup en batch para futuros flujos de import/sourcing masivo, no usada todavía por `createCandidate`).
- **Clave nueva**: `normalizedNameState` (firstName+lastName+state, case/espacio-insensible) -- null cuando falta el state, para no generar falsos positivos con nombres comunes (`"John Smith"` sin ubicación conocida nunca matchea contra sí mismo).
- **`talent/service.ts` → `findDuplicateCandidate()`** (impuro) — ahora importa las normalizaciones desde el módulo puro (dirección de dependencia correcta: impuro → puro, nunca al revés) y agrega un tercer chequeo por `normalizedNameState` cuando no hay match por email/phone. El comportamiento existente (409 conflict al crear, nunca merge silencioso) se preserva exacto -- ver F5.2. La limitación conocida y ya aceptada por el PO ("no agregues un índice único todavía sin proponerlo aparte") sigue documentada, no resuelta.
- `updateCandidate()` no se tocó -- fuera de alcance de F8.4 (solo se refuerza el dedup en creación, igual que antes).

### 10.2 Archivos modificados

- Nuevo: `recruiting-intelligence/candidate-identity.ts`, `recruiting-intelligence/candidate-identity.test.ts`.
- Modificado: `talent/service.ts` (refactor de `findDuplicateCandidate` + `createCandidate`), `talent/talent.test.ts` (+2 tests de integración).

### 10.3 Contratos

Sin cambios en schemas de `@ai-staffing-os/shared` ni en endpoints -- `POST /candidates` sigue devolviendo 409 con `details.existingCandidateId` en cualquier duplicado (email, phone, o ahora también nombre+estado). Único cambio observable: el texto del mensaje de error pasó de mencionar solo "email or phone" a "email, phone, or name and state", para reflejar el nuevo criterio -- ningún test depende del texto exacto.

### 10.4 UI

Ninguna en esta subfase -- el 409 ya se maneja en el formulario de creación existente (sin cambios).

### 10.5 Tests — 17 nuevos (todos passing)

`candidate-identity.test.ts` (15): normalización de email/phone (incl. código de país, casos límite de 11 dígitos); `buildCandidateIdentityKeys` con/sin email/phone/state; `normalizedNameState` case/espacio-insensible y null cuando falta state; `deduplicateCandidates` con orden fijo de claves (email > phone > nameState), `existingKeys` para chequear contra DB, y ausencia de falsos positivos con nombres comunes sin state. `talent.test.ts` (+2): mismo firstName+lastName+state sin email/phone en común sigue rechazado con 409; mismo firstName+lastName SIN state en ninguno de los dos NO se rechaza (evita falso positivo).

### 10.6 Suite completa

838 tests, 832 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, llamada real a OpenAI), 5 skip (4 gateados por real-provider-tests + 1 preexistente sin relación) -- cero regresiones.

### 10.7 Migraciones

Ninguna.

### 10.8 Limitaciones conocidas

- La limitación de F5.2 sigue vigente sin resolver por instrucción explícita del PO: no hay índice único en DB sobre email/phone/nombre+estado, por lo que persiste una race condition teórica entre dos creaciones concurrentes del mismo candidato.
- `normalizedNameState` no cubre variantes de nombre (apodos, segundos nombres, typos) -- es un match exacto normalizado, no fuzzy.
- `deduplicateCandidates()` (utilidad batch) queda lista pero sin consumidor todavía -- se habilitará cuando F8 agregue un flujo de import masivo, si el plan lo requiere.

### 10.9 Commit

`feat: F8.4 — candidate normalization and deduplication`.

**F8.4 completo.**

## 11. Resultado de F8.5 — Estados de calificación con razones auditables

### 11.1 Arquitectura

- **`recruiting-intelligence/qualification-status.ts`** (nuevo, puro) — `deriveQualificationStatus()`: deriva el estado de 4 valores (`QUALIFIED`/`POSSIBLY_QUALIFIED`/`NEEDS_REVIEW`/`NOT_QUALIFIED`) a partir del `QualificationEvaluationResult` que ya produce F8.2, SIN modificar `qualification-rules.ts` (queda cerrado, sin tocar). Regla: `NOT_QUALIFIED` si hay un disqualifier duro no recuperable en el corto plazo (estado inelegible/categoría no coincide/documento vencido); `NEEDS_REVIEW` si el ÚNICO disqualifier es un documento faltante/no verificado (recuperable con acción humana); `POSSIBLY_QUALIFIED` si solo hay gaps blandos (experiencia/idiomas); `QUALIFIED` si no hay ninguno.
- **Nuevo modelo `CandidateQualification`** (schema, aditivo) — un registro por par `(candidateId, jobOrderId)` (`@@unique`), con `status`, `reasons`, `hardDisqualifiers`, `rulesVersion`, `evaluatedById`. Es el estado ACTUAL (upsert en cada evaluación); el historial de cambios vive en `AuditLog` (mismo patrón que `Candidate.status`).
- **`talent/service.ts` → `persistCandidateQualification()`** (impuro, nuevo) — evalúa (reutiliza `runQualificationEvaluation`, extraída de la función de F8.2) + deriva estado + hace upsert. Nunca cambia `Candidate.status`. **`getCandidateQualification()`** (nuevo) — solo lee lo ya persistido, nunca re-evalúa ni crea.
- **Hallazgo de auditoría durante la implementación**: el constraint compuesto `@@unique([candidateId, jobOrderId])` no puede usarse con `scopedDb.findUnique`/`upsert` -- la extensión de tenancy (`prisma-extension.ts`) redirige esas operaciones a `findFirst` para poder inyectar el filtro de tenant (ver comentario ya existente en el archivo), y `findFirst` no reconoce el nombre de clave compuesta (`candidateId_jobOrderId`), solo `findUnique` real lo acepta. Mismo límite ya documentado y resuelto en `payroll/service.ts` (`TimeEntry`, F5.6): se usa `findFirst` con campos planos + `update`/`create` manual por `id` en vez de `upsert`. No es un bug nuevo, es una restricción arquitectónica preexistente respetada, no un F7 tocado.
- **`GET /candidates/:id/qualification/:jobOrderId`** (F8.2, sin cambios) sigue siendo solo evaluación. **`POST /candidates/:id/qualification/:jobOrderId`** (nuevo) evalúa y persiste — requiere `candidates.update` (no solo `view`) porque escribe. **`GET /candidates/:id/qualification/:jobOrderId/status`** (nuevo) lee lo persistido, 404 si nunca se evaluó.

### 11.2 Archivos modificados

- Nuevo: `recruiting-intelligence/qualification-status.ts`, `qualification-status.test.ts`, migración `20260717120000_f8_5_candidate_qualification`.
- Modificado: `packages/db/prisma/schema.prisma` (enum `QualificationStatus` + modelo `CandidateQualification` + back-relations en `Candidate`/`JobOrder`), `core/tenancy/prisma-extension.ts` (+1 línea, `CandidateQualification` en `STRICT_TENANT_MODELS`), `talent/service.ts`, `talent/router.ts`, `talent/talent.test.ts`.

### 11.3 Contratos

- Nuevos endpoints (sin cambios de schema en `@ai-staffing-os/shared` -- mismo criterio que F8.2/F8.3, DTOs locales al service). `POST` devuelve 201 con `CandidateQualificationRecord` (`id, candidateId, jobOrderId, status, reasons, hardDisqualifiers, rulesVersion, evaluatedById, createdAt, updatedAt`). `GET .../status` devuelve el mismo shape o 404.

### 11.4 UI

Ninguna en esta subfase -- igual que F8.1-F8.4, se surfacea en F8.11.

### 11.5 Tests — 17 nuevos (todos passing)

`qualification-status.test.ts` (11): las 4 combinaciones de estado incl. prioridad correcta cuando coexisten un disqualifier duro y uno de documento faltante; passthrough exacto de `reasons`/`hardDisqualifiers`/`rulesVersion`. `talent.test.ts` (+6): RBAC 403 sin `candidates.update` en el POST; persistencia de `NOT_QUALIFIED` con razones auditables y sin tocar `Candidate.status`; `NEEDS_REVIEW` cuando el único disqualifier es documento faltante; `QUALIFIED` + upsert real (re-evaluar el mismo par actualiza la MISMA fila, nunca crea una segunda); `GET .../status` 404 antes de evaluar y 200 con los datos correctos después; escritura de `AuditLog` en cada persistencia.

### 11.6 Suite completa

855 tests, 849 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip (4 gateados + 1 preexistente) -- cero regresiones. Typecheck y lint limpios.

### 11.7 Migraciones

`20260717120000_f8_5_candidate_qualification` -- 100% aditiva: 1 enum nuevo (`QualificationStatus`), 1 tabla nueva (`CandidateQualification`) con 2 FKs (`Candidate`, `JobOrder`, ambas `ON DELETE RESTRICT` por default de Prisma), 1 índice compuesto, 1 índice único compuesto. Cero columnas nuevas en tablas existentes, cero datos migrados/backfilleados.

### 11.8 Limitaciones conocidas

- Las FKs son `ON DELETE RESTRICT` (default) -- borrar un `Candidate` o `JobOrder` con calificaciones persistidas falla hasta borrar primero su `CandidateQualification`; documentado en el comentario de limpieza de `talent.test.ts`, no resuelto con cascada automática para no perder auditoría silenciosamente.
- El mapeo `NEEDS_REVIEW` depende de que F8.2 siga usando el prefijo `"missing_required_document:"` como único código para documentos faltantes -- si F8.2 cambia esa convención en el futuro, `qualification-status.ts` debe revisarse (acoplamiento documentado, no oculto).
- No hay endpoint de "evaluar en batch" (todos los candidatos contra un Job Order) -- cada llamada es un par puntual; se evalúa si hace falta en una subfase posterior (F8.7 Shortlist parece el lugar natural).

### 11.9 Commit

`feat: F8.5 — persisted qualification status with auditable reasons`.

**F8.5 completo.**
