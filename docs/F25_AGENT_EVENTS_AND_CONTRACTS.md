# F25 — Eventos y Contratos

Depende de: ADR-0002 (outbox sobre `DomainEvent`), ADR-0005
(versionado embebido `.vN`). Esta sesión **documenta y tipa** estos
contratos (Fase G); la migración de schema que los persiste
(extensión de `DomainEvent`) es F25.3, no esta sesión.

## 1. El sobre de evento (`AgentEventEnvelope`)

Todo evento, sin excepción, tiene esta forma:

```typescript
interface AgentEventEnvelope<TPayload = unknown> {
  eventId: string;          // cuid, único por publicación
  eventType: string;        // "company.discovered.v1" -- ver ADR-0005
  tenantId: string;         // multi-tenant obligatorio, principio #20
  correlationId: string;    // ver §3 -- el mismo missionId/runId de punta a punta
  causationId: string | null; // eventId del evento que causó este (null si es raíz, ej. strategic_mission.created.v1)
  actorType: "AGENT" | "HUMAN" | "SYSTEM";
  actorId: string;          // AgentInstance.id, User.id, o "system"
  entityType: string;       // "company", "contact", "approvalRequest"...
  entityId: string;
  occurredAt: string;       // ISO 8601, cuándo ocurrió el hecho (no cuándo se procesó)
  payload: TPayload;
  metadata: Record<string, unknown>; // libre, nunca gobierna lógica -- solo contexto adicional
  idempotencyKey: string;   // único -- ver §4
}
```

Regla de parseo (ADR-0005): el Zod schema de cada `payload` usa
`.passthrough()`, nunca `.strict()` — un publisher más nuevo que agrega
un campo opcional no rompe un consumidor más viejo.

## 2. Quién publica, quién consume

| Regla | Detalle |
|---|---|
| Un evento lo publica **exactamente un** agente/servicio (dueño único) | Nunca dos agentes distintos publican el mismo `eventType` — evita ambigüedad sobre "quién es la fuente de verdad de este hecho" |
| Cualquier número de agentes puede **consumir** el mismo evento | El Orchestrator (COO) es siempre un consumidor implícito de todo evento de negocio, para decidir el siguiente paso |
| Un consumidor nunca asume orden entre `eventType` distintos | Solo el orden DENTRO de una misma `correlationId` + mismo `eventType` está garantizado (por `occurredAt`/`createdAt`) |
| Un evento nunca se muta ni se borra tras publicarse | Igual criterio que `AuditLog` — historial inmutable |

## 3. Correlación y trazabilidad

IDs que atraviesan una misión de punta a punta:

```
missionId       -- el AgentTask raíz (type="daily_revenue_mission" hoy;
                   o el futuro StrategicMission.id)
correlationId   -- = missionId para TODO lo que esa misión origina,
                   directa o indirectamente (regla simple: una
                   correlationId por misión, nunca por sub-tarea)
causationId     -- eventId del evento inmediatamente anterior en la
                   cadena (permite reconstruir el árbol exacto, no solo
                   "pertenece a esta misión" sino "en qué orden pasó")
runId           -- si un AgentDefinition corre la misma lógica más de
                   una vez dentro de la misma misión (ej. Enrichment
                   reintentando), runId distingue cada intento
taskId          -- AgentTask.id individual
campaignId, companyId, contactId, conversationId, approvalRequestId,
messageId       -- IDs de entidad de negocio ya existentes, se
                   propagan en el payload/metadata del evento, nunca
                   se inventan nuevos identificadores paralelos
```

Reconstrucción (todas responderse con una query
`WHERE correlationId = X ORDER BY occurredAt`, sin joins complejos ni
herramienta externa):

- *¿Por qué se descubrió esta Company?* → primer evento de la
  `correlationId` con `entityType='company', entityId=X` →
  `company.discovered.v1`.
- *¿Qué evidencia produjo la clasificación?* → `payload` de ese mismo
  evento (referencia al `CompanyValidationRecord`/`CompanyEvidenceRecord`).
- *¿Por qué se eligió este Contact?* → `contact.discovered.v1` con
  `causationId` apuntando al evento de Company que lo originó.
