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

## 12. Resultado de F8.6 — Matching and Ranking

### 12.1 Decisión de arquitectura (documentada antes de implementar)

Auditoría previa: `matching/scoring.ts` (F6.3) puntúa `Worker` YA contratados -- requiere `complianceStatus`, `defaultPayRate`, `assignmentHistory` y disponibilidad por fechas de `Assignment`, ninguno de los cuales existe para un `Candidate` en etapa de reclutamiento (anterior a convertirse en `Worker`, mismo criterio ya establecido en F8.2). Extender/reescribir ese motor habría exigido fabricar valores falsos para esos campos -- inventar datos en un score que se presenta como real, explícitamente prohibido por la autorización de esta sesión. **Decisión (conservadora, documentada, no una reescritura innecesaria)**: nuevo módulo puro `recruiting-intelligence/candidate-matching.ts` que REUTILIZA el patrón arquitectónico de F6.3 (constraints duros antes de puntuar, factores blandos ponderados con evidencia, empate determinista) y REUTILIZA DIRECTAMENTE -- sin duplicar -- la salida ya calculada por F8.2 (`QualificationEvaluationResult`) y F8.5 (`PersistedQualificationStatus`) como únicos insumos de "hard constraints". `matching/scoring.ts` queda sin tocar.

### 12.2 Arquitectura

- **`recruiting-intelligence/candidate-matching.ts`** (nuevo, puro): `computeCandidateMatch()` (un candidato) + `computeCandidateMatching()` (batch, rankea). 5 factores blandos ponderados sumando 100 (documentReadiness 30, experience 25, location 20, languages 15, dataRecency 10 -- fórmulas mirror de F6.3 donde aplica, adaptadas a los datos disponibles de un Candidate pre-hire). Un candidato `NOT_QUALIFIED` nunca se puntúa parcialmente: score 0, `rank: null`, va a `excluded`, nunca a `ranked`. `NEEDS_REVIEW` rankea normal con `needsReview: true`. `POSSIBLY_QUALIFIED` rankea con sus gaps listados en `risks`. Empate resuelto por `normalizedScore` desc, luego `candidateId` asc.
- **Nuevo modelo `CandidateMatch`** (schema, aditivo, mismo patrón que `CandidateQualification`): un registro por par `(candidateId, jobOrderId)`, `softPreferences` en `Json` (arreglo heterogéneo de factores, mismo criterio que `JobOrder.requirements`/`AgentTask.output`).
- **`talent/service.ts` → `computeAndPersistCandidateMatching()`** (impuro, nuevo): filtra candidatos por la categoría del Job Order (mismo criterio que F8.3), reutiliza `runQualificationEvaluation` (F8.2, sin duplicar) por candidato, deriva estado (F8.5, sin duplicar), calcula el ranking y hace upsert de un `CandidateMatch` por candidato. **`getPersistedCandidateMatching()`** (nuevo): solo lee lo ya persistido, nunca recalcula.
- Mismo workaround ya documentado en F8.5 para el constraint único compuesto (`findFirst` por campos planos + `update`/`create` por `id`, nunca `upsert`/`findUnique` con el nombre compuesto).
- **`POST /job-orders/:jobOrderId/matching`** (nuevo, `candidates.update`+`jobOrders.view`, calcula y persiste) y **`GET /job-orders/:jobOrderId/matching`** (nuevo, `candidates.view`+`jobOrders.view`, solo lectura, 404 si nunca se corrió).

### 12.3 Archivos modificados

- Nuevo: `candidate-matching.ts`, `candidate-matching.test.ts`, migración `20260717130000_f8_6_candidate_matching`.
- Modificado: `schema.prisma` (enum `MatchConfidence` + modelo `CandidateMatch` + back-relations), `core/tenancy/prisma-extension.ts` (+1 línea), `talent/service.ts`, `talent/router.ts`, `talent/talent.test.ts`.

### 12.4 Contratos

DTOs locales al service (mismo criterio que F8.2/F8.3/F8.5, sin cambios en `@ai-staffing-os/shared`). `POST` devuelve 201 con `{ jobOrderId, ranked[], excluded[], rulesVersion, calculatedAt }`; cada item incluye `candidateId/qualificationStatus/recommendable/needsReview/hardConstraints/softPreferences/score/normalizedScore/rank/explanation/confidence/missingData/risks/evidence/rulesVersion/calculatedAt`.

### 12.5 UI

Ninguna en esta subfase -- se surfacea en F8.11.

### 12.6 Tests — 25 nuevos (todos passing)

