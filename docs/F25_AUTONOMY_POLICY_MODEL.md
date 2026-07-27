# F25 — Modelo de Autonomía y Políticas

Depende de: ADR-0007 (capacidades/políticas en código, sin tabla RBAC
nueva).

**Nivel actual del sistema: LEVEL 1 (ASSIST). No se habilita ningún
nivel superior en esta sesión, ni el código lo permite estructuralmente
hoy** (ningún camino existe hoy para que un agente envíe/reserve/actúe
externamente sin pasar por `ApprovalRequest` + decisión humana).

## 1. Niveles de autonomía

| Nivel | Nombre | Qué puede hacer | Qué NO puede hacer | Estado en este repo |
|---|---|---|---|---|
| **0** | OBSERVE | Solo analiza, no escribe, no crea tareas externas | Nada de escritura | Reply Intelligence, Conversation, Negotiation, Meeting, Calendar, Delivery, Inbox Monitor — todos hoy en 0 (diseño, no activados) |
| **1** | ASSIST | Crea recomendaciones, genera borradores; TODO requiere aprobación | Ejecutar sin aprobación | **Nivel actual real del sistema completo** — Outreach ya genera Drafts, pero el envío exige aprobación humana explícita (F17/F21/F24, ya construido) |
| **2** | SUPERVISED | Ejecuta tareas internas (crear Company/Lead/Opportunity); outreach y respuestas requieren aprobación | Enviar/reservar sin aprobación | CEO, Territory Strategy, Campaign Planner — recomiendan con posibilidad de ejecutar tareas internas, siempre con aprobación en la frontera externa |
| **3** | GUARDED AUTONOMY | Puede enviar bajo políticas estrictas; casos sensibles se escalan; límites de volumen bajos | Exceder `PolicyEnvelope`, ignorar escalación | Discovery, Company Research, Contact Intelligence, Enrichment, Qualification, Quality Agent, CRM, Human Escalation — ejecutan sin aprobación PERO nunca tocan envío externo |
| **4** | AUTONOMOUS OPERATIONS | Opera end-to-end dentro de `PolicyEnvelope`; supervisión por excepción | Ignorar kill switch | Orchestrator (coordina, nunca envía él mismo), Analytics |
| **5** | OPTIMIZING ORGANIZATION | Propone experimentos, redistribuye presupuesto, adapta estrategia; cambios estratégicos requieren aprobación | Activar un cambio sin el ciclo PROPOSED→ACTIVATED | Learning Agent — techo estructural propio, nunca sube de nivel 1 de facto (propone, nunca ejecuta, sin importar qué nivel general tenga el resto) |

**Regla dura**: el nivel de un AGENTE INDIVIDUAL puede ser 3 o 4 (ej.
Discovery ya opera sin aprobación humana por candidato — así funciona
hoy en producción). El nivel del SISTEMA es el máximo nivel al que
llega cualquier acción con impacto EXTERNO (envío de email, reserva de
reunión, respuesta a un tercero) — y ese máximo, hoy y tras esta
sesión, sigue siendo **1**, porque `SEND_EMAIL`/`BOOK_MEETING` no están
otorgadas a ningún `PolicyEnvelope` por default (ver §3).

## 2. Sistema de capacidades (`AgentCapability`)

Catálogo cerrado (enum TypeScript, `packages/agents/src/core/AgentCapability.ts`):

```
DISCOVER_COMPANY, READ_COMPANY, UPDATE_COMPANY_RESEARCH,
CREATE_CONTACT_CANDIDATE, VERIFY_CONTACT, CREATE_DRAFT,
REQUEST_APPROVAL, SEND_EMAIL, READ_INBOX, CLASSIFY_REPLY,
CREATE_MEETING_PROPOSAL, BOOK_MEETING, UPDATE_PIPELINE,
CREATE_HUMAN_REVIEW, PROPOSE_LEARNING_CHANGE,
// capacidades adicionales identificadas al construir el catálogo completo (§F25_AGENT_CATALOG.md):
CREATE_STRATEGIC_MISSION, READ_ANALYTICS, SET_BUDGET_ALLOCATION,
PAUSE_PIPELINE, CLAIM_TASK, CREATE_TASK, RETRY_TASK, CANCEL_TASK,
ESCALATE_BLOCKED_TASK, READ_WORKER_CAPACITY, PROPOSE_TERRITORY,
RETRY_ENRICHMENT, DECLARE_UNRESOLVABLE, CREATE_QUALIFICATION_ASSESSMENT,
CREATE_CAMPAIGN_PLAN, CREATE_QUALITY_ASSESSMENT, ENFORCE_POLICY,
TRIGGER_KILL_SWITCH, DRAFT_REPLY, PROPOSE_WITHIN_RANGE,
PUBLISH_REPORT, DEDUPLICATE_REVIEW_REQUESTS
```

