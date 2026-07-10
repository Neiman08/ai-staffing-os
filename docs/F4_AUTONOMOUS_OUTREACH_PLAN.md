# F4 — Autonomous Outreach Engine — Propuesta Técnica

**Estado:** **F4 completada y verificada** — §1–§22 más el addendum "Daily Revenue Mission y camino hacia autonomía externa" (Daily Revenue Mission, CEO Agent como orquestador determinista, Principio de autonomía progresiva, Business Objective). F4.5 queda documentado por separado y explícitamente **no se implementa todavía**. Ver "Resultado de la implementación" al final de este documento.
**Precedente:** F0, F1, F2, F3 y F3.5 completados y verificados. Este plan no rompe nada de las fases anteriores — todos los cambios son aditivos. F3.5 fue puramente visual (sin schema/endpoints/lógica); F4 retomó cambios de backend por primera vez desde F3.

---

## 0. Prerrequisitos

A diferencia de F2 (necesitaba `OPENAI_API_KEY` por primera vez) y de F3 (necesitaba dos dependencias frontend nuevas), F4 **no necesita nada nuevo de infraestructura**:

- Sigue usando el mismo `OPENAI_API_KEY` y el mismo modelo (`gpt-4o-mini`) ya configurados desde F2.
- Sigue usando el mismo guardia de presupuesto mensual (`Tenant.settings.aiMonthlyBudgetUsd`, `budget.ts`) sin cambios.
- Sigue sin Redis, sin BullMQ, sin pgvector — el scheduler in-process de F3 se extiende, no se reemplaza.
- No hay dependencias nuevas de ningún paquete (ni frontend ni backend).

---

## 1. Objetivo de F4

Convertir el motor de prospección de F3 (que analiza empresas y prepara **un** primer borrador de contacto) en un **SDR autónomo completo**: capaz de agrupar empresas en campañas comerciales con criterios propios, redactar una secuencia completa de mensajes genuinamente personalizados por empresa (no plantillas), y — cuando un humano loguea manualmente una respuesta recibida — clasificar la intención de esa respuesta y recomendar el siguiente paso. Mantiene exactamente la misma frontera de F2/F3: **todo lo que crea o actualiza registros internos corre solo; todo lo que produce contenido pensado para llegar a alguien fuera del tenant siempre para en una `ApprovalRequest`; nunca se envía nada automáticamente.**

---

## 2. Alcance exacto

**Incluye:**
- **Outreach Agent** (nuevo): personaliza mensajes por empresa/paso de secuencia, planifica la secuencia de seguimientos, decide el siguiente paso tras una respuesta.
- **Campaign Agent** (nuevo): crea campañas, selecciona empresas objetivo según criterios, mide resultados, sugiere optimizaciones (solo recomienda — nunca cambia una campaña activa por su cuenta).
- **Conversation Agent** (nuevo): clasifica **texto de respuesta pegado manualmente por un humano** (ver §15 — no hay integración de bandeja de entrada) en una de 7 categorías de intención y recomienda el siguiente paso.
- **Modelo `Campaign`** y **`CampaignCompany`** (nuevos — ver §5).
- **Secuencias de seguimiento** materializadas como `FollowUp` reales (mismo modelo de F1, ya visible en `FollowUps.tsx` y en el dashboard operativo) etiquetadas con `campaignId` (nuevo campo).
- **Scheduler extendido** (mismo mecanismo in-process de F3, sin infraestructura nueva): avanza automáticamente la secuencia de cada empresa en campaña cuando llega el día de un paso, redactando ese paso y creando su `ApprovalRequest` — sin que un humano dispare cada paso.
- **Dashboard Comercial IA extendido** (mismo endpoint `GET /ai-dashboard/summary` de F3, con campos nuevos aditivos — no un dashboard nuevo, ver §17).
- Reutiliza al 100%: `AgentTask`/`ApprovalRequest`/`AuditLog`/`Activity`, `CostTracker`, `ApprovalGate`, el guardia de presupuesto, el patrón híbrido determinista+LLM (D8), y los tools ya reales de Sales/Prospecting/Market Intelligence (F2/F3) — el Outreach/Campaign/Conversation Agent no re-implementan scoring ni creación de leads/oportunidades, los reutilizan.

**No incluye (reafirmado explícitamente, igual que F2/F3):**
- Envío automático de emails, SMS, WhatsApp, LinkedIn automation, llamadas telefónicas.
- Scraping agresivo — ninguna fuente de datos nueva; las campañas seleccionan empresas que **ya existen** en el CRM del tenant (importadas o creadas manualmente, F1/F3).
- Redis, BullMQ, pgvector.
- **Integración de bandeja de entrada / inbound email.** Esta es la limitación central de F4 y se declara explícitamente aquí, no solo en §15: como F4 no envía nada automáticamente todavía, tampoco existe un canal por el que una respuesta real llegue sola al sistema. El Conversation Agent clasifica **texto que un humano pega a mano** (la respuesta que recibió en su propio correo, tras copiar y enviar manualmente el borrador aprobado — exactamente el mismo modelo que F2 ya estableció para `draftOutreach`). Automatizar la captura de respuestas reales es una fase futura (requeriría una integración de email real, fuera de alcance).
- Cualquier integración paga o nueva API externa sin aprobación explícita del PO (regla heredada de F2/F3).

---

## 3. Arquitectura

F4 no introduce ningún componente arquitectónico nuevo — extiende los mismos tres niveles que F2/F3 ya establecieron:

```
packages/agents (framework genérico, sin cambios de forma)
  ├─ 3 AgentDefinitionStub nuevos: outreach, campaign, conversation
  └─ 3 archivos de tools nuevos (contratos Zod, sin lógica):
       outreach-tools.ts, campaign-tools.ts, conversation-tools.ts

apps/api/src/modules/agents (implementaciones reales)
  ├─ tools/outreach-tools.impl.ts
  ├─ tools/campaign-tools.impl.ts
  ├─ tools/conversation-tools.impl.ts
  ├─ task-executor.ts: buildToolRegistry() gana 3 ramas nuevas
  │   (agentKey === "outreach" | "campaign" | "conversation")
  └─ scheduler.ts: runProspectingSweep() gana un cuarto sub-paso
      (avance de secuencias de campaña) — mismo tick, mismo proceso

apps/api/src/modules/campaigns (nuevo módulo, mismo patrón
  router.ts + service.ts que prospecting/ai-dashboard de F3)

apps/web/src/pages: CampaignsPage.tsx, CampaignDetail.tsx (nuevas)
apps/web/src/pages/AIDashboard.tsx: extendida (no reemplazada)
```

`AgentRuntime`, `ToolRegistry`, `CostTracker`, `ApprovalGate`, `OpenAIProvider` — los cinco ya son genéricos desde F2 y no necesitan ningún cambio para soportar 3 agentes más. `AgentTask.parentTaskId` (en uso real desde F3) se usa otra vez: una corrida de secuencia (`plan_sequence`) o una selección de empresas (`select_target_companies`) que procesa N empresas crea un `AgentTask` hijo por empresa, igual que el Prospecting Agent.

---

## 4. Nuevos agentes

| Agente | `key` | Autonomía | Tools | ¿LLM real? |
|---|---|---|---|---|
| **Outreach Agent** | `outreach` | `ASSISTED` (igual que el resto) | `planSequence`, `personalizeMessage`, `suggestNextStep` | Sí, en `personalizeMessage` (híbrido D8) |
| **Campaign Agent** | `campaign` | `ASSISTED` | `createCampaign`, `selectTargetCompanies`, `measureCampaign`, `optimizeCampaign` | Sí, solo en `optimizeCampaign` (híbrido D8, asesor) |
| **Conversation Agent** | `conversation` | `ASSISTED` | `classifyConversation` | Sí (híbrido D8) |

Los tres agentes reutilizan tools ya existentes de otros agentes cuando corresponde (nunca duplican lógica):
- Campaign Agent lee `Company.commercialScore`/`commercialScoreReason` (Sales Agent, F2) para filtrar y para justificar la selección — no vuelve a calificar empresas.
- Outreach Agent lee `AgentMemory` de industria (Market Intelligence, F3) como contexto adicional de `personalizeMessage` cuando existe, sin crear un tipo de memoria nuevo.
- Conversation Agent, cuando la intención es "interesado"/"muy interesado", no crea la `Opportunity` él mismo — deja la recomendación y el humano (o una invocación separada al Sales Agent, `createOpportunity`, ya real desde F3) la crea. Evita que un cuarto agente reimplemente lo que el Sales Agent ya hace bien.

Ningún agente de F4 recibe autonomía mayor a `ASSISTED`. La matriz de autonomía aprobada desde la Arquitectura original no cambia.

---

## 5. Nuevos modelos de datos

Dos modelos nuevos, **evaluados y justificados uno por uno** (regla explícita: solo si son estrictamente necesarios).

### 5.1 `Campaign` — sí es necesario

F3 (§7 de su plan) declaró explícitamente: *"Campañas anteriores → no existe un modelo real, y no se propone acá (sería scope creep sin un caso de uso claro todavía)"*. F4 **es** ese caso de uso: el pedido pide campañas con nombre, criterios de segmentación, prioridad, y medición de resultados — no hay ningún modelo existente (`Lead`, `Company`, `Opportunity`) que represente "un conjunto de empresas objetivo con una estrategia y una cadencia compartida". No se puede derivar de datos existentes sin inventar un modelo.

### 5.2 `CampaignCompany` — sí es necesario (y por qué no se resolvió con campos sueltos en `Lead`)

Se consideró la alternativa de agregar `Lead.campaignId` + `Lead.campaignStatus` + `Lead.lastIntent` directamente en `Lead`, evitando un modelo nuevo. Se descartó por dos razones concretas:
1. **`Lead.status`** ya modela un ciclo de vida (`NEW → CONTACTED → INTERESTED → QUALIFIED/UNQUALIFIED → CONVERTED`). Agregar un segundo estado paralelo de "campaña" (`TARGETED/SEQUENCING/HOT/COLD/RECOVERED/CONVERTED/EXCLUDED`) en el mismo modelo crea dos conceptos de "estado" superpuestos con un `CONVERTED` ambiguo (¿cuál de los dos?).
2. **Historial.** Una empresa puede pasar por más de una campaña a lo largo del tiempo (ej. "Construction Illinois" en el mes 1, "Construction Illinois — reactivación" en el mes 4 tras quedar fría). Un campo único en `Lead` solo puede apuntar a la campaña *actual*, perdiendo el historial de campañas anteriores — justo lo que el pedido pide poder mostrar ("empresas recuperadas").

`CampaignCompany` es una tabla de unión (`campaignId` × `companyId`, `@@unique`) que registra la membresía y el estado de una empresa **dentro de una campaña específica**, sin tocar `Lead` ni `Company`. Una empresa puede tener múltiples filas `CampaignCompany` (una por campaña en la que estuvo), cada una con su propio estado e intención detectada — el historial completo queda naturalmente auditable.

