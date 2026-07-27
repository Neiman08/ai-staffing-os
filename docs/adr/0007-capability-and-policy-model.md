# ADR-0007: Modelo de capacidades como validación en código, no una tabla RBAC nueva

- Estado: Aceptado
- Fecha: 2026-07-23
- Fase: F25

## Contexto

Auditoría F25 Fase A: la autorización hoy es 100% RBAC humano
(`packages/shared/src/permissions.ts`, `{resource}.{action}` +
llaves especiales). `AgentDefinition.availableTools` existe como
columna `Json` pero **nunca se lee para autorizar nada** — qué tools
puede correr un agente es un `if (agentKey === "sales")` hardcodeado en
`task-executor.ts`. La instrucción maestra pide que cada
`AgentDefinition` declare capacidades y que un `PolicyEnvelope` por
tenant/misión limite acción, volumen, costo y territorio.

## Decisión

- **`AgentCapability`** es un enum/union de TypeScript (no una tabla
  nueva) — el catálogo cerrado de acciones que un agente puede pedir
  hacer (`DISCOVER_COMPANY`, `SEND_EMAIL`, `BOOK_MEETING`, etc., ver
  catálogo completo en el master doc). Vive en
  `packages/agents/src/core/AgentCapability.ts`.
- **`AgentDefinition.availableTools`** (columna `Json` que YA existe,
  hoy inerte) pasa a poblarse con una lista de `AgentCapability` reales
  — sin migración, es la misma columna, solo empieza a tener contenido
  significativo y (en una fase posterior, F25.5+) a enforced-earse.
- **`PolicyEnvelope`** es un schema Zod (no una tabla nueva) —
  `autonomyLevel, dailyEmailLimit, perDomainLimit, allowedIndustries,
  allowedRegions, approvedSenderIdentity, allowedSendWindows,
  contactVerificationRequirement, humanApprovalRequirement,
  meetingBookingPermission, replyAutomationPermission, maxLLMCost,
  maxDiscoveryCost, maxEnrichmentAttempts, prohibitedActions`. Se
  persiste como `Json` dentro de `Tenant.settings` (ya existe,
  patrón ya usado hoy para `aiMonthlyBudgetUsd`/`activeIndustries`) —
  no una tabla nueva, mismo lugar donde ya vive la configuración de
  tenant.
- **La verificación de capacidad** (`¿este agente puede pedir
  `SEND_EMAIL`?`) es una función pura
  `hasCapability(definition, capability): boolean`, análoga en espíritu
  a `evaluateDraftCreationGate`/`evaluateApprovalQualityGate` (F24) —
  determinista, testeable sin DB, nunca un LLM decidiendo autorización.

## Alternativas consideradas

1. **Tabla `AgentCapabilityGrant` (M:N AgentDefinition↔Capability) al
   estilo RBAC humano.** Rechazado por ahora — el catálogo de
   capacidades es pequeño y estable (no cambia por usuario ni requiere
   UI de asignación dinámica como sí la necesita RBAC humano);
   `availableTools: Json` ya resuelve esto sin tabla nueva. Puede
   promoverse a tabla relacional más adelante si aparece necesidad real
   de gestionarlo desde UI.
2. **Extender el RBAC humano existente para cubrir agentes.**
   Rechazado — RBAC humano es sobre `User.permissions[]` en el contexto
   de un login; un agente no tiene un `User`. Mezclar los dos modelos
   (autorización de humanos vs. autorización de agentes) generaría
   confusión sobre qué lista gobierna qué, exactamente el tipo de
   acoplamiento implícito que el principio #15 prohíbe.
3. **`PolicyEnvelope` como tabla propia.** Rechazado por ahora —
   `Tenant.settings: Json` ya es el lugar establecido para
   configuración de tenant (`aiMonthlyBudgetUsd`,
   `dataProviderBudgetUsd`, `activeIndustries`,
   `prospectingSweepIntervalHours`, `lastProspectingSweepAt`, todos ya
   ahí); agregar `PolicyEnvelope` al mismo objeto es consistente y no
   requiere migración. Si el envelope crece lo suficiente para
   necesitar su propio versionado/auditoría de cambios independiente
   del resto de `settings`, promoverlo a tabla es un cambio aditivo
   futuro sin romper el contrato Zod.

## Consecuencias

- Cero migraciones para el modelo de capacidades/políticas en esta
  sesión — todo vive en columnas `Json` que ya existen
  (`availableTools`, `Tenant.settings`).
- El enforcement real (F25.5, dentro del Orchestrator) es la primera
  vez que `hasCapability`/`PolicyEnvelope` se consultan de verdad antes
  de ejecutar una tarea — hasta entonces, declarar sin enforced es
  seguro (no cambia comportamiento productivo, cumple la restricción de
  esta sesión).
