# F25 — Roadmap de Implementación

Orden de dependencia real (confirmado contra la auditoría, no solo el
orden sugerido por la instrucción maestra — se mantiene el mismo orden
porque el repositorio no demuestra una dependencia distinta). Cada fase
es deliberadamente pequeña (principio de "commits pequeños" aplicado a
nivel de fase, no solo de commit).

Para cada fase: objetivo, alcance, fuera de alcance, cambios de datos,
endpoints, módulos, pruebas, criterios de aceptación, riesgos,
estrategia de despliegue, rollback, verificación de producción.

---

## F25.1 — Shared agent vocabulary and contracts

- **Objetivo**: que todo el código futuro tenga un vocabulario común
  para hablar de etapas, estados, capacidades y eventos.
- **Alcance**: `AgentStage`, `AgentTaskExecutionStatus` (vocabulario
  nuevo, documentado §7 master doc, sin tocar el enum de Prisma
  todavía), `AgentCapability`, `AgentEventEnvelope`, `PolicyEnvelope`
  (Zod), `AgentExecutionContext`, `AgentResult`, `AgentError`,
  `AgentDecisionResult`, helpers de idempotencia/correlación.
  **Esta es la Fase G de esta misma sesión — ya ejecutada, ver reporte
  final.**
- **Fuera de alcance**: cualquier enforcement real, cualquier migración.
- **Cambios de datos**: ninguno.
- **Endpoints**: ninguno.
- **Módulos**: `packages/agents/src/core/*.ts` (nuevos archivos).
- **Pruebas**: unitarias puras por cada tipo/validador Zod.
- **Criterios de aceptación**: `tsc --noEmit` limpio en los 4 packages,
  tests nuevos en verde, cero cambio de comportamiento en código
  existente.
- **Riesgos**: ninguno — es aditivo puro, sin consumidores todavía.
- **Estrategia de despliegue**: se puede desplegar sin efecto (código
  muerto hasta F25.2+).
- **Rollback**: revertir el commit, sin dependencias.
- **Verificación de producción**: N/A (no hay comportamiento que
  verificar).

---

## F25.2 — Durable AgentTask lifecycle

- **Objetivo**: que una tarea sobreviva un reinicio del proceso y
  pueda ser reclamada por lease (ADR-0004).
- **Alcance**: migración aditiva a `AgentTask`
  (`claimedAt, claimedBy, leaseExpiresAt, attempt, maxAttempts,
  nextAttemptAt, lastErrorCode`), extensión de `MemoryScope` (ADR-0006:
  `OPERATIONAL, STRATEGIC, EPISODIC, LEARNING`), función pura
  `classifyError` (§13 master doc → `AgentErrorCategory`).
- **Fuera de alcance**: el claimer real (`SKIP LOCKED` en producción,
  eso es F25.4); cambiar `task-executor.ts` para usarlo todavía.
- **Cambios de datos**: migración aditiva (columnas nullable + valores
  de enum nuevos). **Verificar con `prisma migrate diff` contra una
  shadow DB de desarrollo, nunca contra `DATABASE_URL` principal**
  (regla explícita de esta sesión).
- **Endpoints**: ninguno nuevo.
- **Módulos**: `packages/db/prisma/schema.prisma`,
  `apps/api/src/modules/agents/error-classification.ts` (nuevo).
- **Pruebas**: unitarias de `classifyError`; test de migración
  (aplica limpio sobre DB local vacía y sobre DB local con datos
  existentes de hoy, confirmando cero filas alteradas).
- **Criterios de aceptación**: migración aplica sin error en local,
  `AgentTask` existentes conservan `status` sin cambios, suite completa
  sigue en el mismo estado (mismos 4-5 fallos ambientales conocidos, 0
  nuevos).
- **Riesgos**: bajo — columnas nullable, sin default disruptivo.
- **Estrategia de despliegue**: deploy normal (Render `migrate deploy`,
  mismo mecanismo ya usado 6 veces hoy con éxito).