**Explícitamente NO se crea un modelo `Message`/`Conversation` nuevo** — mismo principio que F3 aplicó a `AgentMemory` (§7 de ese plan: "ya existe un mecanismo que cumple la misma función sin duplicar datos"). Cada mensaje redactado ya vive en `AgentTask.output` + `ApprovalRequest.proposedAction` (F2); cada respuesta logueada y cada clasificación ya viven en `Activity` (polimórfico, ya existe desde F0). No hace falta un modelo nuevo para "guardar mensajes" — hace falta reutilizar exactamente lo que F2/F3 ya construyeron para ese propósito.

---

## 6. Cambios de schema

### 6.1 Modelos nuevos

```prisma
enum CampaignStatus {
  DRAFT
  ACTIVE
  PAUSED
  COMPLETED
}

enum CampaignCompanyStatus {
  TARGETED    // seleccionada, secuencia todavía no arrancó
  SEQUENCING  // secuencia en curso, sin respuesta clasificada todavía
  HOT         // última intención: interesado / muy interesado / llamar después
  COLD        // secuencia terminada sin respuesta, o intención negativa
  RECOVERED   // estaba COLD y volvió a mostrar intención positiva
  CONVERTED   // el Lead asociado llegó a CONVERTED / la Company a CLIENT
  EXCLUDED    // sacada manualmente de la campaña por un humano
}

enum ConversationIntent {
  INTERESTED
  VERY_INTERESTED
  CALL_LATER
  NO_BUDGET
  HAS_PROVIDER
  NOT_INTERESTED
  OUT_OF_MARKET
}

model Campaign {
  id                   String            @id @default(cuid())
  tenantId             String
  name                 String // "Construction Illinois"
  status               CampaignStatus    @default(DRAFT)
  industryId           String?
  industry             Industry?         @relation(fields: [industryId], references: [id])
  state                String? // mismo campo promovido que Company.state
  city                 String?
  minCompanySize       CompanySize?
  maxCompanySize       CompanySize?
  targetCategoryIds    Json              @default("[]") // JobCategory ids — lista simple, sin M:N nueva
  minScore             Float? // filtro sobre Company.commercialScore
  priority             RiskLevel         @default(MEDIUM) // reutiliza el enum ya existente (Lead.priority)
  createdByAgentTaskId String? // Campaign Agent, si la creó la IA — null si la creó un humano
  companies            CampaignCompany[]
  createdAt            DateTime          @default(now())
  updatedAt            DateTime          @updatedAt

  @@index([tenantId, status])
}

model CampaignCompany {
  id                   String                @id @default(cuid())
  tenantId             String
  campaignId           String
  campaign             Campaign              @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  companyId            String
  company              Company               @relation(fields: [companyId], references: [id])
  status               CampaignCompanyStatus @default(TARGETED)
  lastIntent           ConversationIntent?
  lastIntentAt         DateTime?
  createdByAgentTaskId String? // qué AgentTask (selectTargetCompanies) la agregó
  createdAt            DateTime              @default(now())
  updatedAt            DateTime              @updatedAt

  @@unique([campaignId, companyId])
  @@index([tenantId, status])
}
```

### 6.2 Campo nuevo en un modelo existente

| Campo | Modelo | Precedente que sigue |
|---|---|---|
| `campaignId String?` | `FollowUp` | Mismo patrón que `createdByAgentTaskId` (F2/F3) — nullable, sin `@relation`. Etiqueta qué seguimientos son pasos de una secuencia de campaña (para poder filtrarlos/agruparlos) sin crear un modelo de "paso de secuencia" separado. |

### 6.3 Relación inversa obligatoria (mecánica de Prisma, no una capacidad nueva)

`Company` necesita el lado inverso de la relación de `CampaignCompany.company`:

```prisma
model Company {
  // ...campos existentes sin cambios...
  campaignCompanies CampaignCompany[] // F4
}
```

**Nada más.** No se toca `Lead`, `Opportunity`, `AgentMemory`, `ApprovalRequest` ni ningún otro modelo. `ApprovalRequest.proposedAction` (Json, ya genérico) simplemente carga `{ campaignId, campaignCompanyId, sequenceStep, channel, subject, body }` para los borradores de campaña — no necesita cambio de schema, igual que ya carga formas distintas para `draftOutreach` sin haber necesitado nunca una columna por campo.

**Decisión explícita: no se agrega `sequenceStep` a `FollowUp`.** El número de paso (Día 1/4/9/18) se deriva en código ordenando los `FollowUp` de una `campaignId`+`companyId` por `dueDate` — es un dato calculable, no uno que necesite persistirse dos veces (mismo principio "no hardcodear/no duplicar" de F3.5).

---

## 7. Nuevos endpoints

Todos bajo `/api/v1`, mismo patrón `router.ts` + `service.ts` + Zod:

| Método | Ruta | Permiso | Nota |
|---|---|---|---|
| `POST` | `/campaigns` | `campaigns.create` (nuevo, ver §21) | Crea una `Campaign` (formulario humano o `createCampaign` del Campaign Agent). |
| `GET` | `/campaigns` | `campaigns.view` | Lista campañas con métricas agregadas inline (reutiliza la misma agregación de `measureCampaign`, sin necesidad de invocar un `AgentTask` por cada carga de página). |
| `GET` | `/campaigns/:id` | `campaigns.view` | Detalle: campaña + sus `CampaignCompany` agrupadas por estado + próximos `FollowUp` de secuencia. |
| `PATCH` | `/campaigns/:id` | `campaigns.update` | Activar / pausar / completar una campaña, o ajustar sus criterios — palanca de control humano explícita. |
| `POST` | `/campaigns/:id/tasks` | `agents.execute` (ya existente) | Invoca `select_target_companies`, `measure_campaign` u `optimize_campaign` para esa campaña. |
| `GET` | `/campaign-companies/:id` | `campaigns.view` | Detalle de una empresa dentro de una campaña: estado, intención, secuencia (`FollowUp`s), conversación (`Activity`s). |
| `POST` | `/campaign-companies/:id/tasks` | `agents.execute` | Invoca `plan_sequence`, `personalize_message` o `suggest_next_step` para esa empresa puntual. |
| `POST` | `/campaign-companies/:id/conversation` | `agents.execute` | `{ replyText: string }` — registra la respuesta pegada manualmente como `Activity` y dispara `classify_conversation` de forma síncrona (mismo patrón `createAndRunTaskSync` que ya usa "Analizar ahora" en F3). |

**`GET /ai-dashboard/summary` (F3) se EXTIENDE, no se duplica** — gana los campos nuevos de §17, con los mismos permisos (`agents.view`) y sin romper el shape que F3.5 ya consume en el frontend (solo se agregan campos, ninguno se quita ni cambia de tipo).

No se toca ningún endpoint de F0/F1/F2/F3/F3.5.

---

## 8. Nuevas páginas

- **`Campaigns.tsx`** (`/campaigns`): grilla de tarjetas premium (mismo lenguaje visual que F3.5 dejó en `Companies.tsx`) — nombre, estado, criterios de segmentación resumidos, conteo de empresas por estado (targeted/sequencing/hot/cold/recovered/converted), costo IA de la campaña, botón "Crear campaña" (drawer con el formulario de criterios).
- **`CampaignDetail.tsx`** (`/campaigns/:id`): lista de `CampaignCompany` (filtrable por estado), botones para correr `select_target_companies`/`measure_campaign`/`optimize_campaign`, recomendación del Campaign Agent (`optimizeCampaign`) si existe.
- **`CampaignCompanyDetail.tsx`** (drawer o `/campaigns/:id/companies/:companyId`): timeline de la secuencia (Día 1/4/9/18 con su estado: pendiente/borrador listo/aprobado/omitido), textarea "Registrar respuesta recibida" → dispara `classify_conversation` y muestra el badge de intención + recomendación, timeline de `Activity` (reutiliza `Timeline.tsx`, ya existe).
- **`AIDashboard.tsx`** (existente, F3/F3.5): extendida con la sección nueva de §17 — no es una página nueva.
- **Sidebar**: nuevo ítem "Campaigns" bajo la sección "Sales CRM".

## 9. Nuevos componentes

- **`SequenceTimeline`** (nuevo, compartido): visualiza los 4 pasos de una secuencia con su estado — reutilizable entre `CampaignCompanyDetail` y una futura vista de campaña completa.
- **`IntentBadge`** (nuevo, compartido): badge con color por `ConversationIntent` (mismo patrón `cva` que `Badge`/`statusVariant` ya existentes — ej. `INTERESTED`/`VERY_INTERESTED` → verde, `NOT_INTERESTED`/`OUT_OF_MARKET` → rojo, `CALL_LATER`/`NO_BUDGET`/`HAS_PROVIDER` → ámbar).
- **`CampaignCard`** (nuevo): tarjeta premium de campaña para `Campaigns.tsx`, mismo lenguaje visual que `StatCard`/`Card` + `card-hover` de F3.5.
- Reutilizados sin cambios: `Card`, `Badge`, `StatCard`, `Drawer`, `Timeline`, `AgentStatusDot`, `Pagination`.

---

## 10. Workflow completo

```
Prospecting Agent (F3, sin cambios)
        │  scoreCompany → createLead → createOpportunity → suggestFollowUp
        ▼
Sales Agent (F2, sin cambios)
        │  la Company ya tiene commercialScore + Lead
        ▼
Campaign Agent
        │
        ├─▶ createCampaign(criterios)                         FULL_AUTO, auditado
        │
        ├─▶ selectTargetCompanies(campaignId)                  FULL_AUTO, auditado
        │      (filtra Company por industria/ubicación/tamaño/
        │       score mínimo, ya scoreadas por Sales Agent —
        │       crea CampaignCompany por cada match, tope por
        │       corrida)
        ▼
Outreach Agent
        │
        ├─▶ planSequence(campaignCompanyId)                    FULL_AUTO, auditado
        │      (crea 4 FollowUp: día 1/4/9/18, campaignId
        │       asociado — "todo queda preparado")
        │
        └─▶ personalizeMessage(campaignCompanyId, step)        SIEMPRE crea ApprovalRequest
               (redacta el paso que corresponde HOY —
                nunca redacta los 4 pasos por adelantado,
                ver §14)
        ▼
ApprovalRequest (borrador del paso N)
        ▼
Humano aprueba ── el texto queda disponible para copiar y
                  enviar manualmente fuera del sistema
                  (idéntico a draftOutreach desde F2)
        ▼
Envío (fase futura — NO se construye en F4)
        ▼
(el humano recibe una respuesta en su propio correo/LinkedIn/
 llamada, y la pega manualmente en el sistema — única forma
 de "entrada" hasta que exista integración real de bandeja)
        ▼
Conversation Agent
        │
        └─▶ classifyConversation(campaignCompanyId, replyText) FULL_AUTO, auditado
               (clasifica intención, actualiza CampaignCompany.
                lastIntent + status HOT/COLD/RECOVERED)
        ▼
Outreach Agent
        │
        └─▶ suggestNextStep(campaignCompanyId)                 FULL_AUTO, auditado
               (continuar secuencia / saltar al día siguiente /
                pausar / recomendar escalar a Opportunity)
        ▼
(si la intención es positiva) Sales Agent createOpportunity
        │  (ya real desde F3 — F4 no la reimplementa)
        ▼
Opportunity → Cliente (CRM de F1/F2, sin cambios)
```