`candidate-matching.test.ts` (19): pesos suman 100; NOT_QUALIFIED nunca recomendable/rankeado/puntuado; NEEDS_REVIEW/POSSIBLY_QUALIFIED/QUALIFIED se comportan según la regla; cada factor blando aislado (documentReadiness, experience, location, languages, dataRecency); missingData/confidence; hardConstraints pasa sin re-derivar; evidence auditable; determinismo (mismo input -> mismo output); empate resuelto por candidateId; fairness (ninguna clave del input/output referencia un atributo protegido). `talent.test.ts` (+6): RBAC 403; NOT_QUALIFIED excluido nunca rankeado + `Candidate.status` intacto; idempotencia (upsert, nunca duplica fila); GET lee lo persistido ordenado por rank; AuditLog escrito.

### 12.7 Suite completa

880 tests, 874 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones. Typecheck y lint limpios.

### 12.8 Migraciones

`20260717130000_f8_6_candidate_matching` -- 100% aditiva: 1 enum nuevo (`MatchConfidence`), 1 tabla nueva (`CandidateMatch`) con 2 FKs (`ON DELETE RESTRICT`, mismo default que F8.5), 1 índice compuesto, 1 índice único compuesto. Cero columnas nuevas en tablas existentes.

### 12.9 Limitaciones conocidas

- `computeAndPersistCandidateMatching` vuelve a leer el `JobOrder` desde la DB en cada llamada a `runQualificationEvaluation` (una por candidato) -- redundante pero deliberado: reutilizar la función tal cual es más seguro que duplicar su lógica para optimizar, dado el volumen bajo de candidatos por categoría en este CRM.
- El filtro de candidatos es por categoría exacta (mismo criterio que F8.3) -- un candidato sin ninguna categoría asociada al Job Order nunca se evalúa ni aparece en `excluded`, ni siquiera con razón "category_mismatch" (evita evaluar el pool completo del tenant en cada corrida).
- Las FKs son `ON DELETE RESTRICT` -- mismo tradeoff ya documentado en F8.5 (preferir un borrado explícito primero antes que perder auditoría con cascada silenciosa).

### 12.10 Commit

`feat: F8.6 — candidate matching and ranking`.

**F8.6 completo.**

## 13. Resultado de F8.7 — Candidate Shortlist

### 13.1 Arquitectura

- **`recruiting-intelligence/candidate-shortlist.ts`** (nuevo, puro): `buildShortlistEntries()` mapea el ranking YA calculado por F8.6 (solo `ranked`, nunca `excluded`/NOT_QUALIFIED) a drafts de shortlist, siempre arrancando en `DRAFT`. `SHORTLIST_REVIEW_TRANSITIONS` (grafo explícito, mismo criterio que `CANDIDATE_STATUS_TRANSITIONS` de F5.2) + `isValidShortlistTransition()` + `isShortlistReviewStatus()` (type guard de runtime para validar el body de un request). `REMOVED` SIEMPRE puede reabrirse a `DRAFT` -- nunca un rechazo permanente, cumpliendo la restricción explícita de esta subfase.
- **Nuevo modelo `CandidateShortlistEntry`** (schema, aditivo, mismo patrón que `CandidateQualification`/`CandidateMatch`): un registro por par `(candidateId, jobOrderId)`. Los campos `rank/score/qualificationStatus/confidence/reasons/gaps/risks` son un SNAPSHOT del momento de generación/regeneración -- nunca un join en vivo contra `CandidateMatch`.
- **`talent/service.ts` → `generateShortlistForJobOrder()`** (impuro, nuevo): reutiliza `getPersistedCandidateMatching` (F8.6, sin duplicar) -- si nunca se corrió matching para el Job Order, esto ya lanza 404, forzando el orden correcto del pipeline (matching antes de shortlist). Al regenerar, actualiza el snapshot de entradas ya existentes pero **nunca toca `reviewStatus`** -- una decisión humana ya tomada nunca se revierte automáticamente (verificado con test de integración real). **`getShortlistForJobOrder()`** (solo lectura) y **`updateShortlistEntryReviewStatus()`** (único camino para cambiar el estado, valida la transición antes de escribir).
- **`POST /job-orders/:jobOrderId/shortlist`** (genera/refresca, `candidates.update`+`jobOrders.view`), **`GET /job-orders/:jobOrderId/shortlist`** (solo lectura, `candidates.view`+`jobOrders.view`), **`PATCH /shortlist/:entryId/review-status`** (`candidates.update`, valida transición, 400 si es inválida o el valor no es uno de los 5 estados reales).
- **Reordenamiento**: no se implementó un reorder manual (drag-and-drop) separado -- el orden ya es determinista de origen (F8.6) y regenerar la shortlist resincroniza `rank` desde el ranking más reciente. Decisión conservadora: agregar reorder manual habría requerido decidir qué pasa cuando un humano reordena mid-review sin invalidar el ranking subyacente, sin alcance claro en la instrucción; se documenta como deuda técnica, no como bloqueo.

### 13.2 Archivos modificados

- Nuevo: `candidate-shortlist.ts`, `candidate-shortlist.test.ts`, migración `20260717140000_f8_7_candidate_shortlist`.
- Modificado: `schema.prisma` (enum `ShortlistReviewStatus` + modelo `CandidateShortlistEntry` + back-relations), `core/tenancy/prisma-extension.ts` (+1 línea), `talent/service.ts`, `talent/router.ts`, `talent/talent.test.ts`.

