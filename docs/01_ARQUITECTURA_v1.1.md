# AI Staffing OS — Documento de Arquitectura v1.0

**Producto:** Sistema operativo SaaS multi-tenant para agencias de staffing en EE.UU., operado por un equipo híbrido de humanos y agentes IA.
**Fecha:** Julio 2026
**Estado:** Pendiente de aprobación del Product Owner antes de escribir código.

---

## 0. Decisión estratégica previa: el corte del MVP

La visión completa (8 agentes, multi-tenant operativo, payroll completo, marketing multicanal) es el norte, no el punto de partida. Recomendación de corte:

**MVP (Fases 0–3):**
- Schema multi-tenant desde el día 1 (columna `tenantId` en todo), pero operando **una sola agencia**.
- 2 industrias verticales de arranque: **Construcción** y **Warehouse/Logística** (configurables, no hardcodeadas).
- 3 agentes IA: **Recruiter Agent**, **Compliance Agent** y **Assistant Agent** (chat transversal que responde consultas sobre datos de la empresa).
- Payroll = registro de horas, tarifas bill/pay, cálculo de márgenes y reportes. **Sin cálculo de impuestos ni tax filing** (se integra proveedor en Fase 5).
- Facturación = generación de invoices en PDF con líneas por trabajador/horas. Sin pagos online.

**Todo lo demás (Sales Agent, Marketing Agent, CEO Agent, orquestación autónoma completa, multi-agencia SaaS) se construye sobre esta base en Fases 4–7.**

Razón: el valor demostrable más rápido de este producto es *"registro un candidato, la IA lo califica, compliance lo valida, lo asigno a un proyecto y sé exactamente cuánto gano por hora con él"*. Ese loop completo es vendible por sí solo.

---

## 1. Arquitectura del sistema

### 1.1 Estilo arquitectónico

**Monolito modular** (modular monolith) preparado para extracción a microservicios. Un solo deploy, pero con fronteras de módulo estrictas:

```
apps/
  web/                  → React + Vite (frontend)
  api/                  → Node.js + Express + TypeScript (backend)
packages/
  db/                   → Prisma schema + client + migrations
  shared/               → Tipos, validadores Zod, constantes compartidas
  agents/               → Framework de agentes IA (aislado, extraíble)
```

### 1.2 Capas del backend

```
api/src/
  modules/
    auth/               → login, registro, sesiones, MFA
    tenants/            → agencias, configuración, branding
    crm/                → companies, contacts, leads, opportunities
    jobs/               → job orders (vacantes), requisitos
    talent/             → candidates, workers, skills, categorías
    compliance/         → documentos, verificaciones, alertas
    operations/         → projects, assignments, schedules, attendance
    payroll/            → time entries, payroll runs, rates, márgenes
    billing/            → invoices, contratos
    agents/             → AI Agents Center, tasks, memoria, aprobaciones
    audit/              → audit log inmutable
    notifications/      → in-app + email
  core/
    events/             → event bus interno (outbox pattern)
    queue/              → BullMQ workers (jobs asíncronos)
    rbac/               → middleware de permisos
    tenancy/            → middleware de aislamiento por tenant
```

Cada módulo expone: `router.ts` (HTTP), `service.ts` (lógica), `events.ts` (eventos que emite/escucha). **Los módulos nunca importan services de otros módulos directamente: se comunican por eventos o por interfaces públicas.** Esto es lo que permite extraer microservicios después sin reescribir.

### 1.3 Comunicación asíncrona (crítico para los agentes)

- **Redis + BullMQ** para colas de trabajo (llamadas a OpenAI, envío de emails, generación de reportes). *Nota: Redis se agrega al stack; es imprescindible para agentes.*
- **Outbox pattern en PostgreSQL:** cada evento de dominio (`candidate.created`, `document.expired`, `assignment.needed`) se escribe en tabla `DomainEvent` dentro de la misma transacción, y un worker lo publica a las colas. Garantiza que ningún evento se pierda.
- **WebSockets (Socket.io)** solo para push al frontend: notificaciones, actividad de agentes en vivo, chat.

### 1.4 Multi-tenancy

- **Modelo:** shared database, shared schema, con columna `tenantId` en todas las tablas de negocio.
- Middleware `tenancy` inyecta `tenantId` desde el JWT en cada request; Prisma Client Extensions aplican el filtro automáticamente (imposible olvidarlo en un query).
- Storage S3 con prefijo por tenant: `s3://bucket/{tenantId}/...`
- En el MVP existe un solo tenant, pero toda la infraestructura ya lo respeta.

### 1.5 Stack confirmado

| Capa | Tecnología | Nota |
|---|---|---|
| Frontend | React 18 + Vite + TypeScript | TanStack Query + Zustand |
| UI | Tailwind + shadcn/ui + Framer Motion | Design system propio encima |
| Backend | Node.js + Express + TypeScript | Zod en todos los inputs |
| DB | PostgreSQL 16 | Render Postgres en MVP |
| ORM | Prisma | Con client extensions para tenancy |
| Cache/colas | Redis + BullMQ | **Adición al stack original** |
| Auth | Clerk | Ahorra semanas vs JWT propio; soporta orgs (multi-tenant) nativo |
| Storage | S3 (o Cloudflare R2, compatible y más barato) | URLs firmadas |
| Email | Resend | Templates con react-email |
| Realtime | Socket.io | Rooms por tenant |
| IA | OpenAI (GPT-4.1/o-series) vía API | Abstraído tras interfaz `LLMProvider` para poder cambiar de proveedor |
| Deploy | Render (web service + worker + Postgres + Redis) | Docker desde el inicio |