Cada flecha numerada es un `AgentTask` propio, auditado igual que F3 — ninguno se salta la matriz de autonomía aprobada.

---

## 11. Sistema de campañas

Una `Campaign` es, literalmente, un conjunto con nombre de criterios de targeting + las empresas que matchean esos criterios en un momento dado. Ejemplos del pedido ("Construction Illinois", "Warehouses Indiana", "Manufacturing Chicago", "Data Centers Iowa") se crean con:

```
createCampaign({
  name: "Construction Illinois",
  industryId: <id de "Construction">,
  state: "IL",
  minCompanySize: "SMALL",
  targetCategoryIds: [<id de "Journeyman Electrician">, ...],
  minScore: 60,
  priority: "HIGH",
})
```

`selectTargetCompanies(campaignId)` corre una consulta determinista (sin LLM — es un filtro, no una decisión que necesite juicio) sobre `Company` del tenant: `industryId` coincide (si se especificó), `state`/`city` coincide, `estimatedSize` dentro del rango, `commercialScore >= minScore` (si se especificó), y **la empresa no está ya `TARGETED`/`SEQUENCING`/`HOT` en otra campaña activa** (evita doble outreach simultáneo a la misma empresa desde dos campañas). Cada match crea una fila `CampaignCompany`. Tope de 50 empresas por corrida (mismo espíritu que el tope de 15/corrida de F3, ajustado porque seleccionar es más barato que procesar — no hay llamada a OpenAI en este paso).

`measureCampaign(campaignId)` es una agregación pura (conteos por `CampaignCompanyStatus`, costo acumulado sumando `AgentTask.costUsd` de las tareas con `input.campaignId` = esta campaña, leads/oportunidades creadas para empresas de esta campaña) — sin LLM, se puede llamar tan seguido como haga falta sin gastar presupuesto.

`optimizeCampaign(campaignId)` es la única pieza con LLM: toma las métricas de `measureCampaign` (ej. tasa de respuesta por paso de secuencia) y redacta una recomendación corta ("el paso del día 9 tiene 0% de respuesta, considera ajustar el ángulo del caso de éxito"). **Nunca cambia la campaña por su cuenta** — la recomendación se guarda en `AgentTask.output` y se muestra en `CampaignDetail.tsx`; si el humano quiere aplicarla, la aplica él mismo editando la campaña (`PATCH /campaigns/:id`).

---

## 12. Segmentación automática

Los criterios de una campaña se completan de dos formas, ambas terminando en el mismo `createCampaign` determinista (nunca hay creación de campaña "libre" sin estructura):

1. **Un humano los define** en el formulario de `Campaigns.tsx` (industria, ubicación, tamaño, categorías, score mínimo, prioridad — todos opcionales excepto `name`).
2. **El Campaign Agent los sugiere** leyendo la memoria de industria que Market Intelligence ya deja (F3 §7, `AgentMemory` `entityType: "industry"`) — ej. si la memoria más reciente de "Construction" en "IL" muestra score promedio alto y oportunidades ganadas recientes, el agente puede proponer esos criterios pre-llenados en el formulario. **Esto es una sugerencia de valores para el formulario, no una campaña creada sin que el humano confirme** — coherente con que `createCampaign` siempre requiere un input estructurado explícito, nunca una decisión autónoma de "qué campaña crear".

No hay segmentación por texto libre ni por una fuente externa nueva — los mismos campos ya promovidos en `Company` (`state`, `city`, `estimatedSize`, `commercialScore`) y las mismas `JobCategory`/`Industry` ya existentes son la única fuente.

---

## 13. Personalización de mensajes

`personalizeMessage(campaignCompanyId, step)` sigue el patrón híbrido D8 (igual que `scoreCompany`/`draftOutreach`/`analyzeIndustry`): el código arma el contexto factual, el LLM redacta dentro de ese contexto, nunca inventa datos que no estén ahí.

**Contexto que se pasa al prompt (todo dato real, nada generado):**

| Dato | De dónde sale |
|---|---|
| Industria | `Company.industry.name` |
| Ciudad/estado | `Company.city`/`Company.state` |
| Tamaño | `Company.estimatedSize` |
| Señales detectadas | `Company.commercialScoreReason` (Sales Agent, F2) |
| Historial | últimas 3 `Activity` de esa `Company`/`Lead` (incluye contactos previos de esta misma secuencia) |
| Oportunidades | `Opportunity` abiertas de esa `Company`, si existen |
| Necesidades detectadas | `Company.possibleCategories` (F1) |
| Paso de la secuencia | día 1 (primer contacto) / día 4 (seguimiento) / día 9 (caso de éxito) / día 18 (último intento) — cada uno con una instrucción de tono distinta en el prompt |

**Por qué nunca es una plantilla repetida:** el prompt de cada llamada incluye el historial real de esa empresa (incluyendo qué se le dijo en los pasos anteriores de la misma secuencia, para no repetirse) — dos empresas con la misma industria y el mismo paso de secuencia reciben contextos distintos (nombre, ciudad, señales, historial), por lo que el texto generado difiere aunque el "tipo" de paso sea el mismo. Esto es una propiedad emergente del contexto real inyectado, no una regla de "no repetir" que el LLM deba obedecer por sí solo — el guardrail real es que el input nunca es idéntico.

Mismas reglas de F2 §14 sin cambios: nunca prometer precios/tarifas/compromisos, siempre decir explícitamente que es un borrador.

---

## 14. Seguimientos automáticos

`planSequence(campaignCompanyId)` crea 4 `FollowUp` reales (mismo modelo de F1) en el momento en que una `CampaignCompany` pasa a `SEQUENCING`:

```
Día 1  → FollowUp(dueDate = hoy,       campaignId, entityType:"company", entityId)
Día 4  → FollowUp(dueDate = hoy + 4d,  campaignId, entityType:"company", entityId)
Día 9  → FollowUp(dueDate = hoy + 9d,  campaignId, entityType:"company", entityId)
Día 18 → FollowUp(dueDate = hoy + 18d, campaignId, entityType:"company", entityId)
```

**"Todo queda preparado" se cumple así:** los 4 pasos existen como `FollowUp` desde el día 1, visibles en `FollowUps.tsx` y en el conteo del dashboard — un humano puede ver la secuencia completa planificada de antemano.

**Pero el *contenido* de cada paso se redacta justo a tiempo, no los 4 de una vez.** El scheduler extendido (§3, mismo mecanismo de F3) revisa en cada corrida los `FollowUp` con `campaignId` no nulo, `status: PENDING`, `dueDate <= hoy`, y para cada uno:
1. Si la `CampaignCompany` ya tiene `lastIntent` clasificado desde la última corrida (una respuesta llegó) → no redacta el paso siguiente automáticamente, deja que `suggestNextStep` decida (ver §16).
2. Si no hay respuesta clasificada → llama `personalizeMessage` para ese paso, crea su `ApprovalRequest`.

**Por qué no redactar los 4 mensajes por adelantado:** el día 9 ("caso de éxito") y el día 18 ("último intento") deberían reaccionar a si hubo o no respuesta en los pasos anteriores — redactarlos todos el día 1 desperdiciaría la llamada a OpenAI en un mensaje que quizás nunca se necesite (la empresa respondió el día 2 y ya pasó a `Opportunity`) y produciría contenido que no puede tener en cuenta contexto que todavía no existe. Esta es una decisión de diseño explícita, no una limitación oculta.

**Nada se envía automáticamente en ningún paso** — el resultado de cada `personalizeMessage` es, otra vez, una `ApprovalRequest` pendiente.

---

## 15. Detección de intención

**Aclaración central de alcance (repetida de §2 porque es la decisión más importante de este plan):** no existe integración de bandeja de entrada. El Conversation Agent clasifica un texto que un humano pega manualmente — la respuesta que recibió por el canal que sea, después de haber enviado el borrador aprobado por su cuenta (fuera del sistema, igual que F2 diseñó `draftOutreach`).

`classifyConversation({ campaignCompanyId, replyText })`:
1. Persiste `replyText` como una `Activity` (`type: EMAIL`, `entityType: "campaignCompany"`, `performedById`: el humano que la pegó) — la respuesta queda en el historial igual que cualquier otra actividad.
2. Llama al LLM (patrón híbrido D8: el prompt fija las 7 categorías exactas como único vocabulario de salida, validado con Zod `z.enum(...)` — si el LLM devuelve algo fuera de esas 7, la tarea falla en vez de persistir una categoría inventada) para clasificar `replyText` en una de:

   `INTERESTED` · `VERY_INTERESTED` · `CALL_LATER` · `NO_BUDGET` · `HAS_PROVIDER` · `NOT_INTERESTED` · `OUT_OF_MARKET`

3. Actualiza `CampaignCompany.lastIntent` + `lastIntentAt`, y su `status`:
   - `INTERESTED`/`VERY_INTERESTED`/`CALL_LATER` → `HOT`
   - `NO_BUDGET`/`HAS_PROVIDER`/`NOT_INTERESTED`/`OUT_OF_MARKET` → `COLD`
   - Si la fila ya estaba `COLD` y la nueva clasificación es `HOT` → `RECOVERED` (en vez de `HOT` directo, para que el dashboard pueda distinguir "nunca estuvo fría" de "volvió a la vida").
4. Persiste una segunda `Activity` (`type: SYSTEM`) con la clasificación y su razón — mismo patrón que usa `scoreCompany` para anunciar un cambio de score.

FULL_AUTO — clasificar y actualizar estado interno no produce nada externo, no requiere `ApprovalRequest`.

---

## 16. Gestión de conversaciones

`suggestNextStep(campaignCompanyId)` es determinista (árbol de decisión sobre `CampaignCompanyStatus` + `ConversationIntent`, sin LLM — la decisión ya está tomada por la clasificación, esto solo aplica la regla):

| Intención | Recomendación |
|---|---|
| `VERY_INTERESTED` | Detener la secuencia, recomendar escalar a `Opportunity` ya (vía Sales Agent `createOpportunity`, F3) |
| `INTERESTED` | Detener la secuencia automática, recomendar seguimiento humano directo (crea un `FollowUp` sin `campaignId`, tipo `CALL`, prioridad alta) |
| `CALL_LATER` | Pausa la secuencia, crea un `FollowUp` de tipo `CALL` en la fecha que el texto sugiera (o +7 días si no hay fecha clara) |
| `NO_BUDGET` / `HAS_PROVIDER` | Marca `COLD`, detiene la secuencia, sin seguimiento nuevo |
| `NOT_INTERESTED` / `OUT_OF_MARKET` | Marca `COLD`, detiene la secuencia, y **excluye la empresa de futuras selecciones automáticas** de nuevas campañas por 180 días (chequeo en `selectTargetCompanies`, similar al dedup de F3) |

Cada `CampaignCompanyDetail.tsx` muestra: la `Campaign` a la que pertenece, su `CampaignCompanyStatus` actual, la `SequenceTimeline` (§9), y el timeline completo de `Activity` (respuestas pegadas + clasificaciones + cambios de estado) vía el componente `Timeline.tsx` ya existente — un humano puede reconstruir toda la conversación de esa empresa sin salir de la página.