- Cada `AgentDefinition` declara su lista en `availableTools` (columna
  `Json` ya existente, hoy inerte — ADR-0007). Ninguna migración
  necesaria para declararlo; el ENFORCEMENT (F25.5) es lo que falta.
- Verificación: función pura `hasCapability(definition, capability):
  boolean` — determinista, sin DB, testeada esta sesión (ver Fase G).
- **Ningún agente tiene todas las capacidades** (principio #2). El
  ejemplo más estricto: `SEND_EMAIL` y `BOOK_MEETING` son las únicas
  dos capacidades que, en el `PolicyEnvelope` default de cualquier
  tenant, empiezan **denegadas** — deben otorgarse explícitamente, y
  aun otorgadas, exigen que `ApprovalRequest`/`BookingProposal` ya haya
  sido decidido por un humano primero (la capacidad no reemplaza la
  aprobación, es una precondición adicional).

## 3. `PolicyEnvelope`

Schema Zod (`packages/agents/src/core/PolicyEnvelope.ts`, o
`packages/shared` — ver Fase G para la ubicación final elegida),
persistido en `Tenant.settings.policyEnvelope` (ADR-0007):

```typescript
interface PolicyEnvelope {
  autonomyLevel: 0 | 1 | 2 | 3 | 4 | 5;   // tope declarado por el tenant -- nunca puede superar lo que el código permite estructuralmente
  dailyEmailLimit: number;
  perDomainLimit: number;                   // máximo de emails al mismo dominio por día -- pedido explícito instrucción maestra, no existe hoy
  allowedIndustries: string[] | "ALL";
  allowedRegions: string[] | "ALL";
  approvedSenderIdentity: { name: string; email: string } | null; // hoy ya fijo (DEFAULT_EMAIL_SIGNATURE) -- el envelope lo hace configurable por tenant
  allowedSendWindows: { dayOfWeek: number; startHour: number; endHour: number; timezone: string }[];
  contactVerificationRequirement: "NONE" | "ORG_EMAIL" | "PERSON_VERIFIED" | "CONFIRMED_OR_VERIFIED"; // el último ya es, de hecho, el mínimo real que F24 exige hoy
  humanApprovalRequirement: "ALWAYS" | "HIGH_RISK_ONLY" | "NEVER"; // el sistema hoy fuerza ALWAYS a nivel de código -- el envelope no puede bajar esto por debajo de lo que el nivel de autonomía real permite
  meetingBookingPermission: boolean;        // default false
  replyAutomationPermission: boolean;       // default false
  maxLLMCost: number;                       // por misión -- nuevo, hoy solo hay tope mensual plano (auditoría §8)
  maxDiscoveryCost: number;                 // por misión
  maxEnrichmentAttempts: number;            // por Company (pedido explícito, Enrichment Agent)
  prohibitedActions: AgentCapability[];     // override explícito -- nunca vacío por accidente, default incluye SEND_EMAIL/BOOK_MEETING
}
```

Default seguro (el que aplica hoy, sin que nadie lo configure):
`autonomyLevel: 1, humanApprovalRequirement: "ALWAYS",
meetingBookingPermission: false, replyAutomationPermission: false,
prohibitedActions: ["SEND_EMAIL", "BOOK_MEETING"]`.

## 4. Safety gates (resumen — detalle en cada agente, `F25_AGENT_CATALOG.md`)

Ya reales (F24, reusados por Policy & Safety Agent sin reescribir):
`evaluateDraftCreationGate`, `evaluateApprovalQualityGate`,
`evaluateBusinessIdentityGate`, índice único parcial de dedup.

Nuevos (diseñados esta sesión, no implementados como gate operativo
todavía): `hasCapability`, verificación de `PolicyEnvelope` (volumen/
ventana/dominio), saturación de dominio a nivel Campaign Planner.

## 5. Kill switch

- **Por tenant**: `PolicyEnvelope.autonomyLevel = 0` fuerza OBSERVE
  para todo el tenant — ningún agente ejecuta escritura, sin importar
  su nivel individual declarado. Es una degradación, nunca requiere
  tocar código.
- **Por agente**: `AgentInstance.isActive = false` (columna YA
  existente, `schema.prisma` — confirmado en auditoría) ya apaga un
  agente individual hoy sin cambio de schema.
- **Global**: variable de entorno / `Tenant.settings` a nivel
  plataforma que fuerza `autonomyLevel=0` para TODOS los tenants — no
  implementada esta sesión (diseño, ver roadmap F25.5), pero el
  mecanismo (`PolicyEnvelope` leído antes de cada acción) ya lo
  soporta sin cambio adicional una vez que exista el enforcement.

## 6. Cost controls y rate limits

Ver auditoría §8 (`docs/F25_AUTONOMOUS_ORGANIZATION_MASTER_ARCHITECTURE.md`
§14). Resumen de lo nuevo que el `PolicyEnvelope` agrega sobre lo que
ya existe: `maxLLMCost`/`maxDiscoveryCost` por MISIÓN (hoy solo hay
tope mensual plano por tenant) y `maxEnrichmentAttempts` por Company
(hoy no hay ningún tope — Enrichment Agent ni siquiera existe todavía).

## 7. Restricciones de envío

`allowedSendWindows` + `perDomainLimit` + `dailyEmailLimit` son, todas,
capas ADICIONALES sobre el mecanismo de aprobación humana ya real — la
aprobación humana nunca desaparece ni se vuelve opcional por tener
estos límites más finos. Un envío que pasa `allowedSendWindows` sigue
necesitando `ApprovalRequest.status=READY_TO_SEND` decidido por un
humano (F21/F24, sin cambios).

## 8. Human Review Center — contrato de `HumanReviewRequest`

```typescript
interface HumanReviewRequest {
  id: string;
  tenantId: string;
  type: "INVALID_CLASSIFICATION" | "CONTACT_AMBIGUOUS" | "CONTENT_RISK" |
        "POLICY_EXCEPTION" | "HIGH_VALUE_OPPORTUNITY" | "NEGOTIATION_REQUIRED" |
        "UNSAFE_REPLY" | "MEETING_CONFLICT" | "LEARNING_PROPOSAL" | "SYSTEM_FAILURE";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  deadline: string | null;       // ISO 8601, null si no aplica
  entityType: string;
  entityId: string;
  summary: string;               // 1-2 frases, generado por Human Escalation Agent
  evidence: Record<string, unknown>[]; // citas/datos concretos, nunca "confía en mí"
  requestedDecision: string;     // qué decisión concreta se pide
  options: { label: string; consequence: string }[];
  recommendation: string | null; // sugerencia del sistema, nunca vinculante
  impact: string;                // qué pasa si no se decide a tiempo
  correlationId: string;         // para reconstruir el caso completo
  createdAt: string;
  resolvedAt: string | null;
  resolvedById: string | null;
  resolution: string | null;
}
```

Dedup obligatorio (Human Escalation Agent, §23 catálogo): nunca dos
`HumanReviewRequest` abiertos para el mismo `(entityType, entityId,
type)` simultáneamente — el segundo caso se fusiona en el primero
(agrega evidencia, no crea fila nueva).

## 9. Camino de escalamiento de autonomía (futuro, no decidido en esta sesión)

Subir el sistema completo de LEVEL 1 a LEVEL 2 (ejecutar tareas
internas sin aprobación por tarea, manteniendo aprobación en la
frontera externa) es una decisión de negocio, no técnica — requiere:
volumen de validación humana suficiente (más de las 17 aprobaciones
reales que existen hoy en producción), tasa de error de Quality Gate
medida y aceptable, y aprobación explícita del PO. Esta sesión no
recomienda una fecha — el roadmap (F25.20, CEO Agent) es la última
fase, deliberadamente, porque es la que más se beneficia de tener datos
reales de las 19 fases anteriores antes de proponer subir el nivel.
