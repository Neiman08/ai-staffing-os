# F25 — Catálogo de Agentes

Para cada agente: propósito, responsabilidades, inputs/outputs,
capacidades (`AgentCapability`, ver `F25_AUTONOMY_POLICY_MODEL.md`),
acciones prohibidas, eventos consumidos/producidos (ver
`F25_AGENT_EVENTS_AND_CONTRACTS.md` para el schema completo de cada
evento), gates deterministas, uso de LLM, acceso a datos, métricas,
manejo de fallos, condiciones de escalación, y elegibilidad de
autonomía (nivel máximo permitido hoy — ver `F25_AUTONOMY_POLICY_MODEL.md`).

**`Estado hoy`** indica honestamente si el agente ya existe como código
real (función pura + tool), es un stub, o es 100% diseño nuevo.

---

## 1. CEO Agent

- **Estado hoy**: parcial — `AgentDefinition key="ceo"` existe
  (`packages/agents/src/definitions/ceo.agent.ts`), y la interpretación
  determinista de instrucciones (`intent-interpreter.ts`,
  `mission-planner.ts`) ya funciona. La responsabilidad de "vigilar
  resultados generales y decidir qué áreas requieren intervención" NO
  existe todavía — hoy el CEO Agent interpreta UNA instrucción humana
  por vez, no monitorea continuamente.
- **Purpose**: interpretar objetivos comerciales, traducirlos en
  misiones, distribuir prioridades, vigilar resultados, decidir
  intervención.
- **Responsibilities**: ver instrucción maestra §1.
- **Inputs**: objetivos del tenant, métricas agregadas (de Analytics
  Agent), presupuestos, capacidad operativa, restricciones
  territoriales, prioridades comerciales, señales de riesgo, resultados
  históricos.
- **Outputs**: `StrategicMission`, prioridades, presupuesto asignado,
  límites operativos, decisiones de pausa, `HumanReviewRequest`.
- **Capabilities**: `CREATE_STRATEGIC_MISSION`, `READ_ANALYTICS`,
  `SET_BUDGET_ALLOCATION`, `PAUSE_PIPELINE`, `CREATE_HUMAN_REVIEW`.
