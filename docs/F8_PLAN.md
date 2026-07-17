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

Auditoría completa. Continuando automáticamente con la implementación de F8.1.