---

## 2. Modelo de base de datos

Esquema Prisma resumido (modelos y relaciones clave; el schema completo se genera en Fase 0):

### 2.1 Núcleo y tenancy

```prisma
model Tenant {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique
  plan        Plan     @default(STARTER)
  settings    Json     // branding, timezone, industrias activas
  users       User[]
  // ... relación con todos los modelos de negocio
}

model User {
  id          String   @id @default(cuid())
  tenantId    String
  clerkId     String   @unique
  email       String
  firstName   String
  lastName    String
  role        Role     // relación a Role
  isActive    Boolean  @default(true)
}

model Role {
  id          String   @id @default(cuid())
  tenantId    String
  name        String   // CEO, Admin, Recruiter, Sales, Payroll...
  permissions Permission[] // tabla de unión
}

model Permission {
  id      String @id
  key     String @unique // "candidates.create", "payroll.approve"...
}
```

### 2.2 CRM y ventas

```prisma
model Company {       // cliente o prospecto
  id          String   @id @default(cuid())
  tenantId    String
  name        String
  industryId  String   // FK a Industry (dinámica, no enum)
  status      CompanyStatus // LEAD | PROSPECT | CLIENT | INACTIVE
  address     Json
  contacts    Contact[]
  jobOrders   JobOrder[]
  contracts   Contract[]
}

model Contact { id, tenantId, companyId, name, email, phone, title, isPrimary }

model Lead {
  id, tenantId, companyId?, source, status, ownerId,
  aiScore Float?, aiScoreReason String?   // scoring del Sales Agent
}

model Opportunity {
  id, tenantId, companyId, stage, estimatedWorkers, estimatedRevenue,
  probability, expectedCloseDate, ownerId
}

model Activity {      // llamadas, emails, reuniones, notas — timeline universal
  id, tenantId, type, subject, body,
  entityType, entityId,               // polimórfico: company, candidate, etc.
  performedById String?,              // usuario humano
  performedByAgentId String?          // o agente IA
}
```

### 2.3 Talento

```prisma
model Industry {      // dinámica: se agregan sin tocar código
  id, tenantId?, name, isGlobal Boolean
}

model JobCategory {   // Journeyman Electrician, Forklift Operator... dinámica
  id, tenantId, name, industryId?, requiredCertifications Json
}

model Candidate {
  id          String   @id @default(cuid())
  tenantId    String
  firstName, lastName, email, phone
  languages   String[]           // ["es", "en"]
  city, state, zip
  categories  JobCategory[]      // muchos-a-muchos
  yearsExperience Int?
  resumeUrl   String?
  aiSummary   String?            // análisis del Recruiter Agent
  aiScore     Float?
  status      CandidateStatus    // NEW | SCREENING | QUALIFIED | PLACED | REJECTED | INACTIVE
  documents   Document[]
  worker      Worker?            // se convierte en Worker al ser contratado
}

model Worker {
  id, tenantId, candidateId @unique
  employmentType    // W2 | 1099
  defaultPayRate    Decimal
  status            // AVAILABLE | ASSIGNED | ON_LEAVE | TERMINATED
  complianceStatus  // COMPLIANT | PENDING | BLOCKED  ← lo controla Compliance Agent
  assignments       Assignment[]
}
```

### 2.4 Vacantes, proyectos y operaciones

```prisma
model JobOrder {      // vacante de un cliente
  id, tenantId, companyId, categoryId
  title, workersNeeded Int, workersFilled Int @default(0)
  billRate Decimal, payRate Decimal          // margen = bill - pay
  location Json, shift Json, startDate, endDate?
  status    // OPEN | PARTIALLY_FILLED | FILLED | CLOSED | CANCELLED
  requirements Json   // certificaciones, drug test, background...
}

model Project {
  id, tenantId, companyId, name, location Json,
  status, supervisorContactId?, jobOrders JobOrder[]
}

model Assignment {
  id, tenantId, workerId, jobOrderId, projectId?
  payRate Decimal, billRate Decimal          // snapshot al momento de asignar
  startDate, endDate?, status // SCHEDULED | ACTIVE | COMPLETED | TERMINATED
  timeEntries TimeEntry[]
  @@index([tenantId, workerId, status])
}

model Shift { id, tenantId, assignmentId, date, startTime, endTime, breakMinutes }

model TimeEntry {
  id, tenantId, assignmentId, date
  regularHours Decimal, overtimeHours Decimal, doubleHours Decimal
  perDiem Decimal?, bonus Decimal?
  status        // PENDING | APPROVED | LOCKED (en payroll run)
  approvedById?, source // MANUAL | TIMECLOCK | IMPORT
}
```

### 2.5 Compliance