### 13.3 Contratos

DTOs locales al service (mismo criterio que el resto de F8). `POST`/`GET` devuelven un arreglo de `ShortlistEntryRecord` (`id/candidateId/jobOrderId/rank/score/normalizedScore/qualificationStatus/confidence/reasons/gaps/risks/reviewStatus/addedById/addedAt/updatedAt`). `PATCH` recibe `{ reviewStatus }` en el body, devuelve la entrada actualizada.

### 13.4 UI

Ninguna en esta subfase -- se surfacea en F8.11.

### 13.5 Tests — 24 nuevos (todos passing)

`candidate-shortlist.test.ts` (14): mapeo 1:1 desde el ranking siempre arrancando en DRAFT; preserva rank/score/qualificationStatus/confidence; mapea risks/missingData/explanation a risks/gaps/reasons; orden preservado; lista vacía; transiciones válidas/inválidas (idempotencia, REMOVED reabre a DRAFT pero nunca salta directo a APPROVED, DRAFT nunca salta directo a APPROVED, todo estado puede llegar a REMOVED); type guard de reviewStatus. `talent.test.ts` (+10): RBAC 403; 404 si no se corrió matching antes (orden del pipeline); genera shortlist excluyendo NOT_QUALIFIED, nunca toca `Candidate.status`; idempotencia + preserva un reviewStatus ya establecido manualmente al regenerar (bug real encontrado y corregido durante la implementación, ver más abajo); transición inválida rechazada con 400; REMOVED reabre a DRAFT; reviewStatus inválido rechazado con 400; GET ordenado por rank; AuditLog en generación y en cambio de reviewStatus.

**Hallazgo real durante la implementación (bug de test, no de producción)**: el primer test de idempotencia asumía que la entrada `[0]` de la shortlist correspondía siempre al candidato recién creado por el test -- falso, porque el tenant de test ya tiene múltiples candidatos reales de la categoría forklift-operator desde el seed de F0, así que la shortlist de cualquier Job Order de esa categoría tiene más de una entrada. Diagnosticado con un script de reproducción aislado (llamando directamente a las funciones del service, sin HTTP) que confirmó que el código de producción preserva `reviewStatus` correctamente; el test se corrigió para ubicar la entrada por `candidateId` exacto en vez de asumir la primera posición del arreglo.

### 13.6 Suite completa

903 tests, 897 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones. Typecheck y lint limpios.

### 13.7 Migraciones

`20260717140000_f8_7_candidate_shortlist` -- 100% aditiva: 1 enum nuevo (`ShortlistReviewStatus`), 1 tabla nueva (`CandidateShortlistEntry`) con 2 FKs (`ON DELETE RESTRICT`), 1 índice compuesto, 1 índice único compuesto. Cero columnas nuevas en tablas existentes.

### 13.8 Limitaciones conocidas

- Sin reorder manual independiente del ranking (ver §13.1) -- deuda técnica documentada, no bloqueo.
- Igual que F8.5/F8.6, las FKs son `ON DELETE RESTRICT` -- requiere borrar la shortlist antes que el Candidate/JobOrder.
- Regenerar la shortlist nunca elimina una entrada cuyo candidato dejó de estar en `ranked` (p.ej. si una recalificación posterior lo vuelve NOT_QUALIFIED) -- la entrada existente queda intacta con su snapshot antiguo hasta que un humano la mueva a `REMOVED`; decisión conservadora (nunca borrar trabajo humano en curso automáticamente), documentada explícitamente.

### 13.9 Commit

`feat: F8.7 — reviewable candidate shortlists`.

**F8.7 completo.**

## 14. Resultado de F8.8 — Screening Intelligence

### 14.1 Arquitectura

- **`recruiting-intelligence/screening-plan.ts`** (nuevo, puro): `buildScreeningPlan()` genera un plan de preguntas para UN candidato contra UN Job Order, reutilizando DIRECTAMENTE `QualificationEvaluationResult` (F8.2) y `PersistedQualificationStatus` (F8.5) -- nunca vuelve a evaluar documentos/categoría/experiencia. 3 preguntas base siempre presentes (disponibilidad, experiencia, cumplimiento operativo) + preguntas condicionales (`document_readiness` si hay documentos faltantes/vencidos, `experience_gap_probe` si `experienceGap`, `language_verification` si hay `languageGaps`). Cada pregunta incluye `rationale` y `expectedEvidence` explícitos -- nunca una pregunta sin justificación. `ALLOWED_DISQUALIFIERS` es una lista blanca FIJA de política (no derivada del candidato), explícitamente sin atributos protegidos.
- **Nuevo modelo `ScreeningPlan`** (schema, aditivo, mismo patrón que `CandidateQualification`/`CandidateMatch`/`CandidateShortlistEntry`): un registro por par `(candidateId, jobOrderId)`, `questions` en `Json` (mismo criterio que `CandidateMatch.softPreferences`). Nunca contiene respuestas ni un veredicto -- el screening real y la decisión son responsabilidad humana.
- **`talent/service.ts` → `generateAndPersistScreeningPlan()`** (impuro, nuevo): reutiliza `runQualificationEvaluation` (sin duplicar) + la categoría real del Job Order (`jobOrder.category.name`) para el texto de las preguntas. **`getScreeningPlan()`** (solo lectura, nunca regenera).
- **`POST /candidates/:id/screening-plan/:jobOrderId`** (`candidates.update`+`jobOrders.view`, genera y persiste) y **`GET /candidates/:id/screening-plan/:jobOrderId`** (`candidates.view`+`jobOrders.view`, solo lectura, 404 si nunca se generó).