- *¿Por qué se generó este Draft?* → `outreach.draft_created.v1`,
  `causationId` → `company.qualified.v1` → ... hasta la raíz.
- *¿Qué gates pasó?* → cadena de `AgentDecisionResult` referenciada en
  `metadata` de cada evento intermedio (`outreach.quality_passed.v1`
  lleva el resultado completo de `evaluateApprovalQualityGate`).
- *¿Quién lo aprobó?* → `AuditLog` existente (`approval.decided`) +
  `actorId` del evento `outreach.approved.v1`.
- *¿Qué mensaje se envió, qué respuesta llegó, cómo se clasificó, qué
  acción posterior se tomó?* → sigue la misma cadena
  `outreach.sent.v1 → reply.received.v1 (causationId apunta al
  messageId) → reply.classified.v1 → conversation/meeting siguiente`.

## 4. Idempotencia

Toda acción sensible acepta una `idempotencyKey` explícita — nunca se
infiere de "no debería repetirse":

| Acción | `idempotencyKey` propuesta |
|---|---|
| Creación de `AgentTask` | `${correlationId}:${eventType}:${entityId}` — la misma combinación nunca crea 2 tareas |
| Creación de Draft (`ApprovalRequest`) | **ya real, F24**: índice único parcial `(tenantId, companyId)` sobre estados activos — el mecanismo de idempotencia MÁS FUERTE del catálogo (constraint de DB, no solo aplicación) |
| `ApprovalRequest` | igual que arriba — un Draft activo por Company, sin excepción |
| Envío de mensaje | **ya real, F21**: `updateMany` condicional (`status IN (READY_TO_SEND,FAILED)`) como claim atómico antes de llamar al proveedor |
| Ingesta de respuesta | Message-Id real del proveedor de email (RFC 5322) — nunca un ID generado por el sistema, porque el objetivo es deduplicar reintentos de webhook del PROVEEDOR |
| Creación de reunión | `${conversationId}:${proposedSlot}` — dos propuestas para el mismo slot de la misma conversación son la misma reunión |
| Actualización de etapa (CRM) | `${entityType}:${entityId}:${targetStage}` — mover un Lead a `CONVERTED` dos veces con la misma causa es un no-op, no un error |

Evitar dobles envíos/dobles Draft/duplicación de respuestas/reuniones
duplicadas/tareas huérfanas/reintentos peligrosos: la regla general es
**la garantía real siempre vive en una constraint de base de datos
cuando la acción es irreversible** (envío de email, creación de Draft
activo) — un `idempotencyKey` de aplicación es la primera línea
(mensaje de error claro, rápido) pero NUNCA la única, exactamente el
mismo patrón que F24 ya estableció (`hasActiveApprovalForCompany` +
índice único parcial como defensa en profundidad).

## 5. Catálogo de eventos (v1)

Formato por evento: `eventType` | dueño (quién publica) | disparador |
payload esencial | consumidores esperados | política de reintento.

### Estrategia y coordinación

- **`strategic_mission.created.v1`** — dueño: CEO Agent. Disparador:
  interpretación de objetivo completada. Payload:
  `{ missionId, objective, priorities[], budgetUsd, restrictions
  (MissionRestrictions, ya real) }`. Consumidores: COO/Orchestrator.
  Reintento: N/A (creación, no falla parcialmente).

- **`territory.proposed.v1`** — dueño: Territory Strategy Agent.
  Payload: `{ territoryId, states[], cities[], industries[],
  rationale }`. Consumidores: Discovery, CEO (para aprobación si
  aplica). Reintento: N/A.

- **`agent.task_failed.v1`** — dueño: COO/Orchestrator (republicación
  central de cualquier fallo). Payload: `{ taskId, errorCategory (§13
  master doc), attempt, maxAttempts, lastErrorMessage }`. Consumidores:
  Analytics, Human Escalation (si `FAILED_FINAL`). Reintento: N/A (es
  la notificación DE un fallo, no reintenta a sí misma).