- **Rollback**: las columnas nuevas quedan sin uso si se revierte el
  código consumidor; eliminarlas requeriría una migración aparte
  (documentar, no ejecutar salvo necesidad real).
- **Verificación de producción**: `GET /api/v1/health/ready` reporta
  `migrationsApplied: true` (mismo patrón ya usado hoy).

---

## F25.3 — Event outbox

- **Objetivo**: que un cambio de estado y su evento correspondiente se
  escriban en la misma transacción (outbox real, ADR-0002).
- **Alcance**: migración aditiva a `DomainEvent` (columnas de ADR-0002:
  `correlationId, causationId, actorType, actorId, entityType,
  entityId, idempotencyKey [unique], attempt, lastErrorAt,
  lastErrorCode`); helper `publishEvent(tx, envelope)` que escribe
  dentro de una transacción Prisma existente; primeros publishers
  reales: `company.discovered.v1` (en `persistAcceptedCandidate`),
  `outreach.draft_created.v1` (en los 3 call sites de F24).
- **Fuera de alcance**: el dispatcher/poller que LEE `DomainEvent` y
  entrega a consumidores — eso es F25.5 (Orchestrator).
- **Cambios de datos**: migración aditiva sobre `DomainEvent`.
- **Endpoints**: ninguno nuevo (los publishers son internos a services
  ya existentes).
- **Módulos**: `apps/api/src/core/events/publish-event.ts` (nuevo),
  cambios mínimos en `mission-executor.ts` y los 3 call sites de draft
  (agregar 1 línea de `publishEvent` cada uno, dentro de la misma
  transacción que ya existe).
- **Pruebas**: integración — crear una Company real vía
  `persistAcceptedCandidate` en un test, confirmar que
  `DomainEvent` tiene exactamente 1 fila nueva con el `payload`/
  `idempotencyKey` correctos, en LA MISMA transacción (simular fallo
  post-commit no debe dejar huérfanos).
- **Criterios de aceptación**: eventos se escriben consistentemente;
  ningún evento sin su cambio de estado correspondiente y viceversa;
  0 regresiones en el pipeline de discovery/outreach ya existente.
- **Riesgos**: medio — toca código de producción real (los 4 call
  sites), aunque el cambio es aditivo (una escritura extra, nunca
  condiciona el flujo existente). Mitigación: publishEvent nunca lanza
  — un fallo al escribir el evento se loguea, no revierte la
  transacción de negocio (el evento es observabilidad, no debe poder
  romper el pipeline comercial real).
- **Estrategia de despliegue**: feature-flag por tenant
  (`Tenant.settings.eventPublishingEnabled`, default `false`) — se
  activa primero en un tenant de prueba, luego en `tenant-titan` tras
  confirmar en producción que no genera carga/errores inesperados.
- **Rollback**: apagar el flag; las filas de `DomainEvent` ya escritas
  quedan como historial inerte, sin efecto.
- **Verificación de producción**: query directa `SELECT count(*) FROM
  "DomainEvent" WHERE type='company.discovered.v1' AND createdAt >
  now() - interval '1 hour'` tras una misión real de prueba.

---

## F25.4 — PostgreSQL worker queue

- **Objetivo**: claim atómico de `AgentTask` vía `SKIP LOCKED`
  (ADR-0001).
- **Alcance**: función `claimNextTasks(workerId, limit, stages[])`
  usando `$queryRaw` con `FOR UPDATE SKIP LOCKED`; heartbeat
  (`renewLease(taskId, workerId)`); recuperación de leases vencidos
  (reemplaza/generaliza el watchdog hoy exclusivo de
  `daily_revenue_mission`).
- **Fuera de alcance**: mover TODA la ejecución existente a este
  mecanismo de una vez — F25.4 solo construye y prueba el claimer;
  migrar `task-executor.ts` para usarlo es progresivo, empezando por
  un solo tipo de tarea de bajo riesgo en F25.5.