### 14.2 Archivos modificados

- Nuevo: `screening-plan.ts`, `screening-plan.test.ts`, migración `20260717150000_f8_8_screening_plan`.
- Modificado: `schema.prisma` (modelo `ScreeningPlan` + back-relations), `core/tenancy/prisma-extension.ts` (+1 línea), `talent/service.ts`, `talent/router.ts`, `talent/talent.test.ts`.

### 14.3 Contratos

DTOs locales al service (mismo criterio que el resto de F8). `POST`/`GET` devuelven `ScreeningPlanRecord` (`id/candidateId/jobOrderId/questions/allowedDisqualifiers/manualReviewFlags/missingInformation/riskFlags/rulesVersion/calculatedAt/generatedById/createdAt/updatedAt`).

### 14.4 UI

Ninguna en esta subfase -- se surfacea en F8.11.

### 14.5 Tests — 19 nuevos (todos passing)

`screening-plan.test.ts` (13): las 3 preguntas base siempre presentes; cada pregunta condicional aparece según su gap correspondiente; toda pregunta tiene rationale/expectedEvidence no vacíos; manualReviewFlags refleja NEEDS_REVIEW/NOT_QUALIFIED únicamente; missingInformation/riskFlags reflejan los hechos de qualification sin re-derivarlos; `allowedDisqualifiers` es una lista fija idéntica sin importar el candidato; determinismo; **fairness explícita sobre el TEXTO generado** (no solo nombres de campo) recorriendo 7 combinaciones de gaps distintas contra una lista de 20+ términos prohibidos (raza/género/edad/religión/nacionalidad/discapacidad/embarazo/estado civil/antecedentes penales/estatus migratorio, en español e inglés); fairness de `allowedDisqualifiers`. `talent.test.ts` (+6): RBAC 403; 404 antes de generar; genera plan real con categoría real y pregunta de documento cuando falta uno requerido, nunca toca `Candidate.status`; idempotencia; GET lee sin regenerar; AuditLog escrito.

### 14.6 Suite completa

922 tests, 916 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones. Typecheck y lint limpios.

### 14.7 Migraciones

`20260717150000_f8_8_screening_plan` -- 100% aditiva: 1 tabla nueva (`ScreeningPlan`) con 2 FKs (`ON DELETE RESTRICT`), 2 índices. Cero columnas nuevas en tablas existentes, cero enum nuevo.

### 14.8 Limitaciones conocidas

- Las preguntas son plantillas de texto fijo (con interpolación de categoría/documentos/idiomas) -- no hay generación por LLM, deliberado (determinismo y ausencia total de alucinación en preguntas de screening es más importante que variedad de redacción).
- Igual que F8.5-F8.7, las FKs son `ON DELETE RESTRICT`.
- No hay endpoint para registrar/persistir RESPUESTAS del candidato -- fuera de alcance explícito de esta subfase (el plan es solo preparación, nunca el screening real).

### 14.9 Commit

`feat: F8.8 — screening intelligence`.

**F8.8 completo.**

## 15. Resultado de F8.9 — Interview Scheduling Preview

### 15.1 Arquitectura