- **`human.review_required.v1`** — dueño: cualquier agente (vía Human
  Escalation Agent, que lo consolida). Payload:
  `{ reviewRequestId, type (10 valores, §16 master doc), priority,
  entityType, entityId, summary, evidence, options[], recommendation }`.
  Consumidores: Human Escalation Agent, UI de Approvals/Human Review
  Center. Reintento: N/A.

### Pipeline comercial (Discovery → Approval)

- **`company.discovered.v1`** — dueño: Discovery Agent. Disparador:
  `persistAcceptedCandidate` (ya real). Payload:
  `{ companyId, origin, businessConfidence, tradeKey?, sourceUrl? }`.
  Consumidores: Company Research, CRM, Analytics. Reintento:
  RETRYABLE_NETWORK/PROVIDER si la persistencia falla por causa
  externa.

- **`company.research_completed.v1`** — dueño: Company Research Agent.
  Payload: `{ companyId, evidenceSummary, confidenceLevel
  (CONFIRMED|INFERRED|HYPOTHESIS|OUTDATED|CONFLICTING) }`. Consumidores:
  Contact Intelligence, Qualification. Reintento: RETRYABLE_NETWORK
  (sitio inaccesible temporalmente) vs. terminal si `robots.txt`
  bloquea (no es un error, es una restricción legítima).

- **`contact.discovered.v1`** — dueño: Contact Intelligence Agent. Ya
  parcialmente real (`contact.discovered_by_agent` en `AuditLog` hoy).
  Payload: `{ contactId | companyContactPointId, companyId, channel
  (ContactChannelType, ya real F24), verificationStatus }`.
  Consumidores: Enrichment (si no hay ninguno), Qualification.
  Reintento: RETRYABLE_PROVIDER (PDL/Hunter 402/429, ya manejado hoy
  vía `providersOmitted`).

- **`contact.verified.v1`** — dueño: Contact Intelligence Agent.
  Payload: `{ contactId, emailVerificationStatus }`. Consumidores:
  Qualification, Outreach. Reintento: RETRYABLE_PROVIDER.