- **Cambios de datos**: ninguno adicional a F25.2.
- **Endpoints**: ninguno nuevo (mecanismo interno).
- **Módulos**: `apps/api/src/core/queue/postgres-queue.ts` (nuevo).
- **Pruebas**: **crítico** — test de concurrencia real: lanzar N
  "workers" (promesas concurrentes) reclamando de la misma tabla con
  las mismas M tareas disponibles, confirmar que la suma de tareas
  reclamadas por todos los workers = M exactamente, sin overlap
  (ninguna tarea reclamada por dos workers a la vez) y sin tareas
  perdidas.
- **Criterios de aceptación**: test de concurrencia en verde de forma
  consistente (correr 20 veces sin flakiness); lease vencido siempre
  recuperable por otro claim.
- **Riesgos**: medio-alto — es la pieza más nueva conceptualmente
  (nada parecido existe hoy). Mitigación: extensa cobertura de tests de
  concurrencia antes de que cualquier código de producción lo consuma.
- **Estrategia de despliegue**: código muerto hasta F25.5 (nadie lo
  llama todavía) — deploy sin riesgo real.
- **Rollback**: trivial, nadie depende de esto todavía.
- **Verificación de producción**: N/A hasta F25.5.

---

## F25.5 — Orchestrator

- **Objetivo**: el COO/Orchestrator Agent real, coordinando claim +
  ejecución + reintento para UN tipo de tarea de bajo riesgo primero.
- **Alcance**: `Orchestrator` que usa `claimNextTasks` (F25.4),
  ejecuta el handler existente (reutiliza `task-executor.ts` sin
  reescribirlo), clasifica el resultado (`classifyError`, F25.2),
  agenda reintento o marca `FAILED_FINAL`/`HUMAN_REVIEW`. Primer tipo de
  tarea migrado: `score_company` (sin efecto externo, bajo riesgo,
  ya idempotente por diseño). Enforcement inicial de `hasCapability`
  (ADR-0007) — solo logging de violaciones, todavía sin bloquear (para
  medir impacto antes de gatear).
- **Fuera de alcance**: migrar `draft_outreach`/`personalize_message`/
  cualquier tarea con efecto externo — eso espera a F25.11-F25.13.
- **Cambios de datos**: ninguno adicional.
- **Endpoints**: `GET /api/v1/orchestrator/health` (nuevo, interno —
  queue depth, workers activos, tareas vencidas).
- **Módulos**: `apps/api/src/modules/agents/orchestrator.ts` (nuevo).
- **Pruebas**: integración end-to-end con una tarea `score_company`
  real reclamada, ejecutada, completada vía el nuevo camino — comparar
  resultado contra el camino viejo (`createAndRunTaskSync`) para
  confirmar paridad de comportamiento.
- **Criterios de aceptación**: `score_company` vía Orchestrator produce
  resultado idéntico al camino actual; 0 regresión en
  `agents.test.ts`.
- **Riesgos**: medio — primer punto donde el nuevo mecanismo toca un
  tipo de tarea real, aunque de bajo riesgo (sin efecto externo).
- **Estrategia de despliegue**: flag por tenant, un solo tipo de tarea,
  monitoreo de paridad antes de expandir a más tipos.
- **Rollback**: apagar el flag, `score_company` vuelve al camino
  directo actual sin pérdida de datos (ambos caminos escriben el mismo
  `AgentTask.output`).
- **Verificación de producción**: comparar `AgentTask.output` de 10
  ejecuciones reales vía Orchestrator contra el histórico del camino
  directo para la misma Company.

---

## F25.6 — Human Review Center

- **Objetivo**: `HumanReviewRequest` real (contrato en
  `F25_AUTONOMY_POLICY_MODEL.md` §8) con dedup y UI mínima.