- **`recruiting-intelligence/interview-preview.ts`** (nuevo, puro): `buildInterviewPreview()` valida completitud (ventanas propuestas, duración, timezone, ubicación/enlace requerido según modalidad, participantes) y detecta conflictos contra otras previews YA persistidas del MISMO candidato -- **reutiliza `matching/date-overlap.ts` (F6.2) para la comparación de solapamiento, sin duplicar esa lógica**. Las ventanas propuestas/participantes/restricciones son SIEMPRE input humano, nunca inventados. `availabilityConfirmed` es literalmente el tipo `false` (constante) -- documentado explícitamente para que ninguna capa pueda presentarlo como disponibilidad real sin integración de calendario (que no existe en este proyecto).
- Estado derivado (`computeInterviewPreviewStatus`): `NEEDS_AVAILABILITY` (sin ventanas), `DRAFT` (falta info o hay conflictos), `READY_FOR_APPROVAL` (todo completo, sin conflictos) -- **nunca** deriva automáticamente `APPROVED_FOR_SEND` ni `CANCELLED`, esos son SIEMPRE una transición manual explícita vía `INTERVIEW_PREVIEW_TRANSITIONS` + `isValidInterviewPreviewTransition()` (mismo patrón que F8.7).
- **Nuevo modelo `InterviewPreview`** (schema, aditivo, mismo patrón que el resto de F8): un registro por par `(candidateId, jobOrderId)`.
- **`talent/service.ts` → `generateAndPersistInterviewPreview()`** (impuro, nuevo): lee otras previews del mismo candidato en OTROS Job Orders para detectar conflictos reales (nunca inventa disponibilidad). **`getInterviewPreview()`** (solo lectura) y **`updateInterviewPreviewStatus()`** (único camino para `APPROVED_FOR_SEND`/`CANCELLED`, valida la transición).
- **`POST /candidates/:id/interview-preview/:jobOrderId`** (genera+persiste, `candidates.update`+`jobOrders.view`, valida el shape del body), **`GET /candidates/:id/interview-preview/:jobOrderId`** (solo lectura), **`PATCH /candidates/:id/interview-preview/:jobOrderId/status`** (cambio manual de estado, `candidates.update`).
- **Restricciones cumplidas explícitamente**: cero llamadas a Google Calendar/cualquier API externa, cero envío de email/SMS/invitación, cero creación de reunión externa, `APPROVED_FOR_SEND` es solo un registro de aprobación humana -- nunca dispara un envío real (no existe ese sistema todavía, documentado como límite explícito).

### 15.2 Archivos modificados

- Nuevo: `interview-preview.ts`, `interview-preview.test.ts`, migración `20260717160000_f8_9_interview_preview`.
- Modificado: `schema.prisma` (enums `InterviewModality`/`InterviewPreviewStatus` + modelo `InterviewPreview` + back-relations), `core/tenancy/prisma-extension.ts` (+1 línea), `talent/service.ts`, `talent/router.ts`, `talent/talent.test.ts`.

### 15.3 Contratos

DTOs locales al service. `POST` body: `{ proposedWindows[{start,end}], durationMinutes, timezone, modality, locationOrLink?, participants[{role,name}], restrictions? }`, validado en el router (400 si el shape es inválido). `POST`/`GET` devuelven `InterviewPreviewRecord`. `PATCH .../status` body: `{ status }`.

### 15.4 UI

Ninguna en esta subfase -- se surfacea en F8.11, mostrando explícitamente "PREVIEW"/"DRAFT" de forma visible como pide la instrucción.

### 15.5 Tests — 25 nuevos (todos passing)

`interview-preview.test.ts` (16): NEEDS_AVAILABILITY sin ventanas; DRAFT con info faltante (incl. VIDEO sin link); PHONE nunca requiere link; READY_FOR_APPROVAL cuando todo está completo; DRAFT + conflicto real detectado contra otra preview persistida; sin conflicto cuando no hay solapamiento; `availabilityConfirmed` siempre `false`; participantes/restricciones nunca inventados (passthrough); determinismo; transiciones válidas/inválidas (APPROVED_FOR_SEND solo desde READY_FOR_APPROVAL, CANCELLED alcanzable desde cualquier estado no-terminal y reabre a DRAFT, CANCELLED nunca salta directo a APPROVED_FOR_SEND). `talent.test.ts` (+9): RBAC 403; 404 antes de generar; 400 con body malformado; genera preview real con READY_FOR_APPROVAL + availabilityConfirmed=false, nunca toca Candidate.status; NEEDS_AVAILABILITY sin ventanas; conflicto real detectado entre dos Job Orders distintos para el mismo candidato; idempotencia; PATCH válido (READY_FOR_APPROVAL->APPROVED_FOR_SEND) vs inválido (NEEDS_AVAILABILITY->APPROVED_FOR_SEND) rechazado con 400; AuditLog en generación y en cambio de estado.

### 15.6 Suite completa

947 tests, 941 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones. Typecheck y lint limpios.

### 15.7 Migraciones

`20260717160000_f8_9_interview_preview` -- 100% aditiva: 2 enums nuevos (`InterviewModality`, `InterviewPreviewStatus`), 1 tabla nueva (`InterviewPreview`) con 2 FKs (`ON DELETE RESTRICT`), 2 índices. Cero columnas nuevas en tablas existentes.

### 15.8 Limitaciones conocidas

- La detección de conflictos solo compara contra OTRAS `InterviewPreview` ya persistidas del mismo candidato -- no contra un calendario real (no existe integración), documentado explícitamente, no un bug.
- Igual que el resto de F8, las FKs son `ON DELETE RESTRICT`.
- `APPROVED_FOR_SEND` no dispara ningún envío real -- es intencional (no hay sistema de notificaciones para esto todavía); queda como el punto de enganche futuro si se decide integrar calendario/email real, fuera de alcance de esta sesión.