```prisma
model DocumentType {  // I-9, W-4, OSHA 10, Drug Test... configurable
  id, tenantId, name, category, requiresExpiration Boolean,
  appliesTo Json      // por categoría de trabajo / industria
}

model Document {
  id, tenantId, documentTypeId
  candidateId? | workerId? | companyId?      // dueño polimórfico
  fileUrl, issuedDate?, expirationDate?
  status        // PENDING_REVIEW | VERIFIED | REJECTED | EXPIRED
  verifiedById?, verifiedByAgent Boolean @default(false)
  aiExtraction Json?   // datos extraídos por el Compliance Agent
}

model ComplianceAlert {
  id, tenantId, workerId?, documentId?
  type          // EXPIRING | EXPIRED | MISSING | FAILED_CHECK
  severity, resolvedAt?, resolvedById?
}
```

### 2.6 Payroll y facturación

```prisma
model PayrollRun {
  id, tenantId, periodStart, periodEnd
  status        // DRAFT | PENDING_APPROVAL | APPROVED | PAID | EXPORTED
  totalGross Decimal, totalBill Decimal, totalMargin Decimal
  items PayrollItem[]
  approvedById?
}

model PayrollItem {
  id, payrollRunId, workerId, assignmentId
  regularHours, otHours, regularPay, otPay, perDiem, bonus, grossPay
  billAmount, margin
}

model Invoice {
  id, tenantId, companyId, number String @unique
  periodStart, periodEnd, subtotal, total
  status        // DRAFT | SENT | PAID | OVERDUE | VOID
  lines InvoiceLine[]
  pdfUrl String?
}

model Contract {
  id, tenantId, companyId, fileUrl, signedDate?, expirationDate?,
  markupPercent Decimal?, terms Json, status
}
```

### 2.7 Agentes IA, auditoría y eventos

```prisma
model AgentDefinition { // catálogo: Recruiter, Compliance, Sales...
  id, key String @unique, name, description, systemPromptTemplate,
  availableTools Json, defaultAutonomy AutonomyLevel
}

model AgentInstance {   // el agente "contratado" por un tenant
  id, tenantId, definitionId
  autonomyLevel   // MANUAL | ASSISTED | SEMI_AUTO | AUTO_WITH_APPROVAL | FULL_AUTO
  config Json, isActive Boolean
  metrics Json          // KPIs del agente: tareas completadas, precisión, etc.
}

model AgentTask {
  id, tenantId, agentInstanceId
  type, input Json, output Json?, status // QUEUED | RUNNING | AWAITING_APPROVAL | DONE | FAILED
  triggeredBy   // USER | EVENT | AGENT | SCHEDULE
  parentTaskId?         // cadenas de colaboración entre agentes
  tokensUsed Int?, costUsd Decimal?      // control de costos de IA
  createdAt, completedAt?
}

model AgentMemory {
  id, tenantId, agentInstanceId
  scope         // GLOBAL | ENTITY (ej: memoria sobre un cliente específico)
  entityType?, entityId?
  content String, embedding Unsupported("vector")?  // pgvector
  importance Float, lastAccessedAt
}

model ApprovalRequest {
  id, tenantId, agentTaskId
  summary String, proposedAction Json, riskLevel
  status // PENDING | APPROVED | REJECTED | EXPIRED
  decidedById?, decidedAt?, decisionNote?
}

model AuditLog {        // inmutable, append-only
  id, tenantId, actorType // HUMAN | AGENT | SYSTEM
  actorId, action, entityType, entityId
  before Json?, after Json?, ip?, createdAt
  @@index([tenantId, entityType, entityId])
}

model DomainEvent {     // outbox
  id, tenantId, type, payload Json, processedAt?, createdAt
}
```

### 2.8 Pricing Intelligence

```prisma
model LaborBurdenConfig {   // costos laborales estimados, por estado y categoría
  id, tenantId, state, jobCategoryId?
  workersCompRate Decimal   // % sobre payroll, según class code
  ficaRate Decimal @default(7.65)
  futaRate, sutaRate Decimal
  liabilityRate Decimal?, otherCostsPerHour Decimal?
  effectiveDate DateTime
}

model RateBenchmark {       // tarifas de mercado: internas acumuladas + externas
  id, tenantId?             // null = benchmark global compartido
  source        // INTERNAL_PLACEMENTS | BLS_OES | JOB_BOARDS | MANUAL
  jobCategoryId, city?, state, shiftType? // DAY | NIGHT | WEEKEND
  payRateP25, payRateP50, payRateP75 Decimal
  billRateP50 Decimal?
  sampleSize Int?, capturedAt DateTime
  @@index([jobCategoryId, state, shiftType])
}

model PricingScenario {     // cada recomendación/simulación queda registrada
  id, tenantId
  jobOrderId? | opportunityId? | companyId?
  inputs Json               // volumen, urgencia, turno, dificultad, duración
  recommendedPayMin, recommendedPayMax Decimal
  recommendedBillMin, recommendedBillMax Decimal
  grossMarginPerHour, netMarginPerHour Decimal
  hiringRisk    // LOW | MEDIUM | HIGH
  rationale String          // explicación auditable del agente
  status        // DRAFT | PRESENTED | ACCEPTED | REJECTED
  decidedById?, createdByAgentTaskId?
}
```

**Notas de diseño:**
- `pgvector` en PostgreSQL para memoria semántica de agentes y búsqueda de candidatos por similitud (sin agregar una base vectorial externa en el MVP).
- Tarifas siempre como `Decimal`, nunca `Float`.
- Todo lo configurable (industrias, categorías, tipos de documento, etapas de pipeline) es **data, no código**.