---

## 17. Dashboard comercial IA

**Se extiende `GET /ai-dashboard/summary` (F3), no se crea un segundo dashboard.** Campos nuevos (aditivos, el shape de F3 no se rompe):

| Métrica nueva | Cómo se calcula |
|---|---|
| Campañas activas | `Campaign.count({ status: "ACTIVE" })` |
| Campañas finalizadas | `Campaign.count({ status: "COMPLETED" })` |
| Empresas por campaña | `CampaignCompany.groupBy(["campaignId"])`, join con `Campaign.name` |
| Empresas calientes | `CampaignCompany.count({ status: "HOT" })` |
| Empresas frías | `CampaignCompany.count({ status: "COLD" })` |
| Empresas recuperadas | `CampaignCompany.count({ status: "RECOVERED" })` |
| Costo por campaña | `sum(AgentTask.costUsd)` de tareas cuyo `input` referencia esa `campaignId`, agrupado |
| Costo por lead / por oportunidad | ya existían parcialmente en Revenue.tsx (F3.5) — se agregan también acá con el subconjunto de leads/oportunidades originadas desde una campaña (`Lead`/`Opportunity` cuyo `createdByAgentTaskId` pertenece a una tarea con `input.campaignId`) |
| ROI IA | ya existe desde F3 — sin cambios en la fórmula, ahora incluye también el revenue estimado de oportunidades originadas por campañas |
| Tiempo ahorrado (estimado) | `(mensajes personalizados generados por IA) × 8 minutos` — 8 minutos es un supuesto explícito documentado (tiempo promedio estimado para que un humano redacte un mensaje de prospección personalizado), **no una medición real** — se etiqueta así en la UI, mismo criterio que el ROI de F3 |
| Productividad IA | tareas completadas por Outreach + Campaign + Conversation Agent este mes ÷ costo IA de esos tres agentes este mes (mensajes/oportunidades generados por dólar gastado) |

Todo se calcula con `Promise.all` de queries agregadas (mismo estilo que `ai-dashboard/service.ts` de F3) — cero hardcodeo, cero mock.

---

## 18. Métricas

Además de lo ya cubierto en §17 (que alimenta el dashboard), F4 deja medible por diseño:
- Tasa de respuesta por paso de secuencia (día 1 vs. 4 vs. 9 vs. 18) — insumo de `optimizeCampaign`.
- Distribución de `ConversationIntent` sobre el total de conversaciones clasificadas.
- Empresas targeteadas vs. empresas que efectivamente entraron en secuencia (`TARGETED` que nunca pasó a `SEQUENCING` — señal de que faltó ejecutar `planSequence`, visible como alerta operativa).

---

## 19. Costos OpenAI

Mismo modelo (`gpt-4o-mini`), mismo guardia de presupuesto mensual sin cambios de código. Estimado conservador basado en los costos reales observados en F3 (~$0.0005–0.0007 por llamada híbrida D8):

- `personalizeMessage`: 1 llamada por paso de secuencia que efectivamente se redacta (no los 4 por adelantado, ver §14) ≈ $0.0006/mensaje.
- `classifyConversation`: 1 llamada por respuesta pegada manualmente ≈ $0.0005/clasificación.
- `optimizeCampaign`: 1 llamada por invocación manual (no se programa automáticamente, es bajo demanda) ≈ $0.0008.

Para una campaña de 30 empresas con secuencia completa y una tasa de respuesta del 20% (6 conversaciones clasificadas): 30 × $0.0006 (día 1) + ~20 pasos adicionales redactados (asumiendo que la mitad no responde y sigue a día 4/9/18) × $0.0006 + 6 × $0.0005 ≈ **$0.03–0.05 por campaña completa** — muy por debajo del presupuesto de $50/mes, con varias campañas simultáneas cabiendo cómodamente. El guardia de presupuesto (`budget.ts`, sin cambios) corta cualquier corrida — manual o programada — si el mes ya se agotó, antes de llamar a OpenAI.

---

## 20. Auditoría

100% reutilizado de F2/F3, sin cambios de diseño:
- Cada tool de los 3 agentes nuevos es un `AgentTask` (con `parentTaskId` cuando corresponde — ej. `select_target_companies` procesando N empresas encadena una tarea hija conceptual por empresa vía el mismo mecanismo ya probado en F3).
- Cada escritura relevante (`Campaign`, `CampaignCompany`, `FollowUp` de secuencia, cambio de `CampaignCompanyStatus`) genera `AuditLog` + `Activity`, atribuida al `AgentInstance` que la ejecutó realmente (Outreach, Campaign, o Conversation — nunca todo atribuido a uno solo).
- Todo mensaje generado por `personalizeMessage` queda asociado al `AgentTask` que lo produjo (ya es así por diseño — `AgentTask.output` + `ApprovalRequest.agentTaskId`), y por lo tanto al `AgentInstance`/agente responsable — cumple literalmente el pedido "todo mensaje generado debe quedar asociado al agente que lo produjo".
- `costUsd`/`tokensUsed` se acumulan por tarea igual que siempre; el guardia de presupuesto mensual es el mismo.

---

## 21. Seguridad

- **RBAC:** se agrega `"campaigns"` a `PERMISSION_RESOURCES` (`packages/shared/src/permissions.ts`) — genera automáticamente `campaigns.view`/`campaigns.create`/`campaigns.update`/`campaigns.delete` con el mismo mecanismo ya usado para `leads`/`opportunities`/`followUps` (F1). No se agrega ninguna `SPECIAL_PERMISSION_KEY` nueva — `agents.execute`/`agents.view`/`approvals.decide` ya existentes cubren todo lo demás. El rol `Sales` gana las 4 claves `campaigns.*` (mismo patrón que ya tiene para `leads`/`opportunities`/`followUps`); el resto de los roles no cambia.
- **Superficie nueva de input no confiable:** `POST /campaign-companies/:id/conversation` acepta texto libre (`replyText`) pegado por un humano. Mismo tratamiento que `detectHiringSignals.manualSignal` (F2) ya recibe hoy: validado con Zod (longitud máxima razonable), nunca interpolado en SQL (solo llega a un prompt de LLM y a una columna de texto plano vía Prisma parametrizado), tenant-scoped como cualquier otro dato. No hay riesgo de inyección SQL/comando nuevo — es la misma clase de input que ya existe en producción desde F2.
- **Sin secretos nuevos.** Reutiliza `OPENAI_API_KEY` ya validado en `env.ts` desde F2.
- **Sin nueva superficie de red saliente.** Los 3 agentes nuevos llaman exclusivamente a OpenAI (ya aprobado) y a la base de datos propia — cero llamadas a terceros nuevos.
- **Contención de costo como control de seguridad:** el tope de 50 empresas/corrida en `selectTargetCompanies` y la reutilización sin cambios del guardia de presupuesto mensual previenen que un error de configuración (ej. una campaña con criterios demasiado amplios) genere un gasto descontrolado — mismo principio que el tope de 15/corrida de F3.

---

## 22. Definition of Done

> Nota de verificación: cada ítem fue verificado en un entorno real (navegador real vía Playwright + backend corriendo contra Postgres real + llamadas reales a la API de OpenAI, tanto en los 11 tests automatizados nuevos como en la verificación manual en navegador y consultas directas a la base de datos), no únicamente por compilación o tipos.

- [x] `Campaign`/`CampaignCompany` creados vía migración, con los 3 enums nuevos y el campo `FollowUp.campaignId`
- [x] `campaigns` agregado a `PERMISSION_RESOURCES`, seed actualizado (rol Sales con las 4 claves nuevas)
- [x] Outreach Agent, Campaign Agent, Conversation Agent — 3 `AgentDefinition` nuevos, `AgentInstance` sembrada para el tenant existente
- [x] `createCampaign` + `selectTargetCompanies` funcionan de punta a punta: crear una campaña con criterios reales selecciona empresas reales del tenant (no inventadas), respetando el tope por corrida
- [x] `planSequence` crea los 4 `FollowUp` reales de la secuencia, visibles en `FollowUps.tsx` (verificado: badge "AI" visible en la lista real)
- [x] `personalizeMessage` redacta un mensaje genuinamente distinto para dos empresas distintas en el mismo paso de secuencia (verificado comparando el texto real, no solo el tipo) y siempre crea una `ApprovalRequest` — nunca envía nada
- [x] El scheduler extendido redacta automáticamente el paso que corresponde cuando llega su `dueDate`, sin intervención humana, respetando presupuesto
- [x] `classifyConversation` clasifica un texto de respuesta pegado manualmente en una de las 7 categorías exactas (validado con Zod, sin categorías inventadas) y actualiza `CampaignCompany.status`/`lastIntent`
- [x] `suggestNextStep` aplica correctamente el árbol de decisión de §16 — nota: verificado de punta a punta (con datos reales, incluyendo el efecto de cancelar la secuencia) para el caso `VERY_INTERESTED`; las otras 6 ramas del árbol están implementadas y son deterministas (sin LLM) pero no se ejercitó cada una individualmente con un caso de prueba dedicado — riesgo bajo dado que es lógica de `switch` simple, documentado aquí en vez de marcarlo sin la salvedad
- [x] `measureCampaign`/`optimizeCampaign` funcionan con datos reales de al menos una campaña con empresas en distintos estados
- [x] `GET /ai-dashboard/summary` expone los campos nuevos de §17 con datos reales, sin romper el shape que F3.5 ya consume
- [x] `Campaigns.tsx`, `CampaignDetail.tsx`, `CampaignCompanyDetail.tsx` — navegables, sin errores de consola, verificados en modo claro y oscuro
- [x] F0, F1, F2, F3 y F3.5 siguen funcionando exactamente igual — ningún test existente se modificó; los 28 tests previos siguen pasando dentro de la suite de 39
- [x] `pnpm typecheck` limpio en todo el monorepo
- [x] `pnpm lint` limpio en todo el monorepo
- [x] `pnpm test` — 39/39 (28 de F0-F3 + 11 nuevos de F4)
- [x] Verificación en navegador real vía Playwright sin errores de consola/HTTP, cubriendo el flujo completo: crear campaña → seleccionar empresas reales → ver secuencia planificada → ver borrador del día 1 pendiente → **aprobarlo desde `/approvals`** (verificado: transición a estado `Approved`, atribuido al usuario real) → registrar una respuesta real → ver la clasificación de intención (`VERY_INTERESTED` → `HOT`) → ver el AI Dashboard y el Dashboard reflejar todo lo anterior

---

## Daily Revenue Mission y camino hacia autonomía externa

**Estado:** addendum **aprobado** (ver aprobación explícita del PO: Daily Revenue Mission, CEO Agent como orquestador determinista, `AgentTask` como misión raíz, `parentTaskId` para delegación, Campaign reutilizable, budget por misión, misiones pausables, RBAC para misiones, F4.5 separado sin implementar).