### 15.9 Commit

`feat: F8.9 — interview scheduling preview`.

**F8.9 completo.**

## 16. Resultado de F8.10 — Placement Readiness

### 16.1 Arquitectura

- **`recruiting-intelligence/placement-readiness.ts`** (nuevo, puro): `computePlacementReadiness()` agrega el estado YA calculado por F8.5 (qualification), F8.7 (shortlist), F8.8 (screening) y F8.9 (interview preview) -- nunca los recalcula. 8 checks evaluados en orden fijo (qualification, documentos, shortlist, screening, interview, ubicación, fecha de inicio, compensación). Cada check clasifica en `completedChecks`/`pendingChecks`/`blockers`/`warnings`/`missingInformation` según una regla explícita y documentada -- nunca un cálculo oculto.
- **4 estados con prioridad fija**: `NOT_READY` (bloqueador DURO: NOT_QUALIFIED, documento vencido, o interview CANCELLED -- ninguno recuperable en el corto plazo) > `NEEDS_REVIEW` (bloqueador recuperable: NEEDS_REVIEW de calificación, documento faltante, o removido de shortlist) > `CONDITIONALLY_READY` (solo warnings o checks pendientes) > `READY_FOR_APPROVAL` (todo completo, cero warnings). `requiresApproval` es el tipo literal `true` -- esta función JAMÁS autoriza una acción automática, sin importar el estado.
- **Compensación**: no existe un campo de expectativa salarial del candidato en el schema -- en vez de inventar un valor o comparación falsa, se documenta SIEMPRE en `missingInformation` la ausencia de ese dato, nunca se penaliza ni se asume.
- **`nextBestAction`**: una sola acción sugerida, prioridad fija y determinista (mismo criterio que `deduplicateDiscoveryCandidates`, F7.3) -- nunca combina/pesa señales entre sí.
- **`talent/service.ts` → `computeAndPersistPlacementReadiness()`** (impuro, nuevo): reutiliza `runQualificationEvaluation` + lee (sin recalcular) el `CandidateShortlistEntry`/`ScreeningPlan`/`InterviewPreview` ya persistidos para el par. **`getPlacementReadiness()`** (solo lectura).
- **Nuevo modelo `PlacementReadiness`** (schema, aditivo, mismo patrón que el resto de F8): un registro por par `(candidateId, jobOrderId)`.
- **`POST /candidates/:id/placement-readiness/:jobOrderId`** (calcula+persiste, `candidates.update`+`jobOrders.view`) y **`GET /candidates/:id/placement-readiness/:jobOrderId`** (solo lectura, 404 si nunca se evaluó).
- **Restricciones cumplidas explícitamente**: nunca crea `Placement` (no existe ese modelo todavía en el schema -- ver §16.8), nunca crea `Assignment`, nunca activa un `Worker`, nunca cambia `Candidate.status`.

### 16.2 Archivos modificados

- Nuevo: `placement-readiness.ts`, `placement-readiness.test.ts`, migración `20260717170000_f8_10_placement_readiness`.
- Modificado: `schema.prisma` (enum `PlacementReadinessStatus` + modelo `PlacementReadiness` + back-relations), `core/tenancy/prisma-extension.ts` (+1 línea), `talent/service.ts`, `talent/router.ts`, `talent/talent.test.ts`.

### 16.3 Contratos

DTOs locales al service. `POST`/`GET` devuelven `PlacementReadinessRecord` (`id/candidateId/jobOrderId/readinessStatus/score/blockers/warnings/completedChecks/pendingChecks/missingInformation/nextBestAction/requiresApproval/evaluatedAt/rulesVersion/evaluatedById/createdAt/updatedAt`).

### 16.4 UI

Ninguna en esta subfase -- se surfacea en F8.11.

### 16.5 Tests — 30 nuevos (todos passing)

`placement-readiness.test.ts` (22): READY_FOR_APPROVAL con todo completo; NOT_READY por NOT_QUALIFIED/documento vencido/interview CANCELLED (los 3 bloqueadores duros); NEEDS_REVIEW por calificación NEEDS_REVIEW/documento faltante/shortlist REMOVED; CONDITIONALLY_READY por gaps blandos, checks pendientes, o mismatch de ubicación; `missingInformation` siempre documenta la ausencia de compensación y de ubicación comparable, nunca inventa un valor; warnings de fecha de inicio (pasada/inminente); `requiresApproval` siempre `true`; `nextBestAction` prioriza correctamente; score proporcional a checks completos; determinismo; shape sin ningún campo que sugiera creación de Placement/Assignment/Worker. `talent.test.ts` (+8): RBAC 403; 404 antes de evaluar; NOT_READY real con blockers, nunca toca Candidate.status; CONDITIONALLY_READY con checks pendientes; **flujo end-to-end completo** (matching->shortlist APPROVED->screening->interview APPROVED_FOR_SEND) llega realmente a READY_FOR_APPROVAL con score 100; idempotencia; GET lee sin recalcular; AuditLog escrito.