- **Forbidden actions**: `SEND_EMAIL`, `UPDATE_CONTACT`,
  `BOOK_MEETING`, cualquier capability de escritura fuera de las
  propias, ejecutar SQL arbitrario (no tiene acceso a Prisma directo,
  solo a servicios vía capabilities — principio #2).
- **Events consumed**: `analytics.report_ready.v1`,
  `agent.task_failed.v1` (agregado), `human.review_required.v1`
  (resumen).
- **Events produced**: `strategic_mission.created.v1`.
- **Deterministic gates**: ninguno propio — consume el resultado de
  gates de otros agentes vía Analytics.
- **LLM usage**: interpretación de instrucción en lenguaje natural →
  `StructuredIntent` (ya real, `intent-interpreter.ts`). Nunca decide
  con el LLM si algo se envía.
- **Data access**: lectura agregada (Analytics), escritura solo de
  `StrategicMission`/prioridades.
- **Metrics**: reuniones calificadas, oportunidades creadas, costo por
  oportunidad, conversión por etapa, tasa de errores, utilización de
  presupuesto, tiempo de ciclo completo (todas las pedidas por la
  instrucción maestra).
- **Failure handling**: si `interpretDailyDirective` falla, el
  `AgentTask` correspondiente termina `FAILED_FINAL` con el error
  visible (ya implementado y testeado hoy — ver
  `missions.test.ts`, "una misión cuyo interpretDailyDirective falla").
- **Escalation conditions**: presupuesto excedido, tasa de error alta
  sostenida, meta no alcanzable con las restricciones dadas.
- **Autonomy eligibility**: LEVEL 2 máximo (recomienda y prioriza,
  nunca ejecuta directamente acciones externas).

---

## 2. COO / Orchestrator Agent

- **Estado hoy**: ausente como agente — su responsabilidad la cumplen,
  parcialmente y sin coordinación central, `mission-orchestrator.ts` +
  `scheduler.ts` (in-process, sin cola real — ver ADR-0001/0003).
- **Purpose**: convertir `StrategicMission` en plan operativo, crear y
  coordinar tareas, reintentar, vigilar dependencias, detectar
  bloqueos, controlar concurrencia.
- **Responsibilities**: coordinador operativo central — nunca lógica
  específica de discovery/contactos/outreach (principio de separación
  de responsabilidades).
- **Inputs**: `StrategicMission`, estado de `AgentTask` (cola),
  `PolicyEnvelope`.
- **Outputs**: `AgentTask` creadas/reclamadas/reintentadas, decisiones
  de bloqueo.
- **Capabilities**: `CLAIM_TASK`, `CREATE_TASK`, `RETRY_TASK`,
  `CANCEL_TASK`, `ESCALATE_BLOCKED_TASK`.
- **Forbidden actions**: cualquier capability específica de dominio
  (discovery, contacto, envío) — el Orchestrator delega, nunca ejecuta
  lógica de negocio él mismo.
- **Events consumed**: `strategic_mission.created.v1`, todo evento
  `*.v1` que otro agente emite como "terminé, esto sigue" (el
  Orchestrator es el suscriptor universal para decidir el siguiente
  paso).
- **Events produced**: ninguno propio de negocio — republica/enruta.
- **Deterministic gates**: claim atómico (`SKIP LOCKED`, ADR-0001),
  lease/heartbeat (ADR-0004), clasificación de error →
  reintento/escalación (§13 master doc).
- **LLM usage**: ninguno — 100% determinista (coincide con principio
  #1 aplicado al extremo: el coordinador nunca "decide con
  creatividad").
- **Data access**: `AgentTask` (todas las columnas de ADR-0004),
  `DomainEvent` (ADR-0002).
- **Metrics**: task latency, retry rate, failure rate, queue depth,
  stuck-task count.
- **Failure handling**: es el propio mecanismo de failure handling del
  sistema — reintenta según clasificación, escala a `HUMAN_REVIEW` al
  agotar intentos.
- **Escalation conditions**: tarea agotó `maxAttempts`, lease vencido
  repetidamente (posible bug del handler), dependencia circular
  detectada.
- **Autonomy eligibility**: LEVEL 4 (coordina end-to-end dentro de
  política) — pero el sistema completo sigue topeado en LEVEL 1 hoy
  (ver §13 master doc); el Orchestrator puede coordinar tareas internas
  sin enviar nada externo bajo LEVEL 1.

---

## 3. Territory Strategy Agent

- **Estado hoy**: ausente. Hoy la selección de territorio es un
  parámetro humano dentro de la instrucción de misión
  (`StructuredIntent.states/preferredCities`), nunca una decisión
  propia del sistema.
- **Purpose**: seleccionar territorios, priorizar industrias,
  identificar concentración de demanda, asignar cobertura, evitar
  saturación.
- **Inputs**: estado/ciudad/radio/industria/trade, proyectos
  conocidos, estacionalidad, competencia, historial de conversión
  (Analytics), capacidad de DreiStaff, disponibilidad de trabajadores
  (`Worker`/`Assignment` ya existen en el CRM).
- **Outputs**: propuesta de territorio/industria priorizados
  (recomendación, nunca ejecuta la búsqueda ella misma).
- **Capabilities**: `READ_ANALYTICS`, `READ_WORKER_CAPACITY`,
  `PROPOSE_TERRITORY`.
- **Forbidden actions**: `DISCOVER_COMPANY` directo (propone, no
  ejecuta discovery).
- **Events consumed**: `analytics.report_ready.v1`.
- **Events produced**: `territory.proposed.v1` (nuevo).
- **Deterministic gates**: evitar saturación (ej. no proponer un
  territorio ya cubierto por una campaña ACTIVE reciente — mismo
  criterio que `selectTargetCompanies` ya aplica a nivel Company,
  elevado a nivel territorio).
- **LLM usage**: opcional, para redactar el rationale humano-legible de
  la propuesta — nunca para decidir el territorio en sí (eso es
  scoring determinista sobre datos reales).
- **Data access**: lectura de `Company`/`Campaign`/`Worker`/
  `Assignment` agregados, nunca escritura directa.
- **Metrics**: cobertura territorial, tasa de saturación, conversión
  por territorio.
- **Failure handling**: sin datos suficientes → no propone (nunca
  inventa una recomendación sin evidencia).
- **Escalation conditions**: ningún territorio disponible cumple los
  criterios mínimos.
- **Autonomy eligibility**: LEVEL 2 (propone, requiere aprobación antes
  de que Discovery actúe sobre la propuesta).

---

## 4. Discovery Agent

- **Estado hoy**: **real y en producción** — `mission-executor.ts`
  (`executeDiscoveryPlan`), `validateBusinessCandidate`
  (`business-validation.ts`), dedup por identity keys, `evaluateBusinessIdentityGate`
  (DEMO_SEED bloqueado, F24), `isClientOwnerCandidate`
  (`critical-infrastructure-clients.ts`). Ya cumple TODAS las
  condiciones de detención pedidas por la instrucción maestra.
- **Purpose**: descubrir empresas, recopilar evidencia, deduplicar,
  clasificar, producir `CompanyCandidate` evaluable. Nunca crea
  outreach directamente (ya cierto hoy).
- **Inputs**: `MissionPlan.searchQueries`, proveedores externos (Google
  Places/Overpass).
- **Outputs**: `Company` (persistida solo si pasa validación),
  `CompanyValidationRecord` (missions.ts:483-544, ya real).
- **Capabilities**: `DISCOVER_COMPANY`, `CREATE_COMPANY_CANDIDATE`.
- **Forbidden actions**: `CREATE_DRAFT`, `SEND_EMAIL` — confirmado hoy
  por diseño (Discovery nunca llega a outreach directamente).
- **Events consumed**: `territory.proposed.v1` (futuro),
  `strategic_mission.created.v1`.
- **Events produced**: `company.discovered.v1`.
- **Deterministic gates (ya reales)**: `validateBusinessCandidate`
  (confianza EXACT/STRONG/APPROXIMATE/WEAK/REJECTED),
  `evaluateBusinessIdentityGate` (DEMO_SEED, F24),
  `detectClientOwnerMatch` (client-owner vs. contratista),
  deduplicación por `providerPlaceId`/`canonicalDomain`/
  `normalizedPhone`/nombre+ciudad+estado normalizado.
- **LLM usage**: ninguno en la clasificación en sí (100% pura); el LLM
  solo interviene en `intent-interpreter.ts` antes de esta etapa.
- **Data access**: `Company` (crear), proveedores externos (Google
  Places/Overpass) vía `contact-intelligence-tools.impl.ts`.
- **Metrics**: candidates found, accepted, rejected, duplicate rate,
  classification accuracy (ya calculables desde `CompanyValidationRecord`).
- **Failure handling**: proveedor externo cae (402/429) →
  `providersOmitted` (ya implementado, el pipeline sigue sin ese
  proveedor, nunca bloquea toda la misión).
- **Escalation conditions**: `isClientOwnerCandidate=true` o
  `MANUAL_REVIEW` → ya bloquea outreach automático (F24), no requiere
  cambio nuevo.
- **Autonomy eligibility**: LEVEL 3 ya alcanzable hoy para la
  PERSISTENCIA de Company (no requiere aprobación humana crear un
  candidato, solo para convertirlo en Lead/Opportunity/Draft más
  adelante en el pipeline).

---

## 5. Company Research Agent

- **Estado hoy**: parcial — `company-enrichment.ts`/`hiring-signals.ts`
  ya reúnen señales, pero no distinguen explícitamente "evidencia
  confirmada / inferencia / hipótesis / dato desactualizado / dato
  conflictivo" como pide la instrucción maestra — hoy es
  `businessConfidence` (un solo score), no una taxonomía de tipo de
  evidencia.
- **Purpose**: completar perfil empresarial, investigar servicios,
  tamaño, presencia territorial, señales de contratación, proyectos,
  reunir evidencia citable en mensajes.
- **Inputs**: `Company` recién descubierta, `website`.
- **Outputs**: `Company.discoveryMetadata` enriquecido,
  `CompanyEvidenceRecord` (nuevo — ver `F25_AGENT_EVENTS_AND_CONTRACTS.md`
  para el shape propuesto de evidencia tipada).
- **Capabilities**: `UPDATE_COMPANY_RESEARCH`, `READ_COMPANY`.
- **Forbidden actions**: `CREATE_DRAFT`, `CREATE_CONTACT_CANDIDATE`
  (eso es Contact Intelligence).
- **Events consumed**: `company.discovered.v1`.
- **Events produced**: `company.research_completed.v1` (nuevo).
- **Deterministic gates**: ninguno de bloqueo — produce evidencia, no
  decide.
- **LLM usage**: sí, para sintetizar señales dispersas del sitio en
  hechos citables — con la regla de aislamiento de contenido externo
  (§12 master doc) aplicada estrictamente, porque este agente lee HTML
  de terceros directamente.
- **Data access**: `Company` (actualizar `discoveryMetadata`), Website
  Intelligence (`website-intelligence/*.ts`, ya real).
- **Metrics**: % de Companies con evidencia suficiente para outreach,
  tasa de dato conflictivo detectado.
- **Failure handling**: sitio inaccesible/`robots.txt` bloquea todo →
  `blockedByRobots: true` (ya implementado), Company sigue válida con
  evidencia parcial.
- **Escalation conditions**: evidencia contradictoria entre fuentes
  (ej. tamaño de empresa muy distinto entre dos señales) →
  `HUMAN_REVIEW` tipo `INVALID_CLASSIFICATION`.
- **Autonomy eligibility**: LEVEL 3 (enriquece sin aprobación, nunca
  envía nada).

---

## 6. Contact Intelligence Agent

- **Estado hoy**: **real y en producción** —
  `resolveBestContactChannel` (F24, con scoring anti-contaminación),
  `contact-ranking.ts`, `email-trust.ts`. La jerarquía de roles
  configurable por industria que pide la instrucción maestra **no
  existe todavía** — hoy `ContactDecisionRole` es un enum fijo, no
  configurable por industria.
- **Purpose**: encontrar contactos, extraer canales, normalizar
  emails, detectar contaminación, validar dominio, inferir rol,
  priorizar decisores.
- **Inputs**: `Company` con research completado.
- **Outputs**: `ContactCandidate` (hoy: `Contact`/`CompanyContactPoint`
  directo — ver Fase G para el tipo `ContactCandidate` explícito que
  la instrucción maestra pide, todavía no existe como concepto propio,
  solo como fila de tabla ya persistida).
- **Capabilities**: `CREATE_CONTACT_CANDIDATE`, `VERIFY_CONTACT`.
- **Forbidden actions**: inventar un contacto (ya garantizado hoy —
  "nunca inventa" es literal en el código y los comentarios de
  `contact-channel.ts`).
- **Events consumed**: `company.research_completed.v1`.
- **Events produced**: `contact.discovered.v1`, `contact.verified.v1`.
- **Deterministic gates (ya reales)**: `resolveBestContactChannel`
  (scoring por tier + descarte de contaminación, F24),
  `validateEmailTrust` (dominio propio vs. ajeno), `classifyContactPointType`.
- **LLM usage**: ninguno en la resolución de canal (100% pura); podría
  usarse para inferir rol desde un título de cargo ambiguo (no
  implementado hoy).
- **Data access**: `Contact`, `CompanyContactPoint`.
- **Metrics**: contacts found, verified contacts, decision-maker rate,
  generic inbox rate, enrichment cost.
- **Failure handling**: PDL/Hunter caen (402/429) → cascada sigue con
  el proveedor siguiente (`providersOmitted`, ya real).
- **Escalation conditions**: ningún contacto encontrado tras agotar
  fuentes → pasa a Enrichment Agent (`NEEDS_ENRICHMENT`, ya real F24).
- **Autonomy eligibility**: LEVEL 3.

---

## 7. Enrichment Agent

- **Estado hoy**: ausente como agente propio — `NEEDS_ENRICHMENT`
  (F24) es el ESTADO que hoy marca la necesidad, pero nada reintenta
  activamente con estrategias adicionales; una Company queda ahí hasta
  que un humano/proceso futuro la retome.
- **Purpose**: recibir Companies con `outreachBlockedReason=NEEDS_ENRICHMENT`,
  ejecutar estrategias adicionales, agotar fuentes permitidas,
  registrar intentos, declarar `UNRESOLVABLE`.
- **Inputs**: `Company.outreachBlockedReason=NEEDS_ENRICHMENT`.
- **Outputs**: contacto adicional encontrado, o `UNRESOLVABLE` con
  motivo.
- **Capabilities**: `RETRY_ENRICHMENT`, `DECLARE_UNRESOLVABLE`.
- **Forbidden actions**: reintentar sin límite (principio #13 aplicado
  literalmente — presupuesto máximo por Company y misión, pedido
  explícito de la instrucción maestra).
- **Events consumed**: `company.enrichment_required.v1`.
- **Events produced**: `contact.discovered.v1` (si tiene éxito),
  `company.enrichment_exhausted.v1` (nuevo).
- **Deterministic gates**: presupuesto máximo por Company (nuevo
  contador, ver §14 master doc) y por misión.
- **LLM usage**: ninguno adicional — reusa Contact Intelligence.
- **Data access**: mismo que Contact Intelligence.
- **Metrics**: enrichment attempts, success rate, cost per resolved
  Company, `UNRESOLVABLE` rate.
- **Failure handling**: agotó presupuesto/fuentes →
  `UNRESOLVABLE`, nunca reintento infinito.
- **Escalation conditions**: Company de alto valor estimado
  (`QualificationAssessment` alto) que sigue `UNRESOLVABLE` →
  `HUMAN_REVIEW` tipo `HIGH_VALUE_OPPORTUNITY`.
- **Autonomy eligibility**: LEVEL 3.

---

## 8. Qualification Agent

- **Estado hoy**: parcial — `decideCompanyConversion`
  (`conversion-policy.ts`, ya real y con 7 reglas deterministas) ya
  decide Lead/Opportunity; lo que falta es el `QualificationAssessment`
  explícito (score + motivos + evidencia + riesgos + recomendación)
  como una salida propia y auditable, no solo un side-effect de crear o
  no un Lead.
- **Purpose**: evaluar si una Company es una oportunidad válida,
  determinar fit, estimar valor, detectar necesidad, clasificar
  urgencia, recomendar tipo de outreach.
- **Inputs**: `Company` + evidencia de Research + Contact Intelligence.
- **Outputs**: `QualificationAssessment` (nuevo tipo — puntuación,
  motivos, evidencia, riesgos, recomendación).
- **Capabilities**: `CREATE_QUALIFICATION_ASSESSMENT`.
- **Forbidden actions**: crear Opportunity directamente (eso sigue
  siendo `opportunitiesService.createOpportunity`, con su gate F18 ya
  existente — Qualification recomienda, el chokepoint real de creación
  no cambia).
- **Events consumed**: `contact.verified.v1`.
- **Events produced**: `company.qualified.v1`.
- **Deterministic gates (ya reales, reusados)**: `decideCompanyConversion`
  (7 reglas), `evaluateBusinessIdentityGate`.
- **LLM usage**: opcional para el rationale humano-legible; el score en
  sí es determinista (mismo patrón que `commercialScoreReason` hoy).
- **Data access**: lectura de `Company`/`Contact`/evidencia, escritura
  de `QualificationAssessment`.
- **Metrics**: fit accuracy (medido retroactivamente vs. conversión
  real), score distribution.
- **Failure handling**: evidencia insuficiente → `INSUFFICIENT_EVIDENCE`
  (regla 7 de `decideCompanyConversion`, ya real).
- **Escalation conditions**: score alto pero evidencia conflictiva →
  `HUMAN_REVIEW`.
- **Autonomy eligibility**: LEVEL 3.

---

## 9. Campaign Planner Agent

- **Estado hoy**: parcial — `campaign-tools.impl.ts` (`createCampaign`,
  `selectTargetCompanies`, ya con exclusión de DEMO_SEED F24 y de
  duplicados por campaña ACTIVE) ya existe; lo que falta es la
  responsabilidad de "definir mensaje/secuencia/cadencia/volumen"
  como una decisión propia — hoy la secuencia (día 1/4/9/18) es fija
  en código (`SEQUENCE_DAY_OFFSETS`), no una decisión del planner.
- **Purpose**: agrupar oportunidades, definir mensaje, segmento,
  secuencia, cadencia, volumen, estrategia, crear `CampaignPlan`.
- **Inputs**: `QualificationAssessment[]` agrupables.
- **Outputs**: `CampaignPlan` (nuevo — hoy es implícito en los
  parámetros de `Campaign`, no un plan explícito y revisable antes de
  crearse).
- **Capabilities**: `CREATE_CAMPAIGN_PLAN`.
- **Forbidden actions**: mezclar industrias incompatibles (ya
  garantizado por el fix de F18/F21 de contaminación cruzada de
  industria), duplicar campaña (ya hay dedup por criterio equivalente,
  `createCampaign`).
- **Events consumed**: `company.qualified.v1` (batch).
- **Events produced**: `campaign.plan_created.v1`.
- **Deterministic gates**: dedup de campaña (ya real), saturación de
  dominio (nuevo — pedido explícito por la instrucción maestra, no
  existe hoy: nada impide hoy 2 campañas distintas apuntando al mismo
  dominio de email en paralelo).
- **LLM usage**: ninguno en la decisión de agrupación; podría asistir
  en sugerir el ángulo de mensaje (no en decidir a quién apunta).
- **Data access**: `Campaign`, `CampaignCompany`.
- **Metrics**: campañas creadas, tamaño promedio de segmento, tasa de
  duplicación evitada.
- **Failure handling**: segmento vacío → no crea campaña (ya el
  comportamiento de `selectTargetCompanies` con 0 resultados).
- **Escalation conditions**: volumen propuesto excede
  `PolicyEnvelope.dailyEmailLimit`.
- **Autonomy eligibility**: LEVEL 2 (plan requiere aprobación antes de
  ejecutarse).

---

## 10. Outreach Agent

- **Estado hoy**: **real y en producción** —
  `outreach-tools.impl.ts`/`sales-tools.impl.ts`, con
  `evaluateDraftCreationGate` (F24) como chokepoint único, firma
  concreta forzada en el prompt (hoy mismo, hallazgo de esta sesión),
  prohibición explícita de auto-presentarse sin nombre.
- **Purpose**: redactar mensajes personalizados con datos verificados,
  respetar voz de marca, producir `Draft`, CTA clara, tono adaptado.
- **Inputs**: `CampaignPlan` o `Lead`, evidencia verificada.
- **Outputs**: `ApprovalRequest` (Draft, PENDING).
- **Capabilities**: `CREATE_DRAFT`.
- **Forbidden actions (ya reales)**: enviar (estructuralmente
  imposible — el tool nunca llama a `sendEmail`), usar placeholders
  (F23/F24, bloqueado en 2 capas: prompt + Quality Gate), afirmar
  hechos no confirmados (regla explícita del prompt), presentarse con
  identidad no configurada (fix de hoy).
- **Events consumed**: `campaign.plan_created.v1`.
- **Events produced**: `outreach.draft_created.v1`.
- **Deterministic gates (ya reales)**: `evaluateDraftCreationGate`
  (DEMO_SEED, duplicado activo, client-owner-review, sin canal — F24).
- **LLM usage**: sí, redacción del cuerpo — con firma fija inyectada
  (no generada por el modelo) desde hoy.
- **Data access**: `ApprovalRequest` (crear), lectura de
  `Company`/`Contact`/`Lead`/`Opportunity`.
- **Metrics**: Draft pass rate, revision rate, placeholder failures,
  invalid recipient rate, duplicate prevention rate (todas ya
  calculables desde `ApprovalRequest`/`AuditLog` de hoy).
- **Failure handling**: LLM no devuelve JSON válido →
  `AppError.internal`, tarea `FAILED` (ya real,
  `tryParseJson` retorna null → error claro).
- **Escalation conditions**: gate bloquea repetidamente la misma
  Company → candidato a revisión de clasificación.
- **Autonomy eligibility**: LEVEL 2 (redacta libremente, el envío
  SIEMPRE requiere aprobación — este es, estructuralmente, el techo de
  autonomía de outreach en todo el diseño, sin importar el nivel
  general del sistema).

---

## 11. Quality Agent

- **Estado hoy**: parcial — `evaluateApprovalQualityGate` (F24) YA
  implementa 8 de los 9 checks deterministas pedidos (Company,
  clasificación, contacto, email, placeholders, duplicados, contenido,
  metadata). Lo que falta es la capa de **revisión semántica** (tono,
  riesgo reputacional, tono apropiado por industria) — hoy el gate es
  100% determinista, sin heurísticas ni revisión semántica adicional.
- **Purpose**: revisar Company/Contact/clasificación/contenido/
  destinatario/dedup/frecuencia/políticas/riesgo reputacional, emitir
  `QualityAssessment`.
- **Inputs**: `ApprovalRequest` PENDING.
- **Outputs**: `QualityAssessment` con veredicto `PASS |
  NEEDS_REVISION | NEEDS_ENRICHMENT | HUMAN_REVIEW | BLOCKED`.
- **Capabilities**: `CREATE_QUALITY_ASSESSMENT`.
- **Forbidden actions**: reemplazar los gates deterministas (regla
  explícita de la instrucción maestra — "este agente no reemplaza
  gates deterministas", los complementa).
- **Events consumed**: `outreach.draft_created.v1`.
- **Events produced**: `outreach.quality_passed.v1` o el veredicto
  correspondiente.
- **Deterministic gates (ya reales)**: `evaluateApprovalQualityGate`
  (F24, 8 checks). La capa semántica (LLM) es ADITIVA sobre esto,
  nunca la reemplaza — si el determinista dice `BLOCKED`, ningún LLM
  puede convertirlo en `PASS`.
- **LLM usage**: sí, para la capa de heurística/revisión semántica
  (tono, riesgo reputacional) — nunca para los 8 checks deterministas
  ya duros.
- **Data access**: lectura de `ApprovalRequest`/`Company`/`Contact`.
- **Metrics**: PASS rate, NEEDS_REVISION rate, BLOCKED rate, falsos
  positivos (medido retroactivamente si un `NEEDS_REVISION` termina
  aprobado sin cambios reales).
- **Failure handling**: capa semántica no disponible (LLM caído) → el
  resultado determinista sigue siendo válido y suficiente para
  `PASS`/`BLOCKED` (principio #18: los modelos de IA nunca son la
  única barrera).
- **Escalation conditions**: veredicto `HUMAN_REVIEW`.
- **Autonomy eligibility**: LEVEL 3 (evalúa sin aprobación; el
  resultado de su evaluación es lo que GATEA la aprobación humana, no
  la reemplaza).

---

## 12. Policy & Safety Agent

- **Estado hoy**: parcial — límites existen dispersos (`rate-limiters.ts`
  por IP, `budget.ts`/`data-provider-budget.ts` por tenant/mes,
  `MissionRestrictions` por misión) pero **no hay un punto único** que
  los consulte todos antes de una acción — es exactamente lo que
  `PolicyEnvelope` (ADR-0007) centraliza.
- **Purpose**: aplicar políticas, verificar límites, proteger
  reputación, controlar volumen, detectar acciones peligrosas,
  gestionar aprobaciones, bloquear automatización.
- **Inputs**: `PolicyEnvelope` del tenant/misión, acción propuesta por
  cualquier otro agente.
- **Outputs**: permitir/bloquear + motivo, `HumanReviewRequest` si
  corresponde.
- **Capabilities**: `ENFORCE_POLICY`, `TRIGGER_KILL_SWITCH`.
- **Forbidden actions**: ninguna — es, por diseño, el único agente con
  autoridad de VETO sobre cualquier otro (principio #14, "el sistema
  debe saber cuándo detenerse").
- **Events consumed**: todos los eventos de intención de acción externa
  (`outreach.quality_passed.v1`, `meeting.requested.v1`, etc.).
- **Events produced**: `policy.blocked.v1` (nuevo), `human.review_required.v1`.
- **Deterministic gates**: `hasCapability` (ADR-0007), límites de
  `PolicyEnvelope` (volumen diario, por dominio, ventanas de envío
  permitidas), kill switch por tenant.
- **LLM usage**: ninguno — debe ser 100% determinista, es la última
  barrera de seguridad (principio #18 aplicado literalmente a este
  agente en particular).
- **Data access**: `Tenant.settings` (`PolicyEnvelope`), lectura de
  toda acción propuesta.
- **Metrics**: bloqueos por tipo, excepciones de política solicitadas,
  tiempo hasta detección de anomalía.
- **Failure handling**: ante duda, bloquea (fail-closed, nunca
  fail-open — regla de diseño explícita).
- **Escalation conditions**: cualquier bloqueo repetido del mismo tipo
  → `HumanReviewRequest` tipo `POLICY_EXCEPTION`.
- **Autonomy eligibility**: no aplica un "nivel" — este agente ES el
  mecanismo que impone el nivel de autonomía a todos los demás.

---

## 13. Delivery Agent

- **Estado hoy**: **diseño únicamente — explícitamente no se activa**.
  El mecanismo real de envío (`sendApproval`, F17/F21) sigue siendo el
  único camino, con su idempotencia ya real (`updateMany` condicional +
  índice único parcial, F24).
- **Purpose (futura)**: enviar únicamente mensajes aprobados, rate
  limits, elegir proveedor, idempotencia, registrar `Message`, detectar
  errores, reintentos.
- **Inputs**: `ApprovalRequest` READY_TO_SEND (ya aprobado por humano).
- **Outputs**: `EmailMessage` (ya el modelo real, F17).
- **Capabilities**: `SEND_EMAIL` — la capability más sensible del
  catálogo; ningún `PolicyEnvelope` la otorga por default.
- **Forbidden actions**: enviar sin `ApprovalRequest.status=READY_TO_SEND`
  Y decisión humana explícita (ya estructuralmente imposible saltarse
  hoy — `sendApproval` exige ese estado).
- **Events consumed**: `outreach.approved.v1`.
- **Events produced**: `outreach.sent.v1`, `outreach.delivery_failed.v1`.
- **Deterministic gates (ya reales)**: idempotencia vía `updateMany`
  condicional + índice único parcial (F24), estado `READY_TO_SEND|FAILED`
  exigido.
- **LLM usage**: ninguno.
- **Data access**: `ApprovalRequest`, `EmailMessage`, Microsoft Graph
  (proveedor real, ya integrado).
- **Metrics**: sent, delivered, bounced, provider failures, domain
  saturation.
- **Failure handling (ya real)**: fallo de proveedor → `FAILED`,
  reintentable desde el mismo registro (nunca crea uno nuevo, F21).
- **Escalation conditions**: fallo repetido del mismo proveedor →
  `HumanReviewRequest` tipo `SYSTEM_FAILURE`.
- **Autonomy eligibility**: LEVEL 0 hoy (diseño únicamente, "por ahora:
  diseñar contratos, no activar envío autónomo, preservar el mecanismo
  actual de aprobación humana" — instrucción maestra, literal).

---

## 14. Inbox Monitor Agent

- **Estado hoy**: 100% diseño nuevo. No implementar acceso productivo
  esta sesión (instrucción maestra, literal).
- **Purpose (futura)**: detectar nuevos mensajes, asociarlos a
  Company/Contact/Conversation/Campaign, normalizar threads, evitar
  duplicados, generar `ReplyReceivedEvent`.
- **Inputs**: buzón de Microsoft Graph (proveedor ya integrado para
  envío, lectura sería nueva superficie).
- **Outputs**: `reply.received.v1`.
- **Capabilities**: `READ_INBOX`.
- **Forbidden actions**: responder (eso es Conversation Agent),
  modificar el mensaje original.
- **Events consumed**: ninguno (es el punto de entrada del ciclo de
  respuesta).
- **Events produced**: `reply.received.v1`.
- **Deterministic gates**: dedup por `idempotencyKey` = Message-Id real
  del proveedor (nunca el mismo mensaje procesado dos veces).
- **LLM usage**: ninguno — solo normalización estructural.
- **Data access (futura)**: lectura de buzón vía Graph, escritura de
  `Conversation`/`ConversationMessage` (nuevas entidades).
- **Metrics**: mensajes procesados, tasa de duplicado evitado, latencia
  de detección.
- **Failure handling**: webhook de Graph falla/no llega → poll de
  respaldo (diseño, no implementado).
- **Escalation conditions**: volumen anómalo de mensajes entrantes
  (posible ataque/spam).
- **Autonomy eligibility**: LEVEL 0 (no implementar acceso productivo
  esta sesión — instrucción maestra literal).

---

## 15. Reply Intelligence Agent

- **Estado hoy**: 100% diseño nuevo.
- **Purpose**: clasificar respuestas, detectar intención, preguntas,
  objeciones, interés, rechazo, unsubscribe, ausencia, rebote,
  recomendar siguiente acción.
- **Inputs**: `reply.received.v1`.
- **Outputs**: `ReplyClassification` con la taxonomía completa (ver
  instrucción maestra — 15 valores, reproducida en
  `F25_AGENT_EVENTS_AND_CONTRACTS.md`).
- **Capabilities**: `CLASSIFY_REPLY`.
- **Forbidden actions**: redactar respuesta (eso es Conversation
  Agent) — Reply Intelligence solo clasifica.
- **Events consumed**: `reply.received.v1`.
- **Events produced**: `reply.classified.v1`.
- **Deterministic gates**: `UNSUBSCRIBE`/`SPAM_COMPLAINT`/`BOUNCE` →
  siempre suprime el contacto (`doNotContact=true`/`bouncedAt`, campos
  ya existentes en `Contact`) de forma determinista, nunca depende de
  que el LLM "decida" suprimir.
- **LLM usage**: sí, para la clasificación de intención en texto libre
  — con aislamiento de contenido externo obligatorio (§12 master doc,
  este es el agente de MAYOR riesgo de prompt injection del catálogo,
  porque procesa texto que un tercero externo escribió con la
  intención expresa de ser leído por el sistema).
- **Data access**: `Contact` (actualizar supresión),
  `Conversation`/`ConversationMessage` (nuevas).
- **Metrics**: reply rate, positive reply rate, unsubscribe rate,
  wrong-person rate, classification confidence.
- **Failure handling**: clasificación de baja confianza →
  `HUMAN_REVIEW_REQUIRED` (ya un valor de la taxonomía pedida).
- **Escalation conditions**: `SPAM_COMPLAINT` (riesgo reputacional
  inmediato) → escalación automática a Policy & Safety Agent, nunca
  solo un log.
- **Autonomy eligibility**: LEVEL 0 (no implementar esta sesión).

---

## 16. Conversation Agent

- **Estado hoy**: parcial — `conversation-tools.ts`/`classifyConversation`
  ya existe para clasificar intención DENTRO de una campaña (`lastIntent`
  en `CampaignCompany`), pero no redacta respuestas ni sostiene
  contexto multi-turno.
- **Purpose (futura)**: redactar respuestas, mantener contexto,
  resolver preguntas básicas, avanzar la conversación, reconocer
  límites.
- **Inputs**: `reply.classified.v1` + historial de `Conversation`.
- **Outputs**: `ApprovalRequest` (respuesta como Draft — mismo
  mecanismo de aprobación que outreach inicial, nunca un camino
  separado más laxo).
- **Capabilities**: `DRAFT_REPLY`.
- **Forbidden actions (ya explícitas en la instrucción maestra)**:
  negociar contratos finales, prometer candidatos inexistentes,
  inventar disponibilidad, aceptar condiciones legales, confirmar
  precios no autorizados, enviar sin políticas aplicables.
- **Events consumed**: `reply.classified.v1`.
- **Events produced**: `conversation.reply_drafted.v1` (nuevo).
- **Deterministic gates**: mismo `evaluateApprovalQualityGate` (F24)
  reusado — una respuesta de conversación pasa por el MISMO Quality
  Gate que un draft inicial, nunca un camino separado.
- **LLM usage**: sí, redacción — con los mismos límites de contenido
  no confiable que Reply Intelligence.
- **Data access**: `Conversation`/`ConversationMessage`,
  `ApprovalRequest`.
- **Metrics**: resolution rate sin escalar, tiempo de respuesta,
  reaperturas.
- **Failure handling**: pregunta fuera de los límites conocidos →
  `HUMAN_REVIEW_REQUIRED`, nunca improvisa una respuesta fuera de
  política.
- **Escalation conditions**: cualquier tema de negociación/precio/legal
  detectado → Negotiation Agent o Human Escalation directo.
- **Autonomy eligibility**: LEVEL 0 (no implementar esta sesión).

---

## 17. Negotiation Agent

- **Estado hoy**: 100% diseño nuevo.
- **Purpose (futura)**: manejar rangos autorizados, evaluar
  objeciones, proponer opciones, escalar decisiones fuera de límites.
- **Inputs**: intención de negociación detectada por Conversation
  Agent.
- **Outputs**: propuesta dentro de rango, o escalación.
- **Capabilities**: `PROPOSE_WITHIN_RANGE` — toda capacidad de
  negociación se basa en un `PolicyEnvelope` explícito (instrucción
  maestra, literal) que declara el rango autorizado; sin rango
  configurado, el agente NUNCA propone nada, escala directo.
- **Forbidden actions**: proponer fuera del rango de `PolicyEnvelope`.
- **Events consumed**: `conversation.negotiation_detected.v1` (nuevo).
- **Events produced**: `negotiation.proposed.v1` (nuevo) o
  `human.review_required.v1`.
- **Deterministic gates**: rango de `PolicyEnvelope`, siempre
  determinista (nunca el LLM decide el rango, solo redacta la
  propuesta dentro de él).
- **LLM usage**: redacción de la propuesta, nunca el cálculo del rango.
- **Data access**: `PolicyEnvelope`, `Opportunity`.
- **Metrics**: propuestas dentro de rango vs. escaladas, tasa de cierre.
- **Failure handling**: sin rango configurado → escala siempre.
- **Escalation conditions**: cualquier objeción fuera del rango
  conocido.
- **Autonomy eligibility**: LEVEL 0 (no implementar esta sesión).

---

## 18. Meeting Agent

- **Estado hoy**: 100% diseño nuevo. No crear reuniones reales esta
  sesión (instrucción maestra, literal).
- **Purpose (futura)**: identificar intención de reunión, proponer
  horarios, comprobar disponibilidad, crear `BookingProposal`, registrar
  resultado.
- **Inputs**: intención de reunión (de Conversation Agent).
- **Outputs**: `MeetingProposal`/`BookingProposal`.
- **Capabilities**: `CREATE_MEETING_PROPOSAL` (nunca `BOOK_MEETING`
  directo — eso es Calendar Agent, con permiso separado).
- **Forbidden actions**: reservar directamente sin pasar por Calendar
  Agent + permiso explícito.
- **Events consumed**: `conversation.reply_drafted.v1` (cuando implica
  intención de reunión).
- **Events produced**: `meeting.requested.v1`.
- **Deterministic gates**: ninguno propio — Calendar Agent es quien
  gatea la reserva real.
- **LLM usage**: interpretar la intención/preferencia de horario en
  texto libre.
- **Data access**: lectura de disponibilidad (vía Calendar Agent).
- **Metrics**: requested, booked, attended, qualified, converted.
- **Failure handling**: sin disponibilidad compatible → propone
  alternativas, nunca inventa un horario.
- **Escalation conditions**: conflicto de horario detectado.
- **Autonomy eligibility**: LEVEL 0 (no implementar esta sesión).

---

## 19. Calendar Agent

- **Estado hoy**: 100% diseño nuevo.
- **Purpose (futura)**: consultar disponibilidad, reservar,
  reprogramar, cancelar, confirmar.
- **Inputs**: `BookingProposal` aprobado.
- **Outputs**: reunión creada (en un proveedor de calendario real, no
  elegido en esta sesión).
- **Capabilities**: `BOOK_MEETING` — requiere permisos explícitos y
  políticas por tenant (instrucción maestra, literal); ningún
  `PolicyEnvelope` la otorga por default, igual que `SEND_EMAIL`.
- **Forbidden actions**: reservar sin `meetingBookingPermission=true`
  en el `PolicyEnvelope` del tenant.
- **Events consumed**: `meeting.requested.v1` (ya aprobado).
- **Events produced**: `meeting.booked.v1`.
- **Deterministic gates**: verificación de disponibilidad real (nunca
  doble-booking), permiso de tenant.
- **LLM usage**: ninguno.
- **Data access**: proveedor de calendario externo (no integrado
  todavía).
- **Metrics**: booked, rescheduled, canceled, conflict rate.
- **Failure handling**: conflicto detectado → no reserva, propone
  alternativa.
- **Escalation conditions**: cualquier reserva fuera de las ventanas
  permitidas (`PolicyEnvelope.allowedSendWindows`, reutilizado para
  ventanas de reunión).
- **Autonomy eligibility**: LEVEL 0 (no implementar esta sesión).

---

## 20. CRM Agent

- **Estado hoy**: parcial — cada `service.ts` (`leads/service.ts`,
  `opportunities/service.ts`, etc.) ya mantiene el CRM actualizado como
  side-effect de cada acción; lo que falta es un agente PROPIO que
  vigile consistencia/detecte inconsistencias de forma independiente
  (hoy nadie audita "¿este Lead quedó en un estado imposible?" de forma
  centralizada).
- **Purpose**: mantener entidades sincronizadas, actualizar etapas,
  registrar actividad, preservar historial, deduplicar, detectar
  inconsistencias, crear tareas humanas cuando corresponda.
- **Inputs**: todo evento que implique cambio de estado de una entidad
  CRM.
- **Outputs**: `Activity` (ya existe), `HumanReviewRequest` si detecta
  inconsistencia.
- **Capabilities**: `UPDATE_PIPELINE`, `CREATE_HUMAN_REVIEW`.
- **Forbidden actions**: ocultar o sobrescribir evidencia histórica
  (instrucción maestra, literal — coincide con el principio ya
  establecido en este proyecto de "nunca borrar, solo archivar/marcar",
  ver F23 diseño de cuarentena de la sesión anterior).
- **Events consumed**: prácticamente todo evento de negocio (es un
  suscriptor amplio por diseño).
- **Events produced**: ninguno propio de negocio — registra, no
  origina.
- **Deterministic gates**: consistencia de estado (ej. una Opportunity
  `WON` con un Lead todavía `NEW` es inconsistente — detectarlo,
  nunca corregirlo solo).
- **LLM usage**: ninguno.
- **Data access**: lectura amplia, escritura de `Activity`/
  `HumanReviewRequest`.
- **Metrics**: inconsistencias detectadas, tiempo de resolución.
- **Failure handling**: n/a — es un observador, no ejecuta acciones de
  negocio propias.
- **Escalation conditions**: cualquier inconsistencia de estado
  detectada.
- **Autonomy eligibility**: LEVEL 3 (observa y registra sin
  aprobación; nunca corrige datos solo).

---

## 21. Analytics Agent

- **Estado hoy**: parcial — `apps/api/src/modules/analytics/*` ya
  calcula métricas comerciales/financieras/reclutamiento; falta la
  responsabilidad de "informar al CEO Agent" como un flujo propio
  (hoy son endpoints que un humano consulta, no un reporte empujado).
- **Purpose**: calcular métricas, cohortes, cuellos de botella,
  comparar campañas, medir fuentes, detectar anomalías, informar al CEO
  Agent.
- **Inputs**: datos agregados de todas las etapas.
- **Outputs**: `AnalyticsReport` (nuevo — hoy son respuestas HTTP ad
  hoc, no una entidad/evento).
- **Capabilities**: `READ_ALL_METRICS`, `PUBLISH_REPORT`.
- **Forbidden actions**: escribir sobre datos de negocio (es
  estrictamente de lectura + agregación).
- **Events consumed**: todos los eventos de negocio (agregación).
- **Events produced**: `analytics.report_ready.v1`.
- **Deterministic gates**: n/a.
- **LLM usage**: opcional, para resumir hallazgos en lenguaje natural
  para el CEO Agent — nunca para calcular la métrica en sí.
- **Data access**: lectura amplia (todas las entidades de negocio),
  ninguna escritura.
- **Metrics**: las de §15 master doc, todas las familias.
- **Failure handling**: dato faltante en un período → reporta el hueco
  explícitamente, nunca interpola/inventa.
- **Escalation conditions**: anomalía detectada (caída brusca de una
  métrica clave).
- **Autonomy eligibility**: LEVEL 4 (puede correr y publicar reportes
  sin aprobación — es puramente informativo, no actúa).

---

## 22. Learning Agent

- **Estado hoy**: 100% diseño nuevo.
- **Purpose (futura)**: aprender de resultados, proponer ajustes,
  comparar estrategias, crear experimentos, actualizar
  recomendaciones. Nunca cambia producción automáticamente.
- **Inputs**: `AnalyticsReport` histórico.
- **Outputs**: `LearningProposal`, ciclo obligatorio `PROPOSED →
  REVIEWED → APPROVED → ACTIVATED` (instrucción maestra, literal).
- **Capabilities**: `PROPOSE_LEARNING_CHANGE` — nunca
  `ACTIVATE_LEARNING_CHANGE` directo, ese paso es exclusivamente
  humano.
- **Forbidden actions**: activar cualquier cambio sin pasar por las 4
  etapas del ciclo.
- **Events consumed**: `analytics.report_ready.v1`.
- **Events produced**: `learning.proposal_created.v1` (nuevo).
- **Deterministic gates**: el ciclo de 4 etapas en sí es el gate — sin
  excepciones, sin atajos.
- **LLM usage**: sí, para generar hipótesis de mejora a partir de
  patrones — la ACTIVACIÓN nunca es decisión del LLM.
- **Data access**: lectura de Analytics, escritura de
  `LearningProposal`.
- **Metrics**: propuestas generadas, tasa de aprobación, impacto medido
  post-activación.
- **Failure handling**: n/a (nunca actúa solo).
- **Escalation conditions**: toda propuesta es, por diseño, una
  escalación a revisión humana (`HumanReviewRequest` tipo
  `LEARNING_PROPOSAL`).
- **Autonomy eligibility**: LEVEL 1 como techo estructural
  (propone, nunca ejecuta) — sin importar qué nivel general alcance el
  resto del sistema en el futuro, este agente permanece en Assist.

---

## 23. Human Escalation Agent

- **Estado hoy**: ausente como agente propio — hoy la "escalación a
  humano" es simplemente dejar un `ApprovalRequest`/`Company` en un
  estado que un humano eventualmente revisa en la UI, sin
  consolidación ni priorización.
- **Purpose**: consolidar casos que requieren decisión humana,
  explicar contexto, presentar evidencia, proponer opciones, reducir
  carga cognitiva. Evitar crear tareas humanas innecesarias.
- **Inputs**: cualquier evento `human.review_required.v1` de cualquier
  otro agente.
- **Outputs**: `HumanReviewRequest` consolidado (ver contrato completo
  en `F25_AUTONOMY_POLICY_MODEL.md`).
- **Capabilities**: `CREATE_HUMAN_REVIEW`, `DEDUPLICATE_REVIEW_REQUESTS`.
- **Forbidden actions**: crear una solicitud duplicada para el mismo
  caso (dedup explícito, instrucción maestra: "evitar crear tareas
  humanas innecesarias").
- **Events consumed**: `human.review_required.v1` de todos los agentes.
- **Events produced**: ninguno adicional — es el sumidero final de la
  cadena de escalación.
- **Deterministic gates**: dedup por entidad afectada + tipo (nunca dos
  `HumanReviewRequest` abiertos para el mismo `Company`+tipo
  simultáneamente).
- **LLM usage**: sí, para sintetizar el resumen/evidencia/opciones en
  un formato legible — nunca para decidir la prioridad (eso es una
  regla determinista por tipo, ver `F25_AUTONOMY_POLICY_MODEL.md`).
- **Data access**: `HumanReviewRequest` (nueva entidad, crear/consolidar).
- **Metrics**: tasa de escalación evitada (dedup), tiempo hasta
  resolución humana, backlog.
- **Failure handling**: n/a.
- **Escalation conditions**: n/a — es el destino final, no escala más
  allá.
- **Autonomy eligibility**: LEVEL 3 (consolida sin aprobación; la
  DECISIÓN sigue siendo 100% humana por definición de este agente).