---
## 3. Flujos entre agentes

### 3.1 Modelo de orquestación

**No es un enjambre libre de agentes conversando.** Es un sistema **event-driven con orquestación explícita**:

1. Un **evento de dominio** ocurre (ej. `jobOrder.created` con 80 trabajadores).
2. El **Orchestrator** (código determinista, no IA) consulta las reglas de flujo activas y crea `AgentTask`s para los agentes suscritos.
3. Cada agente ejecuta su tarea con el patrón **ReAct + tools**: recibe contexto → razona → llama herramientas (queries a la DB, envío de emails, creación de registros) → produce resultado.
4. El resultado puede: (a) completarse solo, (b) emitir nuevos eventos que activan a otros agentes, o (c) generar un `ApprovalRequest` si su nivel de autonomía lo exige.
5. Todo queda encadenado por `parentTaskId` → la "conversación" entre agentes del ejemplo del master prompt es en realidad una **cadena de tareas auditable**, visualizable en el AI Agents Center como timeline.

Esto es deliberado: los flujos críticos de negocio no pueden depender de que dos LLMs "se entiendan chateando". La IA razona dentro de cada paso; la coordinación entre pasos es determinista y auditable.

### 3.2 Flujo canónico: nueva vacante grande

```
EVENTO: jobOrder.created (80 workers, Forklift, Indiana)
│
├─→ Pricing Agent [F4]
│     TOOLS: historial interno + benchmarks (BLS/manuales) + labor burden
│     RESULTADO: pay $18–21/h, bill $26–32/h, margen bruto $8–11/h,
│                margen neto est. $5.20–7.80/h, riesgo de contratación: medio
│     → recomendación con rationale al owner del deal (nunca fija la tarifa)
│
├─→ Recruiter Agent
│     TOOL: searchCandidates(category, location, radius, compliance=any)
│     RESULTADO: 62 disponibles, 18 faltantes
│     EMITE: talent.gap.detected { needed: 18 }
│
├─→ (talent.gap.detected) → Marketing Agent [Fase 6]
│     PROPONE: campaña Indeed + Facebook para forklift en Indiana
│     → ApprovalRequest (gasto de dinero = siempre requiere aprobación)
│
├─→ (candidatos nuevos registrados) → Recruiter Agent
│     screening automático de CVs, aiScore, shortlist
│     EMITE: candidates.shortlisted
│
├─→ Compliance Agent
│     verifica documentos requeridos por el JobOrder (forklift cert, drug test)
│     RESULTADO: 17 compliant, 4 bloqueados con alerta específica
│     EMITE: workers.cleared
│
├─→ Operations Agent [Fase 4]
│     genera propuesta de asignaciones + horarios
│     → ApprovalRequest (asignar personas = AUTO_WITH_APPROVAL por defecto)
│
├─→ Payroll Agent [Fase 4]
│     al aprobarse: crea estructura de time tracking, valida tarifas vs contrato
│
└─→ CEO Agent [Fase 4]
      resumen ejecutivo: fill rate, margen proyectado, riesgo
```

### 3.3 Herramientas (tools) por agente

Cada agente tiene un conjunto cerrado de tools tipadas (function calling de OpenAI). Ejemplos:

| Agente | Tools (muestra) |
|---|---|
| Recruiter | `searchCandidates`, `parseResume`, `scoreCandidate`, `draftMessage`, `scheduleInterview`, `createShortlist` |
| Compliance | `extractDocumentData`, `checkExpirations`, `verifyRequirements`, `blockWorker`, `createAlert` |
| Assistant | `queryMetrics`, `searchEntities`, `explainRecord`, `generateReport` (solo lectura en MVP) |
| Sales [F4] | `searchCompanies`, `enrichContact`, `draftOutreach`, `updatePipeline`, `logActivity` |
| Operations [F4] | `proposeAssignments`, `buildSchedule`, `findReplacement`, `notifySupervisor` |
| Payroll [F4] | `validateTimeEntries`, `draftPayrollRun`, `calculateMargins`, `draftInvoice` |
| Pricing [F4] | `getInternalRateHistory`, `getMarketBenchmarks`, `estimateLaborBurden`, `recommendRates`, `simulateScenario`, `flagUncompetitiveRate` |
| CEO [F4] | `analyzeMetrics`, `compareAgentPerformance`, `generateExecutiveReport` |

**Regla de oro:** las tools que escriben datos pasan por los mismos services y validaciones que usan los humanos. Un agente jamás ejecuta SQL directo.

### 3.4 Matriz de autonomía por tipo de acción

| Acción | Autonomía máxima permitida |
|---|---|
| Leer datos, generar análisis y reportes | FULL_AUTO |
| Crear registros internos (leads, shortlists, alertas) | FULL_AUTO |
| Enviar mensajes a candidatos (plantillas aprobadas) | AUTO_WITH_APPROVAL → FULL_AUTO configurable |
| Enviar emails a clientes | AUTO_WITH_APPROVAL |
| Bloquear/desbloquear trabajadores | AUTO_WITH_APPROVAL |
| Decisiones de selección/rechazo de candidatos | **SIEMPRE requiere humano** (riesgo legal EEOC) |
| Asignar trabajadores a proyectos | AUTO_WITH_APPROVAL |
| Aprobar payroll runs | **SIEMPRE humano** |
| Fijar tarifas finales bill/pay (contratos, job orders) | **SIEMPRE humano** — el Pricing Agent solo recomienda y explica |
| Gastar dinero (ads, herramientas) | **SIEMPRE humano** |
| Firmar/modificar contratos | **SIEMPRE humano** |