### 16.6 Suite completa

977 tests, 971 pass, 1 fail preexistente sin relación (`prospecting.test.ts`, OpenAI real), 5 skip -- cero regresiones. Typecheck y lint limpios.

### 16.7 Migraciones

`20260717170000_f8_10_placement_readiness` -- 100% aditiva: 1 enum nuevo (`PlacementReadinessStatus`), 1 tabla nueva (`PlacementReadiness`) con 2 FKs (`ON DELETE RESTRICT`), 2 índices. Cero columnas nuevas en tablas existentes.

### 16.8 Limitaciones conocidas

- No existe un modelo `Placement` en el schema todavía (fuera de alcance explícito de F8 -- placement activo real es un concepto de fase futura, F9 según el plan histórico); esta subfase solo evalúa disposición, nunca ejecuta la transición.
- Sin dato de compensación esperada del candidato -- documentado como `missingInformation` permanente hasta que ese campo exista en el schema, si se decide agregarlo en una fase futura.
- Igual que el resto de F8, las FKs son `ON DELETE RESTRICT`.

### 16.9 Commit

`feat: F8.10 — placement readiness`.

**F8.10 completo.**

## 17. Resultado de F8.11 — Recruiting Mission UI

### 17.1 Arquitectura

- **Sin app/página separada** (mismo criterio que F6.7/MatchingPanel): dos componentes nuevos embebidos en `JobOrderDetail.tsx` real, justo debajo de `MatchingPanel`.
  - **`components/recruiting/RecruitingMissionPanel.tsx`**: sección "Candidate Matching & Ranking" (F8.6 -- calcular/leer, ranking + excluidos, nunca muestra un NOT_QUALIFIED como recomendado) + sección "Shortlist" (F8.7 -- generar/leer + cambiar `reviewStatus` inline).
  - **`components/recruiting/CandidatePipelineDrawer.tsx`**: drawer lateral (reutiliza el componente `Drawer` ya existente, F5.x) que se abre al hacer click en cualquier candidato -- Calificación (F8.2, solo lectura), Screening (F8.8, generar+ver preguntas), Entrevista (F8.9, generar+ver+cambiar estado, con el aviso "Solo PREVIEW -- nunca se envía una invitación real ni se modifica un calendario" SIEMPRE visible), Placement Readiness (F8.10, evaluar+ver blockers/warnings/nextBestAction, con el aviso "requiere aprobación humana explícita" siempre visible).
  - **`components/recruiting/types.ts`**: tipos locales al frontend para los DTOs de F8.6-F8.10 (esos endpoints devuelven DTOs locales al service de la API, nunca se agregaron a `@ai-staffing-os/shared` -- mismo criterio que F8.2/F8.3).
- **`lib/status.ts`** (modificado, aditivo): se agregaron los nuevos valores de estado de F8.5-F8.10 (`POSSIBLY_QUALIFIED`, `NEEDS_REVIEW`, `NOT_QUALIFIED`, `READY_FOR_REVIEW`, `HOLD`, `REMOVED`, `NEEDS_AVAILABILITY`, `READY_FOR_APPROVAL`, `APPROVED_FOR_SEND`, `CONDITIONALLY_READY`, `NOT_READY`, `HIGH`/`MEDIUM`/`LOW` de confianza) a los sets ya existentes `SUCCESS`/`WARNING`/`DANGER` -- cero valores existentes modificados, solo términos nuevos agregados.
- Todas las acciones sensibles (calcular matching, generar shortlist/screening/interview/readiness, cambiar reviewStatus/status) están gateadas por `candidates.update`/`candidates.view` reales del usuario autenticado (`useCurrentUser().permissions`) -- si falta el permiso de view, la sección entera no se renderiza (`return null`); si falta el de update, solo los botones de escritura desaparecen (solo lectura), igual que `MatchingPanel`.

### 17.2 Archivos modificados

- Nuevo: `components/recruiting/RecruitingMissionPanel.tsx`, `components/recruiting/CandidatePipelineDrawer.tsx`, `components/recruiting/types.ts`, `e2e/recruiting-mission.spec.ts`.
- Modificado: `pages/JobOrderDetail.tsx` (+2 líneas: import + `<RecruitingMissionPanel />`), `lib/status.ts` (nuevos valores de estado).

### 17.3 Verificación real en navegador (Playwright, contra los dev servers ya corriendo, dev-bypass real, datos reales del seed de tenant-titan)