- **Alcance**: migración aditiva (tabla `HumanReviewRequest` nueva —
  justificación: nada existente cubre "caso consolidado con evidencia y
  opciones", `ApprovalRequest` es específico de outreach); endpoint
  `GET/POST /api/v1/human-review`; página `apps/web` mínima (lista +
  detalle, reutilizando el patrón visual de `Approvals.tsx`).
- **Fuera de alcance**: que ningún agente todavía la alimente
  automáticamente (eso es progresivo, cada fase F25.7+ conecta su
  propio tipo de escalación).
- **Cambios de datos**: tabla nueva, aditiva, sin relación obligatoria
  con nada existente (FKs opcionales vía `entityType`/`entityId`, mismo
  patrón ya usado por `AuditLog`).
- **Endpoints**: `GET /api/v1/human-review`, `POST
  /api/v1/human-review/:id/resolve`.
- **Módulos**: `apps/api/src/modules/human-review/*`,
  `apps/web/src/pages/HumanReview.tsx`.
- **Pruebas**: CRUD + dedup (crear 2 solicitudes para la misma
  entidad+tipo, confirmar que la segunda se fusiona).
- **Criterios de aceptación**: UI funcional en local, dedup verificado
  por test.
- **Riesgos**: bajo — funcionalidad nueva aislada, sin tocar flujos
  existentes.
- **Estrategia de despliegue**: deploy normal, sin flag (nadie la
  alimenta todavía, cero impacto).
- **Rollback**: eliminar la ruta de UI; la tabla puede quedar vacía sin
  efecto.
- **Verificación de producción**: crear manualmente un
  `HumanReviewRequest` de prueba vía API, confirmar que aparece en la
  UI, resolverlo, confirmar `resolvedAt` poblado — luego borrar el
  registro de prueba (dato sintético, no real).

---

## F25.7 — Discovery Agent conversion

- **Objetivo**: envolver la lógica YA REAL de Discovery
  (`mission-executor.ts`) como un handler que el Orchestrator puede
  reclamar, publicando `company.discovered.v1` (F25.3).
- **Alcance**: extraer el bucle de discovery a una función invocable
  por el Orchestrator sin cambiar su lógica interna (ya pura/testeada).
- **Fuera de alcance**: cambiar CUALQUIER regla de negocio de
  clasificación/dedup — este es un cambio de invocación, no de
  comportamiento.
- **Cambios de datos**: ninguno.
- **Módulos**: refactor de `mission-executor.ts` (extraer, no
  reescribir).
- **Pruebas**: la suite existente de `mission-executor.test.ts` debe
  seguir pasando sin modificación de expectativas.
- **Criterios de aceptación**: 0 cambio de output para las mismas
  entradas (test de paridad byte-a-byte del resultado).
- **Riesgos**: medio — toca el corazón del pipeline real.
- **Estrategia de despliegue**: flag, corrida en paralelo (sombra) del
  camino nuevo contra el viejo antes de reemplazar.
- **Rollback**: apagar el flag, vuelve al camino directo actual.
- **Verificación de producción**: comparar resultados de una misión de
  prueba controlada por ambos caminos.

---

## F25.8 — Contact Intelligence Agent conversion

Mismo patrón que F25.7, aplicado a `resolveBestContactChannel` +
`contact-enrichment.ts`. Riesgo medio (toca selección de destinatario,
área sensible tras el trabajo de hoy) — criterio de aceptación
explícito: los 6 tests de regresión de contaminación de teléfono
(`contact-channel.test.ts`, ya escritos hoy) deben seguir pasando
byte-a-byte contra el camino nuevo.

---

## F25.9 — Qualification Agent

- **Objetivo**: `QualificationAssessment` como salida propia y
  auditable (hoy es un side-effect implícito de `decideCompanyConversion`).
- **Alcance**: nueva función pura `assessQualification` que ENVUELVE
  `decideCompanyConversion` (F24, sin tocarla) y produce el shape
  `QualificationAssessment` completo (score, motivos, evidencia,
  riesgos, recomendación) como valor de retorno explícito, no solo el
  side-effect de crear/no-crear un Lead.
- **Fuera de alcance**: cambiar las 7 reglas de `decideCompanyConversion`.
- **Cambios de datos**: ninguno si `QualificationAssessment` se
  modela como parte del payload del evento `company.qualified.v1`
  (no persistido aparte); si se decide persistirlo (para consulta
  histórica), migración aditiva de tabla nueva — decisión pendiente,
  documentada, no tomada unilateralmente en el roadmap.
- **Pruebas**: unitarias de `assessQualification` contra los mismos
  casos ya cubiertos por `conversion-policy.test.ts`.
- **Criterios de aceptación**: mismo resultado de decisión
  (createLead/createOpportunity) que hoy, más el `QualificationAssessment`
  estructurado como valor nuevo.
- **Riesgos**: bajo — es una envoltura, no un reemplazo.
- **Despliegue/rollback/verificación**: mismos patrones que F25.7.

---

## F25.10 — Campaign Planner Agent

- **Objetivo**: `CampaignPlan` explícito y revisable antes de crear la
  `Campaign` real, más el gate de saturación de dominio (nuevo, no
  existe hoy).
- **Alcance**: función pura `planCampaign` (agrupación + `CampaignPlan`)
  + gate `checkDomainSaturation` (nuevo — cuenta cuántos
  `ApprovalRequest`/`EmailMessage` activos ya apuntan al mismo dominio
  en la ventana reciente).
- **Fuera de alcance**: cambiar `createCampaign`/`selectTargetCompanies`
  existentes — el plan es una capa ANTES de esas llamadas.
- **Cambios de datos**: ninguno.
- **Pruebas**: unitarias de `checkDomainSaturation` con casos reales
  (mismo dominio, 2 Companies distintas — debe limitar).
- **Riesgos**: bajo.

---

## F25.11 — Outreach Agent

- **Objetivo**: envolver `outreach-tools.impl.ts`/`sales-tools.impl.ts`
  (ya reales, F24) para que el Orchestrator las invoque, publicando
  `outreach.draft_created.v1`.
- **Alcance**: extracción de invocación, sin tocar
  `evaluateDraftCreationGate` ni los prompts (ya corregidos hoy).
- **Riesgos**: medio-alto — es la primera conversión que toca un tipo
  de tarea con LLM real y `ApprovalRequest`. Criterio de aceptación
  extra: los 9+9 tests de `draft-creation-gate*.test.ts` (F24) deben
  seguir pasando sin modificación contra el camino nuevo.
- **Estrategia de despliegue**: flag, sombra, comparación antes de
  reemplazar — igual que F25.7/8.

---

## F25.12 — Quality Agent

- **Objetivo**: capa semántica ADITIVA sobre `evaluateApprovalQualityGate`
  (F24, ya real) — nunca reemplazarla.
- **Alcance**: `QualityAssessment` con veredicto de 5 valores
  (`PASS|NEEDS_REVISION|NEEDS_ENRICHMENT|HUMAN_REVIEW|BLOCKED`),
  mapeando: los 8 checks deterministas existentes → `BLOCKED` si
  fallan (sin cambio); la capa LLM nueva → `NEEDS_REVISION`/
  `HUMAN_REVIEW` cuando detecta riesgo de tono/reputación que el
  determinista no cubre.
- **Fuera de alcance**: que la capa LLM pueda convertir un `BLOCKED`
  determinista en `PASS` — estructuralmente imposible por diseño
  (principio #18).
- **Criterios de aceptación**: `evaluateApprovalQualityGate` sigue
  siendo la autoridad final para bloquear; la capa nueva solo agrega
  `NEEDS_REVISION` en casos donde hoy no hay ninguna señal.
- **Riesgos**: bajo (aditivo, nunca afloja lo que ya existe).

---

## F25.13 — Delivery Agent guarded mode

- **Objetivo**: envolver `sendApproval` (F17/F21, ya real) con
  rate-limit/idempotencia adicional a nivel `PolicyEnvelope`
  (`dailyEmailLimit`, `perDomainLimit`, `allowedSendWindows`) — **sin
  activar envío autónomo** (instrucción maestra, literal, para F25 en
  general, y explícitamente repetida para esta fase específica en la
  instrucción original).
- **Alcance**: `Delivery Agent` que se interpone ANTES de que
  `sendApproval` se invoque desde la UI — verifica `PolicyEnvelope`,
  nunca decide enviar por su cuenta. El clic humano en "Enviar" sigue
  siendo la única acción que dispara el envío real.
- **Fuera de alcance**: cualquier trigger automático de envío.
- **Riesgos**: **alto si se malinterpreta el alcance** — regla dura:
  esta fase NUNCA reduce la fricción humana existente, solo agrega
  validación adicional ANTES del clic humano. Verificación de
  aceptación explícita: un test que confirma que `sendApproval` sigue
  exigiendo una decisión HTTP humana previa, sin excepción.

---

## F25.14 — Inbox ingestion

- **Objetivo**: Inbox Monitor Agent — lectura de buzón real, primera
  vez que el sistema LEE contenido externo no confiable de forma
  masiva (no solo sitios web ya cubiertos hoy).
- **Alcance**: diseño de webhook/poll de Microsoft Graph para mensajes
  entrantes, dedup por Message-Id, `reply.received.v1`.
- **Fuera de alcance explícito (instrucción maestra, literal)**: "no
  implementar acceso productivo durante esta sesión" — aplica también
  a esta fase futura hasta que se autorice expresamente, dado el riesgo
  de seguridad (§12 master doc, prompt injection) que debe resolverse
  ANTES de activar.
- **Riesgos**: alto — superficie de ataque nueva (contenido de
  terceros no confiables). Precondición dura antes de activar: el
  hardening de aislamiento de contenido externo (§12 master doc) debe
  estar implementado y probado, no solo documentado.

---

## F25.15 — Reply Intelligence

Clasificación de intención sobre `reply.received.v1`. Mismo
precondition de seguridad que F25.14. Taxonomía de 15 valores ya
definida (`F25_AGENT_EVENTS_AND_CONTRACTS.md`).

## F25.16 — Conversation Agent

Redacción de respuesta, reusando `evaluateApprovalQualityGate` (mismo
gate, nunca un camino separado más laxo — regla dura del catálogo).

## F25.17 — Meeting Agent

`BookingProposal`, sin reservar todavía (eso es Calendar Agent,
F25.19 — fuera del roadmap original de 20 fases pedido; se agrega
Calendar como sub-paso de F25.17-18 en la práctica, ver nota abajo).

## F25.18 — Analytics Agent

`AnalyticsReport` como entidad/evento propio (hoy son endpoints ad
hoc). Riesgo bajo — solo lectura/agregación.

## F25.19 — Learning Agent

`LearningProposal` con el ciclo `PROPOSED→REVIEWED→APPROVED→ACTIVATED`.
Ningún paso de este ciclo puede saltarse por código — el criterio de
aceptación explícito es un test que confirma que `ACTIVATED` es
inalcanzable sin pasar por los 3 estados previos en orden.

## F25.20 — CEO Agent

Última fase, deliberadamente — cierra el ciclo con vigilancia continua
de resultados reales de las 19 fases anteriores. Es la fase con más
criterio de negocio (no solo técnico) y la candidata natural para,
recién ahí, evaluar si el sistema está listo para proponer subir de
LEVEL 1 (ver `F25_AUTONOMY_POLICY_MODEL.md` §9) — nunca antes.

---

**Nota sobre Calendar Agent**: la instrucción maestra no le asigna un
número de fase propio en la lista de 20 (`F25.1`-`F25.20`); dado que
Meeting Agent (F25.17) no puede reservar sin Calendar Agent, se
recomienda que Calendar se implemente como parte de F25.17 (mismo PR,
mismo criterio de aceptación: "una reunión de prueba se propone y
reserva en un calendario sintético/mock, nunca uno real, hasta
autorización explícita separada") en vez de una fase 21 nueva —
cambio de orden justificado por dependencia real del repositorio,
permitido explícitamente por la instrucción maestra ("puedes cambiar el
orden si el repositorio demuestra otra dependencia").