### 3.5 Principio de autonomía progresiva (agregado en F4, permanente)

Esta sección formaliza — y en un punto corrige la nomenclatura de — la matriz de §3.4. Es un principio **permanente**, aplicable a todo agente presente y futuro, no una decisión de una sola fase.

**Los cuatro niveles:**

| Nivel | Nombre | Qué puede hacer | Valor de `AutonomyLevel` |
|---|---|---|---|
| 1 | **Asistido** | Analiza y propone. Ninguna escritura ocurre sin que un humano dispare esa acción puntual, ni siquiera un registro interno. | `ASSISTED` |
| 2 | **Semiautónomo** | Ejecuta automáticamente acciones internas (crear un lead, calificar una empresa, planificar una secuencia). Toda acción externa exige `ApprovalRequest`. | `SEMI_AUTO` |
| 3 | **Autónomo supervisado** | Puede ejecutar automáticamente acciones que antes exigían aprobación individual, **si una política explícita ya las pre-aprobó** para ese tipo de acción/tenant. Sigue respetando presupuesto, frecuencia, cumplimiento y auditoría. | `AUTO_WITH_APPROVAL` |
| 4 | **Autónomo completo** | Puede trabajar horas sin intervención humana y debe cerrar con un reporte ejecutivo. Sigue respetando siempre las políticas configuradas — nivel 4 no significa "sin aprobación jamás", significa "sin que un humano supervise cada paso intermedio". | `FULL_AUTO` |

(`MANUAL`, quinto valor ya existente en el enum desde F0, queda como **Nivel 0** no nombrado en el pedido original: el agente ni siquiera analiza por su cuenta — cada invocación, incluida la de solo lectura, la dispara un humano explícitamente. Reservado para un agente recién creado sin historial todavía, antes de subir a Nivel 1.)

**Corrección de nomenclatura necesaria (hallazgo, no un cambio de comportamiento):** todo agente real construido hasta F4 (Sales, Prospecting, Market Intelligence, y los nuevos de F4: Campaign, Outreach, Conversation) **se comporta hoy, en la práctica, como Nivel 2 (Semiautónomo)** — ejecuta acciones internas automáticamente y solo lo externo pasa por `ApprovalRequest` — aunque su columna `AgentInstance.autonomyLevel`/`AgentDefinition.defaultAutonomy` diga `ASSISTED` (Nivel 1) por una imprecisión de nomenclatura heredada desde F0. Esto **no es un problema de seguridad**: el mecanismo que de verdad decide qué requiere aprobación es la matriz de §3.4, implementada en código como `ApprovalGate.ts` (`requiresApproval(toolName)`), no el valor declarado de autonomía — ese valor ha sido, hasta ahora, puramente descriptivo/informativo, sin ningún efecto en runtime. F4 corrige el dato (`ASSISTED` → `SEMI_AUTO`) para los agentes existentes y nuevos, sin ningún cambio de comportamiento — es una corrección de precisión, no una migración de política.

**El CEO Agent es el dueño de la política, no cada agente individual.** La decisión de qué nivel tiene permitido cada agente **no se codifica dentro de la definición de ese agente** (`packages/agents/src/definitions/*.agent.ts`) — vive como una política configurable que el CEO Agent (o un humano con el permiso adecuado) puede leer y ajustar. El campo que la sostiene ya existe desde F0 y no necesita ningún cambio de schema: `AgentInstance.autonomyLevel` (el nivel vigente) + `AgentInstance.config` (Json, ya libre de forma — puede alojar límites asociados a una promoción de nivel, como tope de costo/frecuencia, sin agregar columnas).