- **Calcular Matching** en un Job Order real (`joborder-01`, Forklift Operator) → 8 candidatos reales recomendados, ordenados por score, ninguno NOT_QUALIFIED en la lista de recomendados (los NOT_QUALIFIED quedan en "no recomendados", colapsados por defecto).
- **Generar Shortlist** desde ese ranking real → entradas reales con `rank`/`reviewStatus=DRAFT`, selector inline para cambiar estado (backend valida la transición, ver F8.7).
- **Drawer de candidato**: Calificación muestra razones/documentos faltantes REALES del candidato (`forklift_cert`, `drug_test`); **Screening** genera un plan real con preguntas interpolando la categoría real ("Forklift Operator") y la pregunta de documentos con los keys reales faltantes; **Entrevista** genera un preview real (`READY_FOR_APPROVAL`, modalidad/ventana propuesta reales) con el aviso de PREVIEW siempre visible; **Placement Readiness** evalúa y muestra el estado real (`NEEDS_REVIEW`, coherente con los documentos faltantes) con blockers/nextBestAction reales.
- **RBAC**: con `x-dev-user=sales`/`payroll` (sin `candidates.view`), ni "Candidate Matching & Ranking" ni "Shortlist" se renderizan -- el resto del Job Order Order (Detalles/Assignments) sigue funcionando normal. Verificado tanto manualmente (Playwright ad-hoc con route interception) como en el e2e formal.
- **Estados vacíos**: un Job Order que nunca corrió el pipeline muestra "Todavía no se calculó el matching..."/"Sin shortlist todavía..." con los botones de acción, nunca una tabla vacía sin explicación.
- **Dark mode**: todos los badges/cards nuevos mantienen contraste correcto (verificado con captura real en modo oscuro).
- **Responsive**: viewport móvil (390px) -- los badges hacen wrap correctamente, el botón de acción principal permanece alcanzable sin overflow horizontal (verificado con captura real y con el e2e `toBeInViewport()`).
- **Consola**: cero errores de JS/React en cualquiera de los flujos -- los únicos mensajes de red son 404s ESPERADOS (recursos que aún no se generaron), explícitamente filtrados/documentados, nunca errores reales.
- **Cero efectos secundarios de negocio**: la ocupación (`workersFilled/workersNeeded`) del Job Order no cambia al usar ninguna parte del pipeline de reclutamiento (verificado en el e2e).

### 17.4 Tests — 7 nuevos (e2e, todos passing en aislamiento)

`e2e/recruiting-mission.spec.ts` (mismo patrón que `job-order-matching.spec.ts`, F6.7, contra dev-bypass real y `joborder-01` real): calcular matching sin errores de consola; NOT_QUALIFIED nunca en recomendados; generar shortlist real; drawer completo (calificación+screening+entrevista+readiness) contra backend real; RBAC (Payroll sin acceso, sin errores); cero creación de Assignment; mobile viewport.

**Hallazgo durante la implementación (bug de test, no de producción)**: al correr la suite completa de e2e en paralelo (5 workers), el spec PRE-EXISTENTE `job-order-matching.spec.ts` (F6.7, sin relación con F8) falló por el mismo patrón ("Failed to load resource: 404" contado como error de consola en el primer load antes de correr matching por primera vez). Se confirmó mediante ejecución aislada (solo ese archivo, 1 worker, sin `recruiting-mission.spec.ts` presente) que la falla es 100% preexistente e independiente de F8.11 -- no se modificó ese archivo ni ningún código de F6, se documenta acá como hallazgo, no como regresión introducida.

### 17.5 Suite completa

`e2e/recruiting-mission.spec.ts` en aislamiento: 7/7 passing. Backend: sin cambios en esta subfase (F8.11 es 100% frontend) -- la suite completa de `apps/api` ya quedó verde al cierre de F8.10 (977 tests, 971 pass, 1 fail preexistente, 5 skip) y no se tocó ningún archivo de `apps/api` en F8.11. `apps/web`: typecheck limpio, lint limpio (0 errores, 2 warnings preexistentes sin relación en `toast.tsx`/`theme.tsx`), build de producción exitoso.

### 17.6 Migraciones

Ninguna -- F8.11 es 100% frontend, cero cambios de schema.

### 17.7 Limitaciones conocidas

- El nombre/apellido real del candidato no se muestra en las filas de ranking/shortlist (solo el `candidateId`, con link a `/candidates/:id` para el perfil completo) -- los endpoints de F8.6/F8.7 no devuelven `displayName` (serían campos nuevos en un DTO ya cerrado de una subfase anterior); se documenta como limitación conocida en vez de reabrir F8.6/F8.7 sin necesidad.
- No hay reorder manual de la shortlist en la UI (coherente con la limitación ya documentada en F8.7 -- el orden viene determinista del ranking).
- El botón "Generar preview de entrevista" usa una ventana propuesta simple por defecto (mañana+2 días, 30 min, teléfono) como punto de partida rápido -- un formulario completo para editar todos los campos (múltiples ventanas, modalidad, ubicación/enlace, participantes, restricciones) queda como mejora futura, no bloqueante (el backend ya soporta todos esos campos vía la API).

### 17.8 Commit

`feat: F8.11 — recruiting mission UI`.

**F8.11 completo.**