- **`company.enrichment_required.v1`** — dueño: Contact Intelligence
  Agent (cuando agota tiers sin resultado — ya el momento exacto en que
  hoy F24 setea `outreachBlockedReason=NEEDS_ENRICHMENT`). Payload:
  `{ companyId, attemptedChannels[], reason }`. Consumidores:
  Enrichment Agent. Reintento: N/A (es la señal de "hace falta más
  trabajo", no un fallo).

- **`company.enrichment_exhausted.v1`** — dueño: Enrichment Agent.
  Payload: `{ companyId, attemptsUsed, budgetUsd, declaredUnresolvable: true }`.
  Consumidores: CRM (marca), Human Escalation (si alto valor).
  Reintento: N/A (terminal por diseño).

- **`company.qualified.v1`** — dueño: Qualification Agent. Payload:
  `{ companyId, assessmentId, score, recommendation, risks[] }`.
  Consumidores: Campaign Planner, Analytics. Reintento: N/A.

- **`campaign.plan_created.v1`** — dueño: Campaign Planner Agent.
  Payload: `{ campaignPlanId, companyIds[], messageAngle, cadence,
  volume }`. Consumidores: Outreach, Policy & Safety (verificación de
  volumen antes de ejecutar). Reintento: N/A.

- **`outreach.draft_created.v1`** — dueño: Outreach Agent. Ya real como
  `outreach.drafted_by_agent`/`outreach.message_personalized_by_agent`
  en `AuditLog`. Payload: `{ approvalRequestId, companyId, channel,
  subjectPreview }`. Consumidores: Quality Agent. Reintento:
  RETRYABLE_PROVIDER (LLM caído) vs. INVALID_INPUT (JSON malformado,
  ya manejado hoy).

- **`outreach.quality_passed.v1`** — dueño: Quality Agent. Payload:
  `{ approvalRequestId, verdict (PASS|NEEDS_REVISION|NEEDS_ENRICHMENT|
  HUMAN_REVIEW|BLOCKED), failedChecks[] }`. Consumidores: Policy &
  Safety, UI de Approvals. Reintento: N/A.

- **`outreach.approval_required.v1`** — dueño: Quality Agent (cuando
  `verdict=PASS`, el paso siguiente SIEMPRE es humano — nunca se
  salta). Payload: `{ approvalRequestId }`. Consumidores: UI de
  Approvals, Human Escalation. Reintento: N/A.

- **`outreach.approved.v1`** — dueño: el endpoint humano de decisión
  (`decideApproval`, ya real F21/F24). Payload: `{ approvalRequestId,
  decidedById, decidedAt }`. Consumidores: Delivery Agent (cuando se
  active), Analytics. Reintento: N/A.

- **`outreach.sent.v1`** — dueño: Delivery Agent (futuro; hoy
  `sendApproval` ya real). Payload: `{ approvalRequestId,
  emailMessageId, providerMessageId }`. Consumidores: CRM, Analytics,
  futuro Inbox Monitor (para asociar la respuesta). Reintento: N/A
  (terminal — el reintento de ENVÍO vive en el estado `FAILED`
  reintentable de `ApprovalRequest`, ya real).

- **`outreach.delivery_failed.v1`** — dueño: Delivery Agent. Payload:
  `{ approvalRequestId, providerErrorCode, retryable }`. Consumidores:
  COO (decide reintento), Human Escalation (si no retryable).
  Reintento: según `retryable`.

### Ciclo de respuesta (diseño, no activo)

- **`reply.received.v1`** — dueño: Inbox Monitor Agent. Payload:
  `{ messageId (idempotencyKey), companyId?, contactId?, threadId,
  bodyPreview }`. Consumidores: Reply Intelligence. Reintento:
  RETRYABLE_NETWORK.

- **`reply.classified.v1`** — dueño: Reply Intelligence Agent. Payload:
  `{ messageId, classification (15 valores, §Taxonomía), confidence }`.
  Consumidores: Conversation, CRM, Policy & Safety (si
  `SPAM_COMPLAINT`/`UNSUBSCRIBE`). Reintento: N/A.

- **`meeting.requested.v1`** — dueño: Meeting Agent. Payload:
  `{ conversationId, proposedSlots[] }`. Consumidores: Calendar Agent.
  Reintento: N/A.

- **`meeting.booked.v1`** — dueño: Calendar Agent. Payload:
  `{ meetingId, companyId, contactId, scheduledFor }`. Consumidores:
  CRM, Analytics. Reintento: N/A.

### Aprendizaje

- **`analytics.report_ready.v1`** — dueño: Analytics Agent. Payload:
  `{ reportId, period, metrics }`. Consumidores: CEO, Learning.
  Reintento: N/A.

- **`learning.proposal_created.v1`** — dueño: Learning Agent. Payload:
  `{ proposalId, hypothesis, expectedImpact, status: "PROPOSED" }`.
  Consumidores: Human Escalation. Reintento: N/A.

## 6. Ejemplo completo (trazabilidad de punta a punta)

```json
{
  "eventId": "evt_01hxyz...",
  "eventType": "outreach.draft_created.v1",
  "tenantId": "tenant-titan",
  "correlationId": "mission_cmrx...",
  "causationId": "evt_...company.qualified.v1...",
  "actorType": "AGENT",
  "actorId": "agentinstance_outreach...",
  "entityType": "approvalRequest",
  "entityId": "cmrxn3mjd000ithmgqtl658vc",
  "occurredAt": "2026-07-23T15:01:57.338Z",
  "payload": {
    "approvalRequestId": "cmrxn3mjd000ithmgqtl658vc",
    "companyId": "f24valco0000000000000001",
    "channel": "VERIFIED_ORG_EMAIL",
    "subjectPreview": "Staffing Solutions for F24 Validation Co"
  },
  "metadata": { "gateResult": "allowed" },
  "idempotencyKey": "mission_cmrx...:outreach.draft_created.v1:f24valco0000000000000001"
}
```

(IDs tomados de la validación real de producción de hoy, F24 §5 —
ilustra que el evento describe algo que YA sucedió con el mecanismo
actual, aunque el bus de eventos todavía no exista para publicarlo de
verdad — ver roadmap F25.3.)