**Camino de implementación progresiva, F4 → F8 (no se construye todo de una vez):**
- **F4:** se documenta el principio, se corrige la nomenclatura (`SEMI_AUTO` real para los agentes existentes/nuevos), y **no se construye ningún mecanismo nuevo de enforcement** — `ApprovalGate.ts` sigue siendo la tabla estática de §3.4, sin leer todavía `autonomyLevel` en runtime. La Daily Revenue Mission (ver `F4_AUTONOMOUS_OUTREACH_PLAN.md`) es el primer flujo que **se comporta** como Nivel 4 (horas sin intervención, reporte ejecutivo de cierre) sin que ningún agente individual cambie de nivel declarado — la autonomía de nivel 4 aplica a la *misión como orquestación*, no a un agente que de repente deja de necesitar aprobaciones.
- **F5–F7 (candidatos naturales, a definir en su momento):** `ApprovalGate.ts` empieza a leer `AgentInstance.autonomyLevel` real antes de aplicar la tabla estática de §3.4 — un agente en Nivel 3 para un tipo de acción específico (ej. "reenviar el seguimiento del día 4 de una secuencia ya aprobada una vez para esa campaña") deja de generar una `ApprovalRequest` nueva cada vez, siempre que la política de ese nivel lo cubra explícitamente.
- **F8 (o cuando el historial de precisión lo justifique — mismo criterio que ya declaraba el riesgo #11 original de este documento):** un agente puede promoverse a Nivel 4 para un conjunto acotado de acciones, con presupuesto/frecuencia/cumplimiento como límites duros, nunca removibles por el propio agente.

Ningún nivel, en ningún punto de este camino, remueve la frontera ya establecida desde F2: **fijar tarifas, firmar contratos, aprobar payroll, rechazar candidatos y gastar dinero siguen "SIEMPRE humano" sin excepción** (última fila de §3.4) — la autonomía progresiva sube el techo de lo que se auto-ejecuta dentro de lo que la matriz ya permite, nunca reescribe la matriz misma.

---

## 4. Roles y permisos

### 4.1 Modelo RBAC + scopes

- Permisos atómicos con formato `recurso.acción`: `candidates.view`, `candidates.create`, `payroll.approve`, `agents.configure`, `invoices.send`...
- Roles = conjuntos de permisos, editables por tenant. Roles semilla: CEO, Admin, Recruiter, Sales, Payroll, Compliance, Operations, Marketing, HR, Accounting, Manager.
- **Los agentes IA también tienen un rol** con permisos: el Recruiter Agent tiene los permisos de un Recruiter humano menos los marcados como `humanOnly`. El middleware RBAC no distingue si el actor es humano o agente — mismo enforcement.
- Scopes adicionales: por sucursal/región (Fase 7) para agencias con múltiples oficinas.

### 4.2 Matriz resumida (MVP)

| Permiso | CEO | Admin | Recruiter | Compliance | Payroll | Sales |
|---|---|---|---|---|---|---|
| Dashboard completo | ✔ | ✔ | parcial | parcial | parcial | parcial |
| Candidates CRUD | ✔ | ✔ | ✔ | ver | — | — |
| Compliance verify/block | ✔ | ✔ | — | ✔ | — | — |
| Payroll draft | ✔ | ✔ | — | — | ✔ | — |
| Payroll approve | ✔ | — | — | — | ✔* | — |
| Invoices | ✔ | ✔ | — | — | ✔ | ver |
| CRM / Leads | ✔ | ✔ | — | — | — | ✔ |
| Agents configure | ✔ | ✔ | — | — | — | — |
| Approvals (bandeja) | según dominio del approval | | | | | |

*separación de funciones: quien crea el run no puede ser el único aprobador (configurable).

---

## 5. Experiencia de usuario

### 5.1 Principios de diseño

- Referencias: Linear (velocidad, densidad, teclado), Stripe (claridad de datos financieros), Notion (flexibilidad), Vercel (estética dark).
- Tokens de diseño propios: tipografía Inter/Geist, radios suaves, sombras sutiles, acento único (violeta/azul eléctrico), modo claro y oscuro con `next-themes`-style toggle.
- Animaciones con Framer Motion: transiciones de página, listas, y **actividad de agentes en vivo** (el diferenciador visual del producto).
- Command palette (⌘K) global: buscar cualquier entidad o pedirle algo a un agente desde cualquier pantalla.

### 5.2 Estructura de navegación

```
Sidebar
├── Dashboard
├── CRM (Companies, Contacts, Leads, Pipeline)
├── Job Orders
├── Talent (Candidates, Workers)
├── Operations (Projects, Assignments, Schedule)
├── Compliance (Documents, Alerts, Audits)
├── Payroll (Time, Runs, Reports)
├── Billing (Invoices, Contracts)
├── AI Agents Center ★
├── Reports & Analytics
└── Settings (Users, Roles, Industries, Categories, Notifications)

Barra superior: búsqueda ⌘K · bandeja de Approvals · notificaciones · chat IA (drawer)
```

### 5.3 AI Agents Center (pantalla estrella)

- Grid de agentes tipo "tarjetas de empleado": avatar, estado (activo/trabajando/idle), nivel de autonomía, KPIs (tareas hoy, precisión, costo IA del mes).
- Al abrir un agente: timeline de tareas, cadenas de colaboración (visualización del flujo Sales→Recruiter→Compliance...), memoria consultable, configuración de autonomía con explicación de cada nivel.
- **Bandeja de aprobaciones** unificada: cada ApprovalRequest muestra qué propone el agente, por qué, datos de soporte, y botones Aprobar / Rechazar / Editar y aprobar.

### 5.4 Chat IA

- Drawer lateral disponible en toda la app (patrón Cursor/Copilot), no una página aislada.
- Enrutamiento: el mensaje va al Assistant Agent, que decide si responde él o delega a un agente especializado ("Recruiter, encuentra 25 General Labor bilingües en Chicago" → crea AgentTask del Recruiter y transmite progreso por WebSocket).
- Respuestas con **componentes ricos**: tablas de candidatos con acciones, gráficos, links a registros — no solo texto.

---

## 6. Arquitectura de IA

### 6.1 Capa de abstracción

```
packages/agents/
  core/
    LLMProvider.ts        → interfaz (OpenAI hoy; Anthropic/otros mañana)
    AgentRuntime.ts       → loop ReAct: prompt → tool calls → resultado
    ToolRegistry.ts       → tools tipadas con Zod, permisos por tool
    MemoryManager.ts      → lectura/escritura de AgentMemory + pgvector
    Orchestrator.ts       → suscripciones evento→agente, cadenas de tareas
    ApprovalGate.ts       → evalúa autonomía vs riesgo de la acción
    CostTracker.ts        → tokens y USD por tarea/agente/tenant
  definitions/
    recruiter.agent.ts
    compliance.agent.ts
    assistant.agent.ts
    pricing.agent.ts
    ...
```

### 6.2 Memoria por agente

Tres niveles:
1. **Contexto de tarea:** el input + datos frescos de la DB (siempre la fuente de verdad — la memoria nunca sustituye un query).
2. **Memoria semántica (pgvector):** aprendizajes persistentes ("el cliente X prefiere trabajadores con OSHA 30", "los candidatos de la fuente Y tienen alta rotación"). Con scoring de importancia y decay.
3. **Métricas propias:** cada agente conoce su desempeño histórico para autoevaluarse en reportes.

### 6.3 Control de costos y calidad

- Presupuesto de tokens por tenant/mes con alertas y cutoff.
- Modelo pequeño para clasificación/extracción rutinaria; modelo grande solo para razonamiento complejo (routing por tipo de tarea).
- Evals automatizados por agente: dataset de casos dorados (CVs de prueba, documentos de prueba) que corre en CI — un cambio de prompt no se despliega si baja la precisión.
- Guardrails: outputs de agentes validados con Zod antes de tocar la DB; reintentos con feedback del error.

### 6.4 Cumplimiento legal de la IA (no opcional)

- **EEOC / Title VII:** ningún agente rechaza candidatos de forma autónoma. La IA rankea y explica; el humano decide. El `aiScoreReason` siempre visible y auditable.
- **Illinois AIVIA:** si en el futuro se agregan entrevistas en video con IA, se requiere consentimiento explícito y disclosure (tú operas desde Illinois — esto aplica directo).
- **NYC Local Law 144:** si se venden cuentas en NYC, las herramientas automatizadas de decisión de empleo requieren auditoría de sesgo anual — diseñar el logging de scores desde ya para poder auditarlo.
- **TCPA:** mensajes SMS a candidatos solo con opt-in registrado y opt-out funcional.
- Retención de registros de selección: mínimo 1–2 años (EEOC/ADEA) — el AuditLog lo cubre.

### 6.5 Pricing Intelligence Agent — lógica de recomendación

Híbrido de **cálculo determinista + razonamiento LLM**, en ese orden:

1. **Base determinista (código, no IA):** pay rate base = P50 del benchmark más específico disponible (categoría + ciudad + turno → categoría + estado → benchmark global), con ajustes reglados: turno nocturno +10–15%, urgencia alta +5–10%, escasez de candidatos detectada por el Recruiter Agent +X%. Bill rate = pay × markup del contrato/target del tenant, validado contra `billRateP50` de mercado.
2. **Margen neto determinista:** `neto/h = bill − pay − (pay × burden%) − otherCostsPerHour`, usando `LaborBurdenConfig` del estado y class code.
3. **Capa LLM encima:** interpreta contexto no estructurado (notas del cliente, historial de la relación, señales de competencia), redacta el `rationale`, asigna riesgo de contratación y propone la recomendación puntual dentro del rango calculado.
4. **Salida:** `PricingScenario` persistido con rangos, margen bruto y neto, riesgo, confianza de datos (según sampleSize y antigüedad del benchmark) y explicación — presentado al humano, que decide.

El LLM nunca inventa números fuera de los rangos calculados en (1)–(2); solo posiciona y explica dentro de ellos. Los cálculos de dinero son siempre código testeable.

---

## 7. Diseño de APIs

### 7.1 Convenciones

- REST versionado: `/api/v1/...`, JSON, camelCase.
- Validación Zod en entrada y salida (contratos compartidos en `packages/shared` — el frontend importa los mismos tipos).
- Paginación por cursor, filtros estandarizados, respuestas de error uniformes `{ error: { code, message, details } }`.
- Rate limiting por tenant. Idempotency keys en endpoints de escritura sensibles (payroll, invoices).

### 7.2 Superficie principal (extracto)

```
POST   /api/v1/auth/webhook (Clerk)
GET    /api/v1/dashboard/summary

CRUD   /api/v1/companies · /contacts · /leads · /opportunities
CRUD   /api/v1/job-orders          + POST /:id/match  (Recruiter Agent)
CRUD   /api/v1/candidates          + POST /:id/parse-resume
POST   /api/v1/candidates/:id/convert-to-worker
CRUD   /api/v1/workers · /projects · /assignments · /shifts
CRUD   /api/v1/time-entries        + POST /bulk-approve

CRUD   /api/v1/documents           + POST /:id/verify
GET    /api/v1/compliance/alerts

POST   /api/v1/payroll/runs        + POST /:id/approve  + GET /:id/export
CRUD   /api/v1/invoices            + POST /:id/send · /:id/pdf

GET    /api/v1/agents              · PATCH /:id (autonomía, config)
POST   /api/v1/agents/:key/tasks   (invocar agente)
GET    /api/v1/agents/tasks/:id    (estado + cadena)
GET    /api/v1/approvals           · POST /:id/decide
POST   /api/v1/chat/messages       (Assistant Agent, streaming SSE)

GET    /api/v1/audit-logs · /reports/* · /analytics/*
```

WebSocket namespaces: `/tenant/{id}` con eventos `agent.task.update`, `approval.created`, `notification`, `chat.delta`.

---

## 8. Roadmap por fases

| Fase | Nombre | Contenido | Duración est.* |
|---|---|---|---|
| **F0** | Fundaciones | Monorepo, Docker, CI, Clerk multi-org, Prisma schema completo, RBAC, tenancy middleware, layout + design system, seed data | 2–3 sem |
| **F1** | Core Staffing | Companies, Contacts, Job Orders, Candidates (con CV upload), Workers, Projects, Assignments, dashboard v1 | 3–4 sem |
| **F2** | Compliance + Time | DocumentTypes, Documents, verificación manual, alertas de vencimiento, TimeEntries, aprobación de horas | 2–3 sem |
| **F3** | AI Agents v1 ★ | AgentRuntime + tools + memoria, **Recruiter Agent** (parse CV, scoring, matching), **Compliance Agent** (extracción de docs, alertas), **Assistant Agent** (chat con datos), AI Agents Center UI, ApprovalRequests | 4–5 sem |
| **F4** | Orquestación + Ops/Payroll/Pricing/CEO Agents | Orchestrator event-driven, Operations Agent, Payroll runs + Payroll Agent, **Pricing Intelligence Agent** (benchmarks BLS + burden config + simulador de escenarios), Invoices PDF, CEO Agent con reportes ejecutivos | 4–5 sem |
| **F5** | Ventas + Facturación pro | Sales Agent, pipeline CRM completo, integración payroll externo (Check/Gusto Embedded), pagos de invoices (Stripe) | 4 sem |
| **F6** | Marketing + Integraciones | Marketing Agent, publicación en Indeed/LinkedIn, campañas, Twilio SMS con opt-in TCPA | 3–4 sem |
| **F7** | SaaS multi-tenant | Onboarding self-service de agencias, planes y billing de la plataforma, aislamiento reforzado, SOC 2 readiness, observabilidad | 4–6 sem |

*Estimaciones con Claude Code a ritmo sostenido; F0–F3 = MVP demostrable y vendible (~3 meses).

**Definition of Done por fase:** tests automatizados pasando, seed data realista, verificación en navegador real, migraciones limpias, sin TODOs críticos.

---

## 9. Riesgos

### Técnicos
1. **Orquestación multi-agente es el mayor riesgo de ingeniería.** Mitigación: coordinación determinista por eventos (no chat libre entre LLMs), cadenas auditables, evals en CI.
2. **Costos de OpenAI descontrolados.** Mitigación: CostTracker por tarea, routing de modelos, presupuestos por tenant, cachear extracciones.
3. **Aislamiento multi-tenant.** Mitigación: filtro de tenant a nivel de Prisma extension + tests específicos de fuga de datos.
4. **Precisión de extracción de documentos** (I-9, certificaciones). Mitigación: siempre human-in-the-loop para verificación final en MVP; la IA pre-llena, el humano confirma.

### Legales (los más serios de este producto)
5. **Discriminación algorítmica en contratación** (EEOC, IL AIVIA, NYC LL144). Mitigación: la IA nunca rechaza sola; logs de scores; auditorías de sesgo planificadas.
6. **Payroll/impuestos:** errores de nómina generan responsabilidad directa. Mitigación: MVP solo calcula horas y márgenes; el tax engine se delega a proveedor certificado en F5.
7. **Clasificación W2 vs 1099** (riesgo de misclassification). Mitigación: campo explícito + warnings, sin automatización de esa decisión.
8. **TCPA/CAN-SPAM** en outreach automatizado. Mitigación: opt-in/opt-out obligatorio en el modelo de datos desde F0.
9. **Privacidad de datos de candidatos** (BIPA en Illinois si algún día hay biometría — evitarla). Encriptación en reposo, PII minimizada en prompts a OpenAI, DPA con proveedores.

### Operativos / de producto
10. **Scope creep** — este documento existe para eso: nada fuera de la fase activa entra sin actualizar el roadmap.
11. **Confianza del usuario en agentes:** si un agente falla feo al inicio, el usuario apaga la IA. Mitigación: lanzar agentes en modo ASSISTED por defecto y subir autonomía con historial de precisión — este es, literalmente, el "Principio de autonomía progresiva" formalizado en §3.5 (agregado en F4).
12. **Competencia** (Bullhorn, Avionté, Tempworks + copilots): el diferenciador es la orquestación de agentes con aprobaciones, no "un chatbot más" — proteger ese foco.
13. **Cold start de datos de pricing:** sin historial de colocaciones, el Pricing Agent no tiene datos internos. Mitigación: benchmarks públicos de BLS OES (por ocupación y área metro) + carga manual de tarifas conocidas del mercado; el peso del historial interno crece automáticamente con cada colocación. El agente debe declarar la confianza de cada recomendación según la calidad de datos disponible.

---

## 10. Próximos pasos (al aprobar este documento)

1. Congelar el schema Prisma completo de F0 (expandir §2 a schema real).
2. Redactar el prompt de arranque para Claude Code: F0 con estructura de monorepo exacta, convenciones y Definition of Done.
3. Definir los 3 system prompts iniciales (Recruiter, Compliance, Assistant) y sus datasets de eval.
4. Crear el design system base (tokens, componentes shadcn personalizados) antes de la primera pantalla.

**Regla de trabajo:** parches quirúrgicos, leer el estado exacto de archivos antes de cambiar, nada se declara "listo" sin verificación en navegador real.