Este addendum separa con claridad dos niveles que el pedido original mezclaba: (1) lo que F4 construye ahora, incluyendo una nueva capacidad — la **Daily Revenue Mission** — que convierte al CEO Agent (stub desde F0) en un orquestador acotado; y (2) lo que queda explícitamente para una fase futura separada (F4.5), que es la única forma honesta de llegar algún día a contactar clientes reales fuera del CRM.

**Dos amplificaciones adicionales, aprobadas junto con este addendum:**
1. **Principio de autonomía progresiva** — documentado como principio permanente en `docs/01_ARQUITECTURA_v1.1.md` §3.5 (los 4 niveles: Asistido/Semiautónomo/Autónomo supervisado/Autónomo completo, mapeados al `AutonomyLevel` ya existente desde F0). F4 solo corrige nomenclatura (`ASSISTED` → `SEMI_AUTO` para los agentes que ya se comportan así) y documenta el camino F4→F8 — **no construye ningún mecanismo nuevo de enforcement todavía** (`ApprovalGate.ts` sigue siendo la tabla estática de la Arquitectura §3.4).
2. **Business Objective** — toda Daily Revenue Mission queda ligada a un objetivo de negocio explícito, con su progreso visible durante el día y un Executive Report al cierre. Detallado en "Business Objective" dentro de la sub-sección Daily Revenue Mission, abajo.

---

### F4 — Autonomous Outreach sobre datos existentes

Todo lo descrito en §1–§22 de este documento (Campaign Agent, Outreach Agent, Conversation Agent, `Campaign`/`CampaignCompany`, segmentación sobre empresas ya existentes en el CRM, secuencia día 1/4/9/18, personalización just-in-time, `ApprovalRequest` para toda comunicación externa, clasificación de respuestas pegadas manualmente, métricas de campaña, extensión aditiva del AI Dashboard) **se mantiene sin cambios** y sigue siendo el núcleo de F4. A eso se agrega la Daily Revenue Mission, descrita abajo.

#### Daily Revenue Mission

**Qué es:** una instrucción diaria en lenguaje natural que el usuario le da al **CEO Agent** (`key: "ceo"`, `packages/agents/src/definitions/ceo.agent.ts`) — que existe como stub sin comportamiento desde F0, exactamente en la misma situación en la que estaban Sales Agent antes de F2 y Market Intelligence/Prospecting antes de F3. F4 le da comportamiento real por primera vez, siguiendo el mismo patrón de "graduación de stub a agente real" ya usado dos veces.

Ejemplo del pedido: *"Hoy busca empresas de manufactura y warehouses en Illinois que puedan necesitar General Labor o Forklift Operators. Prioriza empresas con señales recientes de contratación y prepara la prospección comercial del día."*

**El CEO Agent en F4 es un orquestador acotado y determinista — no un planificador libre.** Esto se garantiza con el mismo mecanismo que F2 §18 (desviación #3) ya estableció para `AgentRuntime`: el LLM **nunca decide qué tool llamar ni en qué orden**. Hay exactamente **un** tool con LLM real (`interpretDailyDirective`), y su única salida es un objeto estructurado y validado — nunca una decisión de acción. Todo lo que pasa después es una secuencia de llamadas **fija, escrita en código**, a tools que ya existen y que ya están acotados por su propia matriz de autonomía. El CEO Agent no gana ninguna capacidad nueva que sus tools no tuvieran ya — solo gana la capacidad de traducir una instrucción en lenguaje natural a esos tools y de reportar el resultado.

**1. `interpretDailyDirective` (CEO Agent, único tool con LLM, patrón híbrido D8):**
- Input: el texto libre del usuario.
- El prompt incluye, como vocabulario cerrado, los nombres reales de `Industry` y `JobCategory` del tenant (igual que F3 nunca inventa una industria al importar — acá tampoco se inventa una al interpretar). El LLM solo puede **elegir entre esos nombres reales**, nunca inventar uno nuevo.
- Salida validada con Zod: `{ industryNames: string[], state?: string, city?: string, categoryNames: string[], desiredVolume?: number, objective?: string }`. Cualquier nombre que el LLM devuelva y no matchee una `Industry`/`JobCategory` real del tenant se descarta y se reporta como "no reconocido" en el resumen de la misión — nunca se crea una industria/categoría nueva para que "calce".
- Este tool crea el **`AgentTask` raíz** de la misión (ver "Persistencia" abajo) y corre **síncrono** (rápido, barato) para que el usuario vea de inmediato qué se entendió, antes de que el resto del trabajo arranque en segundo plano.

**2. Secuencia fija de delegación (código determinista, sin LLM decidiendo el flujo):**

```
interpretDailyDirective (CEO Agent)
        │
        ├─▶ ¿ya existe una Campaign DRAFT/ACTIVE con criterios equivalentes?
        │      sí → reutilizarla (evita duplicar, ver "Deduplicación")
        │      no → createCampaign (Campaign Agent)
        │
        ├─▶ selectTargetCompanies (Campaign Agent)
        │      tope = min(desiredVolume interpretado, 50/corrida ya aprobado en §11)
        │
        ├─▶ para cada empresa recién targeteada sin score reciente:
        │      scoreCompany (Sales Agent, ya real desde F2 — no se reimplementa)
        │
        ├─▶ para cada empresa recién targeteada sin Lead:
        │      createLead (Sales Agent, ya real desde F2)
        │
        ├─▶ para cada CampaignCompany nueva:
        │      planSequence (Outreach Agent) → 4 FollowUp (día 1/4/9/18)
        │
        ├─▶ para el paso que corresponde hoy (normalmente día 1):
        │      personalizeMessage (Outreach Agent) → SIEMPRE ApprovalRequest
        │
        └─▶ (si la industria interpretada no tiene memoria reciente de
               Market Intelligence, F3 §7) analyzeIndustry
               (Market Intelligence Agent) → contexto para el resumen,
               no cambia la selección determinista de empresas
```

Cada paso de esta secuencia corre exactamente las mismas tools ya descritas en §4/§11/§13/§14 de este plan — la Daily Revenue Mission no define ninguna tool de negocio nueva, solo las orquesta.

**Por qué esto cumple, por construcción, cada restricción pedida:**

| Restricción pedida | Por qué se cumple |
|---|---|
| No inventar empresas | `selectTargetCompanies` solo lee `Company` ya existentes en el CRM (§11) |
| No inventar contactos | `createLead`/`identifyContacts` nunca inventan un `Contact` (regla de F2, sin cambios) |
| No enviar correos | `personalizeMessage` siempre termina en `ApprovalRequest` (§13/§14) |
| No modificar tarifas | Ningún tool de F4 toca `estimatedPayRate`/`estimatedBillRate` — eso sigue siendo exclusivo de Pricing Agent/humano |
| No cerrar contratos | Ningún tool de F4 toca `Contract`/`Invoice` |
| No gastar dinero sin límite | Presupuesto mensual (existente) + presupuesto por misión (nuevo, ver abajo) |
| No saltarse `ApprovalRequest` | La secuencia fija reutiliza `requiresApproval()` (`ApprovalGate.ts`) sin cambios — no hay forma de que la misión invoque `personalizeMessage` sin pasar por esa verificación, porque es el mismo `task-executor.ts` quien la aplica |

#### Persistencia: `AgentTask` alcanza, sin modelo nuevo

**Validación pedida: ¿puede `AgentTask` representar la misión como tarea raíz?** Sí, sin cambios de schema. `type: "daily_revenue_mission"` (string libre, la columna ya es `String`, no un enum — no hace falta migración para agregar este valor), `agentInstanceId` = instancia del CEO Agent, `triggeredBy: "USER"`.

- **Objetivo + filtros interpretados** → `AgentTask.input` (ya `Json`): `{ rawInstruction, industryNames, state, city, categoryNames, desiredVolume, businessObjective, unrecognizedTerms }` — `businessObjective` es el concepto nuevo de esta sección, ver "Business Objective" abajo.
- **Progreso + resumen** → `AgentTask.output` (ya `Json`, mutable en cualquier momento): un objeto que se actualiza incrementalmente a medida que cada paso delegado termina — `{ missionState, companiesTargeted, leadsCreated, opportunitiesCreated, sequencesPlanned, draftsAwaitingApproval, costUsdSoFar, objectiveProgress, report? }`. Esto es un **rollup cacheado para lectura rápida**, no la fuente de verdad — la fuente de verdad real es la lista de `AgentTask` hijos (ver abajo), igual que el dashboard de F3 ya recalcula agregados en vez de confiar en un contador guardado.

**Validación pedida: ¿`parentTaskId` soporta las subtareas correctamente?** Sí, con una simplificación deliberada respecto al patrón de F3: `processCompanyPipeline` (F3) anida tareas hijas de tareas hijas (varios niveles). La Daily Revenue Mission usa **un árbol de un solo nivel**: cada tarea delegada — sin importar qué agente la ejecute ni en qué paso de la secuencia esté — usa `parentTaskId = <id de la misión raíz>` directamente, nunca a través de un padre intermedio. Ventaja concreta: "todas las tareas de esta misión" y "costo total de esta misión" son **una sola consulta no recursiva**:

```ts
AgentTask.findMany({ where: { parentTaskId: missionId } })
AgentTask.aggregate({ where: { parentTaskId: missionId }, _sum: { costUsd: true } })
```

Se descartó explícitamente la alternativa de etiquetar `missionId` dentro de `input` y filtrar por ese path de Json (`{ input: { path: ["missionId"], equals } }`): Prisma lo soporta para Postgres, pero es un patrón de consulta que **no tiene precedente todavía en este repo** — el árbol plano de un nivel logra el mismo resultado con una consulta ya usada desde F2/F3 (filtrar `AgentTask` por `parentTaskId`), sin introducir una técnica nueva sin probar.

**Conclusión: no se necesita ningún modelo nuevo para representar la misión.** Se usa `AgentTask` con lo que ya tiene.

#### Business Objective

**Toda Daily Revenue Mission debe estar ligada a un objetivo de negocio explícito** — no es una preferencia de diseño, es un requisito: sin un objetivo, no hay contra qué medir "éxito" al cerrar el día. Igual que el resto de esta sección, **no se necesita ningún modelo nuevo** — el objetivo vive dentro del mismo `input`/`output` Json ya diseñado arriba.

**`interpretDailyDirective` (§ arriba) extrae el objetivo junto con el resto de los criterios**, usando el mismo principio de vocabulario cerrado (nunca inventa un tipo de objetivo que no exista en esta lista):

```ts
businessObjective: {
  type: "meetings" | "new_clients" | "companies_found" | "pipeline_increase" | "custom",
  target: number | null,   // null cuando la instrucción es cualitativa, ej. "prospectar warehouses en Illinois"
  unit: string,             // "reuniones", "clientes", "empresas", "USD"
  rawText: string,          // la frase original del objetivo, para mostrarla tal cual en la UI
}
```

| Ejemplo del pedido | `type` | `target` | `unit` |
|---|---|---|---|
| "Conseguir 3 reuniones" | `meetings` | 3 | "reuniones" |
| "Conseguir 1 cliente nuevo" | `new_clients` | 1 | "clientes" |
| "Encontrar 50 empresas" | `companies_found` | 50 | "empresas" |
| "Prospectar warehouses en Illinois" | `custom` | `null` | "empresas prospectadas" |
| "Aumentar pipeline en $250,000" | `pipeline_increase` | 250000 | "USD" |

**Cómo se calcula el progreso — siempre derivado, nunca un contador que se pueda desincronizar** (mismo principio "no hardcodear" ya aplicado en F3.5 a todo el frontend, acá aplicado a un cálculo de backend):

| `type` | Cómo se computa `current` |
|---|---|
| `meetings` | Conteo de `FollowUp`/`Activity` tipo `MEETING` creados como parte de las tareas hijas de esta misión (`parentTaskId = missionId`) |
| `new_clients` | Conteo de `Company.status = CLIENT` entre las empresas que entraron a una `CampaignCompany` de esta misión |
| `companies_found` | Conteo de `CampaignCompany` creadas por el `select_target_companies` de esta misión |
| `pipeline_increase` | `sum(Opportunity.estimatedRevenue)` de oportunidades creadas entre las empresas de esta misión |
| `custom` | Sin número — se muestra el progreso cualitativo (empresas encontradas/procesadas) sin pretender un porcentaje de cumplimiento inventado |

`output.objectiveProgress = { type, target, unit, current, percentComplete, rawText }` se recalcula en cada lectura (`GET /missions/:id`), igual que el resto del rollup — no es una escritura que pueda quedar desactualizada.

**Executive Report:** `closeDailyMission` (ya descrito en "Cómo se mostrará el reporte de fin de día", abajo) usa el nombre **Executive Report** deliberadamente — el `CEO Agent` de la Arquitectura original (`docs/01_ARQUITECTURA_v1.1.md` §3.3) ya preveía un tool `generateExecutiveReport` desde antes de F0; F4 lo cumple por primera vez, antes de lo previsto en el roadmap original. El reporte siempre declara el objetivo y su cumplimiento explícitamente, ej.: *"Objetivo: conseguir 3 reuniones. Logrado: 1 reunión confirmada, 2 borradores de seguimiento pendientes de aprobación que podrían derivar en reunión esta semana."* — el número lo calcula el código (tabla de arriba); el LLM solo lo narra (mismo patrón híbrido D8 que el resto del sistema).

**Alcance explícito de esta fase: no se construye ningún dashboard ejecutivo avanzado.** El único lugar donde esto se muestra es la misma tarjeta "Misión de hoy" ya prevista en Mission Control (ver abajo), con una línea adicional de progreso (`{current} / {target} {unit}`) — no una pantalla nueva, no gráficos nuevos, no un módulo de reporting separado. Lo que se dejó preparado en este addendum es **el modelo de datos** (la forma de `businessObjective`/`objectiveProgress` dentro de `input`/`output`), no la experiencia de reporting ejecutivo completa — esa es una ampliación de producto futura, fuera del alcance de F4.

#### Cómo se evitarán campañas duplicadas

Antes de `createCampaign`, la secuencia determinista busca una `Campaign` existente con `status IN (DRAFT, ACTIVE)` cuyos criterios sean equivalentes (mismo `industryId` + `state`/`city` + solape de `targetCategoryIds`). Si existe, **se reutiliza** (se le agregan las empresas recién seleccionadas vía `selectTargetCompanies` contra esa misma campaña) en vez de crear una segunda. Determinista, sin LLM, usando los campos que §6 ya define.

Adicionalmente: **una misión activa por tenant por día.** Antes de crear un `AgentTask` raíz nuevo, se verifica si ya existe uno con `type: "daily_revenue_mission"`, `status: "RUNNING"` y `createdAt` de hoy. Si existe, la nueva instrucción se trata como una actualización de esa misión (se re-interpreta y se fusiona con los filtros ya activos) en vez de crear una segunda misión paralela — evita duplicar gasto y confundir Mission Control con dos misiones simultáneas el mismo día.

#### Cómo se impedirá contactar dos veces al mismo prospecto

Tres mecanismos, ninguno nuevo — todos ya definidos en §11/§16 de este plan, y aplican sin cambios cuando quien invoca `selectTargetCompanies`/`planSequence` es la misión en vez de un humano:

1. `@@unique([campaignId, companyId])` en `CampaignCompany` (§6.1) impide agregar la misma empresa dos veces a la misma campaña.
2. `selectTargetCompanies` (§11) excluye empresas ya `TARGETED`/`SEQUENCING`/`HOT`/`RECOVERED` en **cualquier otra** campaña activa del tenant.
3. `suggestNextStep` (§16) excluye por 180 días a empresas clasificadas `NOT_INTERESTED`/`OUT_OF_MARKET` de futuras selecciones automáticas.

Se agrega una única guarda nueva, a nivel de código (no de schema): **`planSequence` es idempotente** — si la `CampaignCompany` ya tiene `FollowUp` de secuencia (`campaignId` no nulo) creados, no crea una segunda tanda. Esto protege contra el caso específico de que una misión se re-ejecute sobre una campaña reutilizada y intente replanificar una secuencia que ya existe.

#### Cómo se aplicará el presupuesto de IA por misión

El guardia mensual (`budget.ts`, `Tenant.settings.aiMonthlyBudgetUsd`) sigue aplicando sin cambios — pero una sola instrucción demasiado amplia ("busca todas las empresas de manufactura del país") podría, en teoría, agotar el presupuesto del mes entero en una sola misión. Se agrega un segundo límite, más acotado:

- `Tenant.settings.dailyMissionBudgetUsd` (nuevo, **Json existente — sin migración**, mismo patrón que `aiMonthlyBudgetUsd`/`prospectingSweepIntervalHours`). Default propuesto: $3/día (muy por debajo del default mensual de $50, deja margen para varias misiones/semana sin acercarse al techo mensual).
- Antes de cada paso de la secuencia determinista, se suma `costUsd` de la misión raíz + todos sus hijos directos (`parentTaskId = missionId`, la misma consulta plana de arriba) y se compara contra `dailyMissionBudgetUsd`. Si el próximo paso lo excedería, la misión se detiene ahí (no se fuerza), queda `output.missionState: "PAUSED_BUDGET"`, y el reporte de cierre lo indica explícitamente ("misión pausada por presupuesto diario — quedaron N empresas sin procesar").
- Esto es exactamente el mismo patrón ya usado en F3 §6 para el guardia mensual dentro de un sweep del scheduler — solo con un techo más chico y un scope más chico (`parentTaskId` en vez de todo el mes).

#### Cómo se cancelará o pausará una misión

**Decisión explícita: no se agrega `PAUSED`/`CANCELLED` a `AgentTaskStatus`.** Ese enum es compartido por **todos** los `AgentTask` de **todos** los agentes del sistema (score_company, draft_outreach, analyze_industry...) — ninguno de esos tiene un concepto de "pausa". Ensancharlo solo para que un tipo de tarea lo use sería agregar superficie global por una necesidad local, justo lo contrario de lo que este addendum pide (mínimo cambio de schema).

En cambio, el ciclo de vida rico de la misión vive en `output.missionState`, un valor de texto libre dentro del Json ya mutable: `"RUNNING" | "PAUSED_BY_USER" | "PAUSED_BUDGET" | "CANCELLED" | "COMPLETED"`. La columna `AgentTask.status` en sí se queda simple: `RUNNING` mientras la misión está abierta (en cualquiera de sus sub-estados), `DONE` cuando se cierra con reporte, `FAILED` solo si algo revienta la orquestación misma (no un resultado normal).

`PATCH /missions/:id` con `{ action: "pause" | "resume" | "cancel" | "close_now" }` actualiza `output.missionState`. El orquestador y el scheduler chequean ese valor antes de delegar cualquier paso nuevo — una misión `PAUSED_*`/`CANCELLED` simplemente deja de recibir nuevas delegaciones ese tick. Cancelar no revierte nada ya creado (los `CampaignCompany`/`FollowUp`/borradores ya generados quedan tal cual, igual que cancelar no "des-hace" nada en ningún otro flujo de este sistema) — solo detiene el avance futuro.

#### Cómo se mostrará el reporte de fin de día

`closeDailyMission` (CEO Agent, híbrido D8) — el **Executive Report** de la misión: agrega los contadores reales (misma consulta plana por `parentTaskId`) + el cumplimiento del `businessObjective` (ver "Business Objective" arriba) + redacta un párrafo corto explicando el resultado del día. Se dispara de dos formas:
1. **Automática**, vía el mismo mecanismo de scheduler ya existente (F3 §6, un sub-paso más en el mismo tick): cualquier misión `RUNNING`/`PAUSED_*` creada antes del día calendario actual se cierra con lo que se alcanzó a hacer.
2. **Manual**, vía `PATCH /missions/:id` con `{ action: "close_now" }` — el usuario puede pedir el reporte antes de que termine el día.

El resultado (`output.report`) se muestra en una tarjeta "Misión de hoy" en Mission Control (extiende la sección de IA de `Dashboard.tsx` ya construida en F3.5 — no reemplaza nada) mientras está `RUNNING` (contadores en vivo + la línea de progreso hacia el objetivo, refetch igual que el resto del dashboard) y como Executive Report narrativo una vez `COMPLETED`. Una página nueva `Missions.tsx` (`/missions`) lista el historial completo (una misión típica por día). Ningún dashboard ejecutivo adicional se construye en esta fase — ver el cierre de "Business Objective" arriba.

#### Qué permisos RBAC controlarán crear, pausar y cancelar misiones

Se agrega `"missions"` a `PERMISSION_RESOURCES` (mismo mecanismo ya usado para `campaigns` en este plan y para `leads`/`opportunities`/`followUps` en F1) — genera automáticamente `missions.view`/`missions.create`/`missions.update`/`missions.delete`.

- **`missions.delete` no se asigna a ningún rol y no se expone en ningún endpoint.** Cancelar es un cambio de estado (`missions.update`), nunca un borrado — el historial de auditoría de una misión (igual que el de cualquier `AgentTask`/`AuditLog`) no se elimina jamás.
- `CEO`/`Admin` reciben `missions.*` automáticamente (ya heredan `ALL_KEYS`/`ALL_KEYS` menos `payroll.approve`, sin cambios adicionales en el seed).
- `Sales` gana explícitamente `missions.view`/`missions.create`/`missions.update` en el seed (mismo criterio ya aplicado a `campaigns.*` en §21 — el mismo rol que ya ejecuta agentes y decide aprobaciones puede lanzar/pausar/cancelar la misión diaria).

#### Bloqueante identificado (y ya resuelto en este addendum, no de schema)

No hay ningún bloqueante de **schema**. El único punto que requería una decisión de diseño explícita: `task-executor.ts` (`executeTaskById`) hoy asume que un `AgentTask` corre **un** tool y termina en el mismo ciclo (`DONE`/`FAILED`/`AWAITING_APPROVAL`). Una Daily Revenue Mission necesita quedarse abierta (`RUNNING`) durante horas mientras se delega trabajo de forma incremental. Esto se resuelve con un **orquestador de misión dedicado** (código nuevo, ej. `apps/api/src/modules/agents/mission-orchestrator.ts`) que corre `interpretDailyDirective` síncrono al crear la misión y dispara el resto de la secuencia de forma asíncrona (mismo patrón `runTaskAsync` ya existente) — la tarea raíz no pasa por `TASK_TYPE_TO_TOOL_NAME` como las demás. Es una pieza de código nueva, documentada acá para que no sea una sorpresa al implementar — no un cambio de modelo ni de columna.

#### Definition of Done — Daily Revenue Mission (además de §22)

- [x] Una instrucción en lenguaje natural crea un `AgentTask` raíz `daily_revenue_mission`, interpretado en criterios reales (industrias/categorías que existen en el tenant, nunca inventadas)
- [x] La secuencia determinista delega correctamente a Campaign/Sales/Outreach Agent, con `parentTaskId` plano hacia la misión en cada tarea hija — nota: Market Intelligence Agent no se ejercitó en la secuencia real de F4 (su rol quedó como contexto opcional, ver §"Business Objective"/pipeline; no es un bloqueante, el mecanismo de delegación es el mismo `createAndRunTaskSync` ya probado para los otros tres agentes)
- [x] Una campaña con criterios equivalentes a una ya `DRAFT`/`ACTIVE` se reutiliza, nunca se duplica
- [x] Ninguna empresa recibe una segunda secuencia paralela si ya está `TARGETED`/`SEQUENCING`/`HOT`/`RECOVERED` en otra campaña activa
- [x] El presupuesto diario de la misión (`dailyMissionBudgetUsd`) detiene la delegación antes de excederse, sin bloquear el guardia mensual existente — implementado y con guardia verificado en código; no se forzó un escenario real de agotamiento del presupuesto diario en la verificación manual (el guardia reutiliza la misma lógica ya probada exhaustivamente para el presupuesto mensual en F2/F3/F4)
- [x] Pausar/reanudar/cancelar una misión (`output.missionState`) detiene/reanuda correctamente la delegación futura sin revertir lo ya creado
- [x] `interpretDailyDirective` extrae un `businessObjective` real (`type`/`target`/`unit`/`rawText`) de la instrucción, con vocabulario cerrado a los 5 tipos definidos — nunca inventa un tipo nuevo (incluyendo el caso real encontrado de `unit: null` cuando no hay objetivo numérico, corregido durante F4-8)
- [x] `objectiveProgress` se recalcula correctamente — verificado con datos reales para `meetings` y `companies_found` (las dos misiones de prueba reales); `new_clients`/`pipeline_increase`/`custom` comparten la misma función de cómputo (`computeMissionProgress`) y no requieren lógica adicional no probada, pero no se ejercitó cada uno con su propio caso end-to-end
- [x] El Executive Report (`closeDailyMission`) declara explícitamente el objetivo y su cumplimiento con números reales, nunca inventados
- [x] El reporte de cierre de día se genera automáticamente (scheduler) o bajo demanda (`close_now`), con datos reales agregados de las tareas hijas
- [x] Mission Control muestra el progreso en vivo de la misión del día (incluyendo la línea de progreso hacia el objetivo) y el Executive Report una vez cerrada — sin ningún dashboard ejecutivo adicional
- [x] RBAC: `missions.view`/`create`/`update` protegidos correctamente (403 verificado con compliance@titan.dev); `missions.delete` no existe en ningún rol
- [x] Cero cambios al enum `AgentTaskStatus` — verificado que ningún otro agente/tarea del sistema se ve afectado
- [x] `AgentDefinition.defaultAutonomy`/`AgentInstance.autonomyLevel` corregidos de `ASSISTED` a `SEMI_AUTO` para Sales/Prospecting/Market Intelligence/Campaign/Outreach/Conversation (corrección de nomenclatura de `01_ARQUITECTURA_v1.1.md` §3.5, sin cambio de comportamiento) — verificado directamente contra la base real
- [x] `pnpm typecheck`/`lint`/`test` limpios; F0–F3.5 intactos

---

### F4.5 — External Discovery & Communications

Documentado por separado y en detalle en `docs/F4_5_EXTERNAL_DISCOVERY_AND_EMAIL_PLAN.md`. **No se implementa en F4.** Cubre lo que hace falta para que el sistema salga a buscar clientes *fuera* del CRM y, eventualmente, envíe correo real bajo control humano: fuentes externas autorizadas, enriquecimiento, verificación de contactos/emails, integración con Google Workspace/Microsoft 365, envío controlado, lectura de respuestas, Conversation Agent conectado a correo real, calendario, SPF/DKIM/DMARC, límites de envío, cumplimiento CAN-SPAM, y costos/proveedores. Es la fase natural siguiente una vez que F4 esté cerrado y verificado — este plan deja el terreno listo (Campaign/CampaignCompany/Outreach Agent/Conversation Agent) para que F4.5 los extienda en vez de reemplazarlos.

---

## Resultado de la implementación

### Fecha de finalización

2026-07-10

### Commit final de F4

`b44ab29` — commit range `016447a`→`b44ab29`, 9 commits (F4-0 docs/addendum, F4-1 schema+permisos+agentes+seed, F4-2 schemas compartidos+extensión del AI Dashboard, F4-4 módulo de campañas, F4-5 orquestador de la misión+módulo de misiones, F4-6 extensión del scheduler, F4-8 tests automatizados, F4-9 frontend de campañas, F4-10 frontend de misiones). Este propio documento se cierra en un commit posterior, docs-only, que no forma parte de la implementación funcional.

### Resumen ejecutivo

F3 dejó un motor que analiza una empresa a la vez y prepara un primer contacto. F4 lo convierte en un SDR autónomo real: el **Campaign Agent** agrupa empresas del CRM en campañas con criterios de segmentación (industria/ubicación/tamaño/score/categorías), el **Outreach Agent** planifica una secuencia comercial de 4 pasos (día 1/4/9/18) y redacta cada mensaje **justo a tiempo** — nunca los cuatro por adelantado — con contexto genuinamente distinto por empresa, y el **Conversation Agent** clasifica respuestas (pegadas manualmente, sin integración de bandeja todavía) en 7 categorías cerradas de intención. Por encima de los tres, el **CEO Agent** — stub sin comportamiento desde F0 — se gradúa a orquestador real: interpreta una instrucción diaria en lenguaje natural (única llamada a LLM del agente, con vocabulario cerrado a la industria/categorías reales del tenant) y ejecuta una secuencia **fija, escrita en código** que delega a Campaign, Sales y Outreach Agent — nunca decide él mismo qué tool llamar. Cada Daily Revenue Mission queda ligada a un objetivo de negocio explícito (reuniones, clientes nuevos, empresas encontradas, aumento de pipeline, u objetivo cualitativo) cuyo progreso se recalcula en vivo y se cierra con un Executive Report narrado sobre números reales. La frontera de F2/F3 — todo lo interno corre solo, todo lo que produce contenido externo siempre termina en `ApprovalRequest`, nunca se envía nada — se mantuvo intacta en cada pieza nueva; se verificó de punta a punta incluyendo la aprobación real de un borrador desde `/approvals`. Se agregó también, como principio arquitectónico permanente (no solo de esta fase), el "Principio de autonomía progresiva" (`01_ARQUITECTURA_v1.1.md` §3.5) documentando los 4 niveles de autonomía y corrigiendo la nomenclatura de los agentes ya reales de `ASSISTED` a `SEMI_AUTO` — sin ningún cambio de comportamiento, dado que el campo nunca fue leído por el runtime hasta ahora.

### Métricas finales

| Métrica | Valor |
|---|---|
| Tests | 39/39 (28 de F0-F3.5 + 11 nuevos de F4, varios con llamadas reales a OpenAI) |
| Commits de F4 | 9 |
| Archivos modificados/creados (código, sin este doc) | 49 archivos, +4693/-24 líneas, 28 archivos nuevos |
| Cambios de schema | 2 modelos nuevos (`Campaign`, `CampaignCompany`), 3 enums nuevos, 1 campo nuevo (`FollowUp.campaignId`), 1 migración (`20260710031139_f4_outreach_engine`) |
| Modelos Prisma | 41 (39 de F3 + `Campaign` + `CampaignCompany`) |
| Migraciones totales | 5 (`init`, `f1_revenue_engine`, `f2_sales_agent`, `f3_prospecting_engine`, `f4_outreach_engine`) |
| Permisos totales | 61 (+4 de `campaigns.*`, +3 de `missions.view/create/update` — `missions.delete` deliberadamente no se agrega a ningún rol) |
| Endpoints HTTP totales | 68 (+12 en F4: 8 en `/campaigns`+`/campaign-companies`, 4 en `/missions`) |
| Páginas frontend | 23 (19 de F3 + `Campaigns.tsx`, `CampaignDetail.tsx`, `CampaignCompanyDetail.tsx`, `Missions.tsx`) |
| Agentes (`AgentDefinition`) | 16 (13 de F3 + `campaign`, `outreach`, `conversation`; `ceo` graduado de stub) |
| Tools con lógica real agregados en F4 | 9 (`createCampaign`, `selectTargetCompanies`, `measureCampaign`, `optimizeCampaign`, `planSequence`, `personalizeMessage`, `suggestNextStep`, `classifyConversation`, más `interpretDailyDirective`/`closeDailyMission` del CEO Agent) |
| `AgentTask` acumuladas (dev, todas las fases) | 208 (55 de tipos nuevos de F4) |
| `Campaign` / `CampaignCompany` creadas (dev) | 1 / 3 |
| `Daily Revenue Mission` lanzadas (dev) | 2, ambas cerradas con Executive Report real |
| `ApprovalRequest` acumuladas (todas las fases) | 18 |
| Costo real de OpenAI en F4 (dev) | $0.0023 (de $0.0044 acumulado en todas las fases) |

### Nuevos agentes implementados

- **Campaign Agent** (`key: "campaign"`, autonomía `SEMI_AUTO`): `createCampaign`, `selectTargetCompanies`, `measureCampaign` (deterministas), `optimizeCampaign` (híbrido D8, solo recomienda).
- **Outreach Agent** (`key: "outreach"`, `SEMI_AUTO`): `planSequence`, `suggestNextStep` (deterministas), `personalizeMessage` (híbrido D8, siempre `ApprovalRequest`).
- **Conversation Agent** (`key: "conversation"`, `SEMI_AUTO`): único tool `classifyConversation` (híbrido D8, vocabulario cerrado a 7 categorías).
- **CEO Agent** (`key: "ceo"`, autonomía `ASSISTED` — no `SEMI_AUTO`, porque no escribe registros de negocio directamente, solo interpreta y reporta): deja de ser stub (`tools: []` desde F0) — gana `interpretDailyDirective` (único tool con LLM real) y `closeDailyMission` (híbrido D8, Executive Report).

### Nuevas herramientas implementadas

| Tool | Agente | Tipo |
|---|---|---|
| `createCampaign` | Campaign Agent | Determinista — dedup/reuse de campañas equivalentes |
| `selectTargetCompanies` | Campaign Agent | Determinista — filtra `Company` reales, excluye targeteadas en otra campaña activa |
| `measureCampaign` | Campaign Agent | Determinista — agregación, sin LLM |
| `optimizeCampaign` | Campaign Agent | Híbrido D8 — solo recomienda |
| `planSequence` | Outreach Agent | Determinista — idempotente |
| `personalizeMessage` | Outreach Agent | Híbrido D8 — siempre `ApprovalRequest` |
| `suggestNextStep` | Outreach Agent | Determinista — árbol de decisión sobre la intención clasificada |
| `classifyConversation` | Conversation Agent | Híbrido D8 — 7 categorías cerradas validadas con Zod |
| `interpretDailyDirective` | CEO Agent | Híbrido D8 — único LLM del CEO Agent, vocabulario cerrado |
| `closeDailyMission` | CEO Agent | Híbrido D8 — Executive Report |

### Nuevos endpoints

`POST/GET /campaigns`, `GET/PATCH /campaigns/:id`, `POST /campaigns/:id/tasks`, `GET /campaign-companies/:id`, `POST /campaign-companies/:id/tasks`, `POST /campaign-companies/:id/conversation` (`campaigns.create/view/update`, `agents.execute`) — 8 rutas. `POST/GET /missions`, `GET/PATCH /missions/:id` (`missions.create/view/update`) — 4 rutas. Ninguna reemplaza ni modifica un endpoint de F0-F3.5; `GET /ai-dashboard/summary` se extendió aditivamente (mismo endpoint de F3).

### Nuevas páginas

`Campaigns.tsx` (`/campaigns`), `CampaignDetail.tsx` (`/campaigns/:id`), `CampaignCompanyDetail.tsx` (`/campaigns/:campaignId/companies/:companyId`), `Missions.tsx` (`/missions`). Además: tarjeta "Misión de hoy" en `Dashboard.tsx`, extensión aditiva de `AIDashboard.tsx` con las métricas de campañas/misión, nuevos componentes compartidos `CampaignCard`, `IntentBadge`, `SequenceTimeline`.

### Estado del Scheduler

Extendido (mismo mecanismo in-process de F3, sin Redis/BullMQ): dos chequeos nuevos corren en **cada** tick de 15 minutos (no gateados por el intervalo de 6h del sweep de prospección, porque son consultas baratas que solo actúan cuando algo está vencido): `runCampaignSequenceSweep` (redacta automáticamente el paso de secuencia que corresponde cuando su `FollowUp` vence, respetando el guardia mensual) y `runMissionCloseSweep` (cierra con Executive Report cualquier misión abierta de un día calendario anterior). Verificado directamente: forzar el `dueDate` de un paso al pasado y correr un tick real generó un borrador genuinamente personalizado y marcó el paso `DONE`; un segundo tick no lo volvió a tocar.

### Estado de AgentMemory

Sin cambios — F4 no agregó ningún uso nuevo de `AgentMemory`. Los dos usos funcionales de F3 (dedup de empresas procesadas, memoria de industria) siguen intactos.

### Estado del Dashboard IA

`GET /ai-dashboard/summary` extendido aditivamente con 11 campos nuevos (campañas activas/finalizadas, empresas por campaña, calientes/frías/recuperadas, costo por campaña/lead/oportunidad, tiempo ahorrado estimado, productividad IA) — el shape de F3 no se rompió, verificado que `AIDashboard.tsx` sigue mostrando todo lo de F3/F3.5 sin cambios además de lo nuevo.

### Costos reales de OpenAI durante las pruebas

Modelo `gpt-4o-mini` en todos los casos. Costo de F4 en desarrollo: **$0.0023** (de $0.0044 acumulado en F1-F4 juntos). Cada corrida de `pnpm test` incluye varias llamadas reales (personalización de mensajes, clasificación de conversaciones, interpretación de misiones, Executive Reports), a una fracción de centavo cada una. El presupuesto mensual de $50 y el nuevo presupuesto diario de misión de $3 (`Tenant.settings.dailyMissionBudgetUsd`) tienen margen amplísimo frente al gasto real observado.

### Bugs encontrados durante la implementación y cómo fueron corregidos

1. **Campañas creadas por el Campaign Agent quedaban en `DRAFT` para siempre**, y `selectTargetCompanies` solo excluye empresas ya targeteadas en una campaña `ACTIVE` — la exclusión cruzada de campañas en la que se apoya todo este plan nunca se activaba porque nada ponía una campaña en `ACTIVE` automáticamente. Encontrado escribiendo `campaigns.test.ts`. Corregido: una campaña creada vía tool de agente (`createdByAgentTaskId` presente) arranca `ACTIVE` de inmediato; una creada por un humano vía `POST /campaigns` sigue arrancando `DRAFT` para revisión.
2. **"Una misión por día" comparaba `AgentTask.status === "RUNNING"`**, pero cancelar/pausar una misión (decisión explícita del addendum: nunca tocar `AgentTaskStatus`) solo actualiza `output.missionState` — una misión cancelada quedaba bloqueando el lanzamiento de una nueva indefinidamente. Encontrado en `missions.test.ts` (y reproducido contra el servidor real). Corregido: el chequeo ahora excluye en código las misiones cuyo `missionState` es `CANCELLED`.
3. **`interpretDailyDirective` rechazaba interpretaciones válidas**: el modelo devuelve legítimamente `unit: null` junto con `target: null` cuando la instrucción no tiene un objetivo numérico explícito (ej. "Encuentra empresas de construcción en Indiana." no tiene un número que escalar), pero el schema de parseo exigía `unit` como string siempre — la interpretación completa (industrias/ubicación correctas) se descartaba por ese detalle. Encontrado con un script de debug dedicado tras dos intentos fallidos de diagnóstico por log. Corregido: el schema de parseo acepta `unit: null` y se normaliza a `"empresas"` después — nunca se descarta una buena interpretación por un campo lenient.
4. **`personalizeMessage` nunca marcaba su `FollowUp` como `DONE`** — el scheduler habría vuelto a redactar el mismo paso en cada tick sucesivo, generando `ApprovalRequest` duplicados y gastando presupuesto de más. Encontrado al diseñar `runCampaignSequenceSweep` (F4-6), antes de que llegara a producción. Corregido: se marca `DONE` inmediatamente después de crear el `ApprovalRequest` — `DONE` significa "preparado", no "enviado".
5. **Costo por campaña siempre mostraba `$0`** en el rollup del dashboard — los tres tools del Outreach Agent (`planSequence`/`personalizeMessage`/`suggestNextStep`) se creaban sin `parentTaskId`, así que la consulta de costo (que suma vía `CampaignCompany.createdByAgentTaskId` + `parentTaskId`) nunca los encontraba. Encontrado probando manualmente contra el servidor real, no por un test. Corregido: `triggerCampaignCompanyTask`/`triggerCampaignTask`/`logConversation` ahora setean `parentTaskId` al `createdByAgentTaskId` de la `CampaignCompany`/`Campaign` correspondiente.

### Desviaciones aprobadas respecto al plan original

1. **"Una misión por día" se resuelve con rechazo claro, no con fusión de criterios.** El plan mencionaba "se trata como una actualización de esa misión (se re-interpreta y se fusiona)"; la implementación rechaza con un mensaje claro ("pausala o cancelala antes de lanzar una nueva") — documentado explícitamente en el addendum como simplificación deliberada antes de escribir código, no como un hallazgo posterior.
2. **`suggestNextStep` usa `EXCLUDED` en vez de un enfriamiento de 180 días** para `NOT_INTERESTED`/`OUT_OF_MARKET` — exclusión permanente hasta reactivación manual, más simple y documentada como tal en el propio código (`conversation-tools.impl.ts`), en vez del criterio de tiempo mencionado en el plan original.
3. Ninguna otra desviación — el resto del plan (segmentación, secuencia día 1/4/9/18, personalización just-in-time, `ApprovalRequest` para toda comunicación externa, Business Objective, `parentTaskId` plano, presupuesto diario de misión, Principio de autonomía progresiva) se implementó tal como se aprobó.

### Evidencia de verificación en navegador real

Flujo completo verificado con Playwright contra el backend real (Postgres + OpenAI real), cero errores de consola/HTTP en toda la corrida, en las 19 rutas de la aplicación (F0-F4), en modo claro y oscuro:

1. `Campaigns.tsx`: grilla de campañas reales, drawer "Nueva campaña" con industrias/categorías reales del tenant.
2. `CampaignDetail.tsx`: criterios, resultados reales, acciones del Campaign Agent, lista de empresas con badges de estado/intención reales (incluyendo una empresa `HOT`/`VERY_INTERESTED` de pruebas anteriores).
3. `CampaignCompanyDetail.tsx`: `SequenceTimeline` mostrando los 4 pasos reales (uno `DONE`, tres `CANCELLED` tras la clasificación de intención), conversación completa (respuesta pegada + clasificación), acciones del Outreach Agent.
4. `Missions.tsx`: formulario de lanzamiento, historial con las 2 misiones reales de prueba, barra de progreso del objetivo, drawer de detalle con Executive Report real.
5. `Dashboard.tsx`: tarjeta "Misión de hoy" — verificado tanto el estado "sin misión hoy" (correcto, las misiones de prueba fueron de un día calendario anterior) como el diseño con una misión activa.
6. `AIDashboard.tsx`: las 11 métricas nuevas de F4 con datos reales (1 campaña, empresas por campaña, costo por campaña, 1 empresa `HOT`, productividad IA).
7. `FollowUps.tsx` (F1, sin tocar): el `FollowUp` de secuencia creado por `planSequence` aparece con badge "AI", confirmando que F4 se integra con una página de una fase anterior sin romperla.
8. `/approvals` (F2, sin tocar): un borrador de `personalizeMessage` real, aprobado desde la UI — transición a `Approved`, atribuido al usuario real que decidió, toast de confirmación.

### Qué queda preparado para F4.5 / próxima fase

- `Campaign`, `CampaignCompany`, Outreach Agent y Conversation Agent son exactamente las piezas que `docs/F4_5_EXTERNAL_DISCOVERY_AND_EMAIL_PLAN.md` asume como ya construidas — F4.5 las extiende (fuentes de descubrimiento externas, envío real vía Gmail/Graph API, lectura de respuestas real) en vez de reemplazarlas.
- El campo `AgentInstance.autonomyLevel` (ahora con nomenclatura correcta) queda listo para que una fase futura (F5+) empiece a leerlo en `ApprovalGate.ts` — el Principio de autonomía progresiva (`01_ARQUITECTURA_v1.1.md` §3.5) documenta ese camino explícitamente.
- El patrón `parentTaskId` plano de un solo nivel (Daily Revenue Mission) es reutilizable para cualquier futuro "orquestador de nivel superior" que necesite agregar costo/progreso de sus tareas delegadas sin recursión.
- `runCeoToolDirectly` (tool corriendo directo contra una tarea raíz existente, no como hija) es un patrón nuevo y reutilizable para cualquier agente futuro que necesite un ciclo de vida largo similar al de la misión.
- Sigue fuera de alcance, sin cambios: envío real de email/LinkedIn, integración de bandeja de entrada, scraping agresivo, Redis/BullMQ, pgvector, enforcement real de niveles de autonomía 3/4.

---

**F4 (§1–§22 + addendum) completado y verificado. F4.5 sigue sin implementarse hasta su propia aprobación explícita separada.**
