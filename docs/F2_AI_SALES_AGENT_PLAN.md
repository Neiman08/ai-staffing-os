# F2 — AI Sales Agent — Propuesta Técnica

**Estado:** F2 completada y verificada.
**Precedente:** F0 y F1 completados y verificados (`docs/F0_COMPLETION_REPORT.md`, `docs/F1_REVENUE_ENGINE_PLAN.md`). Este plan no rompe nada de F0 ni F1 — todos los cambios son aditivos.

---

## 0. Prerrequisito antes de poder implementar

F2 es la primera fase que llama a un proveedor de LLM real. Antes de escribir código hace falta:

- Una **`OPENAI_API_KEY`** provista por el Product Owner (no existe hoy en el proyecto — `env.ts` la va a validar como obligatoria solo si `AUTH_MODE`/feature flag de IA está activo, para no romper F0/F1 en entornos sin la key).
- Confirmación de un **presupuesto mensual** de referencia (ver §16) — propongo un default conservador ($20–50 USD/mes) hasta que el PO indique otro número.

Sin la key, todo lo demás de este plan se puede construir e incluso probar con un `LLMProvider` falso (fixture), pero no se puede dar por "hecho" el DoD sin al menos una corrida real contra OpenAI.

---

## 1. Objetivo de F2

Dar vida real al **Sales Agent** que F1 dejó como esqueleto tipado (`packages/agents/src/tools/sales-tools.ts`, `sales.agent.ts`) para que ayude activamente a **conseguir clientes**: encontrar empresas candidatas, calificarlas con una razón auditable, crear leads en el CRM, identificar contactos relevantes y preparar borradores de contacto — sin enviar nada ni contactar a nadie de forma autónoma. Es el primer punto del producto donde se activa la capa de IA real prevista desde la Arquitectura (§6), y se hace de la forma más conservadora posible: autonomía `ASSISTED`, cero acciones externas sin aprobación humana explícita.

---

## 2. Alcance exacto

**Incluye:**
- Implementación real de `LLMProvider` (OpenAI) detrás de la interfaz ya definida en F0.
- `AgentRuntime` real (loop ReAct: prompt → tool calls → resultado), reemplazando el `NotImplementedError` actual.
- Las 7 tools de `sales-tools.ts` con lógica real, cada una llamando a los mismos `service.ts` que ya usan los humanos (regla de oro, Arquitectura §3.3 — ninguna tool toca la base de datos directamente).
- `CostTracker` y `ApprovalGate` reales (`packages/agents/src/core/`, mencionados en Arquitectura §6.1 pero nunca construidos — F0 solo dejó los 6 archivos que no necesitaban lógica de negocio).
- AI Agents Center funcional: lanzar tareas del Sales Agent, ver su historial, ver cadenas de tareas.
- Bandeja de Approvals funcional (prevista en Arquitectura §5.3, nunca construida).
- Solo el **Sales Agent** recibe comportamiento real. Market Intelligence Agent y Revenue Agent **siguen como stubs** — el objetivo explícito de esta fase es "el primer agente", no los tres.

**No incluye (ver detalle en §4):**
- Envío real de nada (email, LinkedIn, SMS).
- Orquestación event-driven multi-agente (`Orchestrator`, `DomainEvent` workers) — sigue en el roadmap original, no es parte de F2.
- Redis/BullMQ/Socket.io — F2 sigue sin necesitarlos (justificación abajo).
- `AgentMemory`/pgvector — sigue diferido. El Sales Agent en F2 no necesita memoria semántica entre sesiones: cada tarea (buscar, calificar, redactar, sugerir) se resuelve con datos frescos de la base de datos en el momento, que es justo el principio que ya declara la Arquitectura §6.2 ("la memoria nunca sustituye un query"). Memoria de largo plazo ("el cliente X prefiere Y") queda para cuando el agente tenga autonomía más alta y lo necesite de verdad.

**Decisión técnica de ejecución (async sin cola):** las tareas del agente pueden tardar varios segundos (llamadas a OpenAI con tool-calling). En vez de bloquear el request HTTP o introducir Redis/BullMQ, `AgentTask` se crea en estado `QUEUED`, se procesa in-process con un runner simple (una promesa que corre en el mismo proceso Node, sin cola externa), y el frontend hace polling a `GET /agents/tasks/:id` cada 2–3s hasta `DONE`/`FAILED`/`AWAITING_APPROVAL`. Es una limitación consciente: un reinicio del proceso pierde tareas en curso. Aceptable para el volumen de F2 (una agencia, unos pocos usuarios de Sales); se revisita cuando el volumen o el multi-tenant real lo justifiquen (Redis ya está planeado desde F0 para cuando haga falta).

---

## 3. Qué hará el Sales Agent en F2

Sobre las 7 tools ya tipadas en F1, ahora con lógica real:

| Tool | Qué hace en F2 |
|---|---|
| `searchCompanies` | Busca empresas candidatas combinando: Companies del tenant sin trabajar (status LEAD sin actividad reciente), industrias activas del tenant, y empresas cargadas manualmente (ver §5). Devuelve una lista priorizada con razón breve por cada una. |
| `detectHiringSignals` | Busca señales **ya presentes en la base de datos** (JobOrder abierto reciente en la misma industria/zona que una empresa similar, Opportunity ganada recientemente en el mismo sector) + permite que el humano pegue una señal manual (texto libre, ej. "vi un post de LinkedIn"). El agente prioriza, no busca por su cuenta en la web (ver limitación en §5). |
| `identifyContacts` | Busca contactos ya existentes en el CRM con `decisionRole` relevante para la categoría objetivo; si no hay ninguno, sugiere qué rol buscar (ej. "esta empresa necesita un contacto con rol OPERATIONS_MANAGER o HR") sin inventar una persona. |
| `createLead` | Crea un `Lead` real vía el mismo `leadsService.createLead()` que usa un humano, con `aiScoreReason` obligatorio y marcado como generado por IA (ver §6). No requiere aprobación previa (crear un registro interno es `FULL_AUTO` según Arquitectura §3.4). |
| `scoreOpportunity` / calificación de empresa | Calcula un score (0–100) híbrido determinista + LLM (ver §7), con rationale obligatorio. |
| `suggestFollowUp` | Propone (no crea automáticamente) el próximo follow-up para un Lead/Company según su actividad reciente; el humano confirma con un clic. |
| `draftOutreach` | Redacta un borrador de email o mensaje de LinkedIn usando el LLM; nunca se envía, siempre pasa a una `ApprovalRequest` (ver §8–9). |

Todas las tools de lectura/análisis/creación-de-registro-interno se pueden invocar sin aprobación previa; solo `draftOutreach` termina siempre en una aprobación pendiente antes de considerarse "lista para usar".

---

## 4. Qué NO hará todavía

- **No envía correos ni mensajes reales.** No hay integración con ningún proveedor de email (Resend sigue fuera de alcance, como en F0/F1) ni con LinkedIn. `draftOutreach` produce texto, nada más — ni siquiera existe un botón de "enviar" conectado a algo real.
- **No contacta candidatos ni clientes de forma autónoma.**
- **No compra datos de terceros** (Clearbit, ZoomInfo, Apollo, LinkedIn Sales Navigator API, listas de leads compradas, etc.) sin aprobación explícita **del Product Owner sobre el producto**, no del humano en runtime — esto es una decisión de alcance, no una `ApprovalRequest` en la app.
- **No hace scraping** de sitios web de terceros (LinkedIn, Google, directorios). Esta regla es la razón por la que `detectHiringSignals` en F2 es deliberadamente limitado (§5) — se documenta como debilidad conocida, no se rodea con un scraper "liviano" disfrazado.
- **No actúa en autonomía `FULL_AUTO` para nada que salga del tenant.** Autonomía `ASSISTED`/`AUTO_WITH_APPROVAL` únicamente, igual que quedaron configuradas las 3 instancias desde F1.
- **No orquesta agentes entre sí.** Market Intelligence Agent y Revenue Agent no reciben LLM real en F2.
- **No introduce Redis/BullMQ/Socket.io** (justificado en §2).
- **No toca Candidate/Worker/Compliance/Payroll.** El Sales Agent opera exclusivamente en el dominio comercial (Company/Contact/Lead/Opportunity/FollowUp/Activity).
- **No decide precios ni tarifas.** Eso es exclusivo del Pricing Agent (roadmap original, fase futura) — `scoreOpportunity` califica probabilidad de cierre, no toca `estimatedPayRate`/`estimatedBillRate`.
- **No hace fine-tuning ni entrena nada.** Solo llamadas a la API de OpenAI.

---

## 5. Fuentes de datos iniciales para prospectar empresas

Dado que no se permite scraping agresivo ni herramientas pagas sin aprobación, las fuentes de F2 son deliberadamente modestas:

1. **Datos propios del tenant (fuente principal):** Companies existentes sin trabajar, historial de `Activity`, industrias activas, categorías con necesidades detectadas (`JobCategory`).
2. **Carga manual estructurada:** el humano puede pegar una lista de empresas candidatas (nombre, industria, ciudad, estado, sitio web — como JSON/tabla pegada en el frontend, **no upload de archivo**: evita construir infraestructura de subida de archivos que sigue fuera de alcance desde F0). Esto no es scraping — es una entrada explícita y controlada por el humano, que el agente luego prioriza y califica.
3. **Señales manuales de texto libre:** el humano puede pegar una nota ("vi que están contratando en Indeed") que el agente interpreta como input, no como algo que fue a buscar.
4. **APIs públicas gratuitas y legítimas** (BLS/Census, registros comerciales estatales abiertos): se documentan como fuente futura posible, **no se integran en F2** — cualquier integración de terceros, aunque sea gratuita, requiere aprobación explícita del PO antes de construirse, por la regla del usuario de no agregar herramientas sin aprobación previa.

**Limitación conocida y aceptada:** sin una fuente de datos externa aprobada, `searchCompanies`/`detectHiringSignals` en F2 son tan buenos como los datos que el tenant ya tiene o carga manualmente. Es una limitación real, no un defecto oculto — se declara así en el DoD y es candidato natural para una fase futura una vez que el PO apruebe una fuente de datos concreta.

---

## 6. Cómo creará leads en el CRM

- La tool `createLead` llama a `leadsService.createLead()` — el mismo código que usa el endpoint humano `POST /api/v1/leads`. Ninguna tool ejecuta SQL directo (regla de oro, Arquitectura §3.3).
- **Cambio de schema necesario:** `Lead.createdByAgentTaskId String?` (nuevo, sin `@relation` — mismo patrón que `PricingScenario.createdByAgentTaskId`, que ya existe desde F0). Esto marca de forma inequívoca y consultable qué leads son AI-generated, y permite trazar cada uno hasta la tarea/razonamiento que lo creó.
- El frontend muestra un badge **"AI"** en `Leads.tsx` y `LeadDetail.tsx` cuando `createdByAgentTaskId` no es nulo.
- `Lead.aiScoreReason` (ya existe desde F0) es **obligatorio** al crear un lead por IA — un lead AI-generated sin rationale se trata como bug, no como caso válido.
- Autonomía: crear un Lead es "crear registro interno" → `FULL_AUTO` según la matriz de Arquitectura §3.4, así que no requiere `ApprovalRequest` previa. Sí queda completamente auditado: `AgentTask` (input/output/tokens/costo) + `AuditLog` + una `Activity` en la Company relacionada (si existe) — el humano puede revisar y eliminar el lead después si no está de acuerdo.

---

## 7. Cómo calificará empresas

Mismo patrón híbrido ya aprobado para el Pricing Agent (decisión D8, Arquitectura §6.5): **cálculo determinista primero, LLM interpreta y explica dentro de un rango, nunca inventa el número final.**

1. **Base determinista (código, no IA):** puntos por factores objetivos ya en la base de datos — ¿la industria de la empresa coincide con una industria activa del tenant? ¿el `estimatedSize` calza con el perfil de cliente ideal? ¿ya tiene contactos con `decisionRole` relevante? ¿tiene `Activity` reciente o está dormida? ¿tuvo `Opportunity` ganadas antes? Cada factor suma/resta dentro de un rango 0–100, con pesos declarados y testeables.
2. **Capa LLM:** interpreta contexto no estructurado (notas manuales, señales de texto libre) y redacta el `rationale`; puede ajustar el score dentro de un margen acotado (ej. ±10 puntos) sobre el valor determinista, nunca fuera de rango.
3. **Persistencia:** el score va a `Company.commercialScore` (ya existe). **Cambio de schema necesario:** `Company.commercialScoreReason String?` (nuevo, análogo a `Lead.aiScoreReason` — mismo patrón, mismo modelo mental).
4. Cada actualización de score genera una `Activity` tipo `SYSTEM` en la Company ("Score comercial actualizado por Sales Agent: 72 → 85") con el rationale corto, y el detalle completo queda en `AgentTask.output`.

---

## 8. Cómo preparará correos personalizados

- Input de `draftOutreach`: `leadId` o `companyId` (+ `contactId` si existe uno relevante) + `channel` (`EMAIL`/`LINKEDIN`).
- El LLM redacta usando: nombre de la empresa, industria, categoría de necesidad detectada, el `rationale` del scoring, y una plantilla base con tono/marca definido en el `systemPromptTemplate` (§14) — no es texto 100% libre, tiene guardrails de tono.
- El borrador **no se guarda como acción completada**: se persiste en `AgentTask.output` y se expone como `ApprovalRequest.proposedAction` = `{ channel, contactId, subject, body }`.
- El humano puede: **aprobar** (el texto queda disponible para copiar y enviar manualmente fuera del sistema — no hay integración de envío), **rechazar**, o **pedir que se regenere** con una nota.
- Esto cumple literalmente "no enviar correos automáticamente todavía": no existe ni el botón conectado a un proveedor de email en esta fase.

---

## 9. Qué acciones requerirán aprobación humana

Basado en la matriz de autonomía de Arquitectura §3.4 + las reglas explícitas de esta fase:

| Acción | ¿Requiere `ApprovalRequest`? | Razón |
|---|---|---|
| `searchCompanies`, `detectHiringSignals`, `identifyContacts` | No | Lectura/análisis — `FULL_AUTO` en la matriz |
| `createLead` | No (pero queda 100% auditado) | Crear registro interno — `FULL_AUTO` |
| `scoreOpportunity` / calificar empresa | No (pero queda 100% auditado) | Análisis interno, no toca a nadie externo |
| `suggestFollowUp` | No crea nada solo — el humano confirma con un clic | Diseño conservador para el primer agente (ver Arquitectura §9, riesgo #11: lanzar en modo asistido) |
| `draftOutreach` | **Sí, siempre** | Es el único paso que produce contenido pensado para llegar a alguien fuera del tenant — coincide con "Enviar emails a clientes: `AUTO_WITH_APPROVAL`" de la matriz |
| Integrar una fuente de datos nueva (paga o no) | Sí, pero es una aprobación de **producto/alcance con el PO**, no una `ApprovalRequest` en la app | Regla explícita del usuario |

---

## 10. Herramientas internas necesarias

**En `packages/agents` (framework genérico, sigue sin depender de `apps/api` — principio "aislado, extraíble" de Arquitectura §1.1):**
- `LLMProvider` real: `packages/agents/src/providers/openai-provider.ts` implementando la interfaz ya definida, usando el SDK oficial `openai` (nueva dependencia).
- `AgentRuntime` real: loop ReAct genérico — no sabe nada de "leads" ni "companies", solo sabe ejecutar tools registradas en un `ToolRegistry`.
- `ToolRegistry` real: registro simple `Map<string, AgentTool>` con validación de permisos por tool.
- `CostTracker` (nuevo archivo, mencionado en Arquitectura §6.1 pero no construido en F0): calcula `costUsd` a partir de tokens de input/output y el precio del modelo usado.
- `ApprovalGate` (nuevo archivo, idem): dado un `AgentTool` y su resultado propuesto, decide si hace falta crear una `ApprovalRequest` antes de considerar la tarea terminada.

**En `apps/api` (implementaciones concretas que sí tocan servicios de negocio):**
- `apps/api/src/modules/agents/tools/sales-tools.impl.ts`: implementación real de las 7 tools, important — importa los tipos/schemas Zod de `packages/agents`, pero el `execute()` real vive aquí porque necesita los `service.ts` de `crm`, `leads`, `opportunities`, `followups`, `activities`. Esto mantiene `packages/agents` extraíble como paquete/servicio independiente en el futuro (una implementación futura fuera de este monorepo llamaría a estos mismos services vía HTTP en vez de import directo, sin tocar el framework).
- `apps/api/src/modules/agents/task-runner.ts`: el runner in-process que ejecuta un `AgentTask` (arma el `AgentContext`, corre el `AgentRuntime`, persiste el resultado).
- `apps/api/src/modules/approvals/`: nuevo módulo (`router.ts` + `service.ts`) para listar y decidir `ApprovalRequest`.

---

## 11. Cambios de schema si hacen falta

Dos campos nuevos, ambos nullable, ambos siguiendo un patrón ya existente en el schema — ningún modelo se modifica de forma destructiva y no hace falta backfill:

| Campo | Modelo | Precedente que sigue |
|---|---|---|
| `createdByAgentTaskId String?` | `Lead` | `PricingScenario.createdByAgentTaskId` (ya existe desde F0) |
| `commercialScoreReason String?` | `Company` | `Lead.aiScoreReason` (ya existe desde F0) |

Nada más. `AgentTask.tokensUsed`/`costUsd`/`parentTaskId`, `Activity.performedByAgentId`, `AgentDefinition.systemPromptTemplate`, `ApprovalRequest` completo — todo ya existe en el schema desde F0 y estaba sin usar hasta ahora.

---

## 12. Nuevas rutas API

Todas bajo `/api/v1`, mismo patrón de F0/F1 (`router.ts` + `service.ts`, Zod en entrada/salida).

| Método | Ruta | Nota |
|---|---|---|
| `POST` | `/agents/sales/tasks` | Invoca al Sales Agent (`type`: `search_companies`, `score_company`, `identify_contacts`, `draft_outreach`, `suggest_follow_up`; `input` según el tipo). Crea el `AgentTask` en `QUEUED` y dispara el runner in-process. |
| `GET` | `/agents/tasks/:id` | Estado + resultado — para polling desde el frontend. |
| `GET` | `/agents/tasks` | Historial, filtros `agentInstanceId`/`status`. |
| `GET` | `/approvals` | Bandeja de aprobaciones pendientes (prevista desde Arquitectura §7.2, nunca implementada). |
| `POST` | `/approvals/:id/decide` | `{ decision: "APPROVED" \| "REJECTED", note? }`. |

No se toca ningún endpoint de F0/F1.

---

## 13. Nuevas páginas o componentes frontend

- **AI Agents Center ampliado:** click en la tarjeta del Sales Agent abre un detalle con historial de `AgentTask` (timeline, igual patrón visual que `Timeline.tsx` ya construido en F1), botón para lanzar una tarea nueva.
- **Bandeja de Approvals** (nueva página `/approvals`, o drawer accesible desde el Topbar — prevista desde Arquitectura §5.3): lista `ApprovalRequest` pendientes con Aprobar / Rechazar / pedir regeneración.
- **`CompanyDetail.tsx`:** botón "Calificar con IA" (invoca `score_company`), muestra `commercialScoreReason` cuando existe.
- **`Leads.tsx` / `LeadDetail.tsx`:** badge "AI" cuando `createdByAgentTaskId` no es nulo.
- **Componente `OutreachDraftCard`:** muestra un borrador de `draftOutreach` pendiente de aprobación con los botones de decisión.
- **Componente `AgentTaskStatus`:** barra/badge de progreso simple mientras una tarea está `QUEUED`/`RUNNING`, con polling.

---

## 14. Sistema de prompts del Sales Agent

- `AgentDefinition.systemPromptTemplate` (columna ya existe, vacía desde F0/F1) se llena con el prompt real.
- **Versionado en código, no solo en base de datos:** se agrega un campo `systemPromptTemplate: string` al `AgentDefinitionStub` (`packages/agents/src/core/AgentDefinitionStub.ts`) y se define directamente en `sales.agent.ts` — así el prompt queda en git, revisable en PRs, y el seed lo sincroniza a la tabla como ya hace con `name`/`description`.
- Borrador del prompt base (ajustable durante la implementación, no es texto final):

  > Eres el Sales Agent de una agencia de staffing. Tu trabajo es ayudar a encontrar y calificar oportunidades comerciales, nunca cerrarlas ni contactarlas por tu cuenta.
  >
  > Reglas que nunca rompes:
  > - Nunca inventes datos de una empresa o contacto que no estén en las herramientas que tienes disponibles.
  > - Todo score o recomendación debe venir con una razón clara y verificable.
  > - Nunca redactes contenido prometiendo precios, tarifas o compromisos — eso lo decide un humano.
  > - Cualquier borrador de contacto (`draftOutreach`) es solo un borrador: dilo explícitamente, nunca sugieras que ya fue enviado.
  > - Si no tienes información suficiente para una tarea, dilo — no completes con suposiciones.

- **Guardrails a nivel de código** (no solo de prompt, Arquitectura §6.3): toda salida del LLM que vaya a persistirse pasa por validación Zod antes de tocar la base de datos; si la validación falla, se reintenta una vez con el error como feedback y si vuelve a fallar la tarea termina en `FAILED`, nunca escribe datos a medias.
- **Evals mínimos:** un dataset pequeño de casos dorados (5–10 empresas de prueba con score esperado aproximado) corriendo como test de `node:test` — versión reducida de lo que Arquitectura §6.3 pide para CI a futuro, suficiente para F2 sin bloquear la fase por infraestructura de evals completa.

---

## 15. Logs y auditoría

- Cada ejecución de tool queda como un `AgentTask` (`input`, `output`, `status`, `tokensUsed`, `costUsd`, `createdAt`/`completedAt` — modelo ya existe desde F0).
- Cada acción de escritura (crear lead, actualizar `commercialScore`) genera además una fila en `AuditLog` (mismo patrón que ya usan las acciones humanas desde F0/F1) y una `Activity` visible en el timeline de la entidad afectada — así un usuario que abre `CompanyDetail` ve la acción del agente exactamente igual que vería la de un colega humano.
- `AgentTask.parentTaskId` encadena tareas relacionadas (ej. `search_companies` → un `create_lead` por cada resultado aceptado) para poder reconstruir la cadena de razonamiento en el AI Agents Center, tal como describe Arquitectura §3.1.
- Todo actor de tipo `AGENT` en `AuditLog`/`Activity` usa `AgentInstance.id`, nunca un `User.id` — se distingue claramente de la actividad humana en cualquier vista.

---

## 16. Control de costos de IA

- `CostTracker` calcula `tokensUsed`/`costUsd` (ya existen como columnas `Decimal(10,4)`) en cada `AgentTask`, a partir de la respuesta de uso que devuelve la API de OpenAI.
- **Presupuesto mensual por tenant:** se guarda en `Tenant.settings` (Json, ya existe) un valor `aiMonthlyBudgetUsd` (default propuesto: $30 USD/mes, ajustable). Antes de cada llamada a OpenAI se suma el `costUsd` del mes actual; si se superaría el presupuesto, la tarea se rechaza con un mensaje claro **antes** de gastar, no después.
- **Routing de modelo** (Arquitectura §6.3, "modelo pequeño para clasificación/extracción rutinaria; modelo grande solo para razonamiento complejo"): F2 usa por defecto un modelo económico para todas las tools (scoring, búsqueda, redacción son tareas acotadas, no razonamiento abierto) — no hay necesidad de un modelo "grande" en esta fase; se deja el mecanismo de routing preparado para cuando haga falta.
- El costo acumulado del mes se muestra en la tarjeta del Sales Agent en AI Agents Center (`AgentInstance.metrics`, ya existe como Json, ya se sembraba con `{ tasksCompleted: 0 }` desde F0/F1 — se le agrega `costUsdThisMonth`).

---

## 17. Riesgos legales/comerciales

1. **Alucinación del LLM** (el riesgo más serio de esta fase): que el agente invente un dato de una empresa o un contacto inexistente. Mitigado por: (a) scoring determinista con el LLM solo interpretando dentro de un rango acotado, igual que ya se aprobó para Pricing Agent; (b) el agente nunca crea un `Contact` nuevo, solo usa los que ya existen o sugiere qué rol buscar sin asumir una persona; (c) `draftOutreach` siempre pasa por revisión humana antes de que el texto se use para algo real.
2. **Datos de terceros / scraping no autorizado.** Mitigado limitando F2 a datos propios + carga manual (§5) — no hay superficie de riesgo porque no hay integración externa que pueda violar un ToS.
3. **CAN-SPAM / TCPA en el contenido del borrador**, aunque no se envíe nada automáticamente: el prompt (§14) prohíbe explícitamente prometer precios o compromisos, y el borrador nunca se marca como enviado. Riesgo bajo porque no hay envío real, pero se documenta como recordatorio para cuando F5/F6 sí integren envío real (Arquitectura §9, riesgos #8).
4. **Costos de OpenAI descontrolados.** Mitigado por presupuesto mensual duro + modelo económico por defecto (§16) — mismo riesgo que ya identificó Arquitectura §9, riesgo #2.
5. **Confianza del usuario en el agente.** Lanzar en `ASSISTED` (ya configurado así desde F1) y con aprobación obligatoria para todo lo externo evita que un fallo temprano "apague" la IA — mismo riesgo y mitigación que ya declara Arquitectura §9, riesgo #11.
6. **Discriminación algorítmica.** No aplica directamente en F2 (el Sales Agent no decide sobre personas/candidatos, solo sobre empresas objetivo comercial) — se deja constancia de que esta preocupación (EEOC/IL AIVIA/NYC LL144, Arquitectura §6.4) es relevante para el Recruiter Agent, no para este.

---

## 18. Definition of Done

> Nota de verificación: cada ítem de abajo fue verificado en un entorno real (navegador real vía Playwright + backend corriendo contra Postgres real en Docker + al menos 2 llamadas reales a la API de OpenAI, tanto en los tests automatizados como en la verificación manual en navegador + consultas directas a la base de datos para confirmar persistencia), no únicamente mediante compilación o tipos. Dos ítems tienen una nota aclaratoria sobre cómo se cumplieron exactamente — ver el detalle junto a cada uno.

- [x] `LLMProvider` real (OpenAI) implementado detrás de la interfaz existente en `packages/agents`
- [x] `AgentRuntime` ejecuta un loop ReAct real; ya no lanza `NotImplementedError` — nota: implementado como despacho determinístico de un solo tool por tarea (el `type` del `AgentTask` elige el tool, no un planificador libre). Ver "Desviaciones aprobadas" abajo.
- [x] `CostTracker` y `ApprovalGate` implementados
- [x] Las 7 tools de `sales-tools.ts` tienen lógica real (`apps/api/src/modules/agents/tools/sales-tools.impl.ts`), cada una pasando por los `service.ts` existentes — ninguna toca SQL directo
- [x] `searchCompanies`, `detectHiringSignals`, `identifyContacts`, `scoreCompany` (renombrado de `scoreOpportunity` — ver desviaciones), `suggestFollowUp` funcionan sin requerir aprobación previa, con auditoría completa (`AgentTask` + `AuditLog` + `Activity`)
- [x] `createLead` crea leads reales marcados con `createdByAgentTaskId` + `aiScoreReason` obligatorio, badge "AI" visible en el frontend
- [x] `draftOutreach` genera un borrador que **nunca se envía**, siempre termina en una `ApprovalRequest`
- [x] Bandeja de Approvals funcional: listar, aprobar, rechazar, ver el `proposedAction` completo
- [x] AI Agents Center permite lanzar una tarea nueva (prospección) y muestra métricas del Sales Agent — nota: el "historial de tareas" se expone contextualmente en cada página donde se lanza la acción (CompanyDetail, LeadDetail, AgentsCenter), reusando `GET /agents/tasks/:id`, en vez de una vista central de lista. La cadena `parentTaskId` no se ejerce en F2 (ningún tool de esta fase encadena sub-tareas) — el campo y el endpoint quedan listos para cuando haga falta. Ver "Desviaciones aprobadas".
- [x] Presupuesto mensual por tenant respetado: una tarea que lo excedería se rechaza antes de llamar a OpenAI, no después
- [x] Costo acumulado del mes visible en la tarjeta del agente
- [x] RBAC: rutas nuevas protegidas correctamente (`agents.execute`, `approvals.decide`); verificado con un test (un rol sin el permiso recibe 403)
- [x] Tests automatizados mínimos: (a) `draftOutreach` nunca invoca nada que envíe algo real — no existe ni la dependencia de envío, y el `proposedAction` se verifica estructuralmente sin campos de envío; (b) un lead creado por el agente tiene `createdByAgentTaskId` y `aiScoreReason` poblados; (c) una tarea que excede el presupuesto se rechaza sin llamar a OpenAI (`tokensUsed` queda `null`); (d) eval de scoring contra un caso dorado real (empresa con perfil fuerte → score ≥ 50, rationale persistido)
- [x] Verificación visual en navegador real de cada flujo nuevo (lanzar tarea, ver resultado, aprobar/rechazar un borrador)
- [x] Al menos una corrida real contra OpenAI verificada manualmente (no solo con un `LLMProvider` fixture/fake)
- [x] F0 y F1 intactos — regresión de los 15 tests existentes sin modificarlos
- [x] `pnpm typecheck`, `pnpm lint` y `pnpm test` limpios en todo el monorepo
- [x] Sin código muerto, sin TODOs críticos, sin llamadas de red fuera de OpenAI y la propia base de datos — con una excepción documentada: ver hallazgo #7 en "Bugs encontrados"

---

## Resultado de la implementación

### Fecha de finalización

2026-07-09

### Commit final de F2

`6127d68` — commit range `0cdb6fa`→`6127d68`, 10 commits (uno por paso: F2-1 a F2-10). El commit de este propio documento (`docs: mark F2_AI_SALES_AGENT_PLAN.md as completed and verified`) es el commit inmediatamente posterior y no forma parte de la implementación funcional.

### Resumen ejecutivo

El Sales Agent pasó de ser un esqueleto tipado (F1) a un agente con LLM real (gpt-4o-mini), operando en autonomía `ASSISTED` sobre el dominio comercial. Sus 7 tools están implementadas de verdad: 5 son deterministas (sin costo de IA — búsqueda, detección de señales, identificación de contactos, sugerencia de follow-up), y 2 usan el patrón híbrido determinista+LLM (D8): `scoreCompany` (score 0–100 con rationale) y `draftOutreach` (borrador de contacto). Cada acción de escritura queda auditada (`AgentTask` + `AuditLog` + `Activity`), cada lead creado por IA queda marcado (`createdByAgentTaskId`) con badge visible, y `draftOutreach` — la única acción que produce contenido para alguien fuera del tenant — siempre termina en una `ApprovalRequest` pendiente: nunca se envía nada automáticamente. Un guardia de presupuesto mensual por tenant bloquea llamadas a OpenAI antes de gastarlas, no después. Se construyó también la bandeja de Approvals (prevista desde la Arquitectura original y nunca implementada hasta ahora) y se integraron acciones de IA directamente en las páginas donde tienen sentido (CompanyDetail, LeadDetail, AgentsCenter) en vez de un panel de IA aislado.

### Métricas finales

| Métrica | Valor |
|---|---|
| Tests | 21/21 (15 F0/F1 + 6 nuevos de F2, incluyendo 2 llamadas reales a OpenAI en cada corrida) |
| Commits de F2 | 10 (F2-1 a F2-10) |
| Archivos modificados/creados | 50 archivos, +2514/-85 líneas, 16 archivos nuevos |
| Cambios de schema | 2 campos nuevos (`Lead.createdByAgentTaskId`, `Company.commercialScoreReason`), 1 migración nueva (`20260709135810_f2_sales_agent`) |
| Modelos Prisma | 39 (sin cambios — F2 no agregó modelos, solo campos) |
| Migraciones totales | 3 (`init`, `f1_revenue_engine`, `f2_sales_agent`) |
| Permisos | 53 (52 de F1 + `agents.execute`) |
| Módulos backend | 15 (14 de F1 + `approvals`) |
| Endpoints HTTP totales | 49 (+5 en F2: `POST /agents/sales/tasks`, `GET /agents/tasks`, `GET /agents/tasks/:id`, `GET /approvals`, `POST /approvals/:id/decide`) |
| Páginas frontend | 18 (17 de F1 + `Approvals.tsx`) |
| Tools del Sales Agent con lógica real | 7 (5 deterministas, 2 híbridas determinista+LLM) |
| AgentDefinition / AgentInstance | 12 / 6 (sin cambios — solo `sales` tiene `systemPromptTemplate` real, 688 caracteres) |
| Costo real de OpenAI durante desarrollo + verificación | < $0.01 USD (modelo gpt-4o-mini; ej. una corrida de `scoreCompany` ≈ $0.0001, una de `draftOutreach` ≈ $0.0002) |
| Métricas observadas del Sales Agent al cierre de la verificación | 22 tareas completadas, $0.0005 gastados este mes, presupuesto $50/mes sin exceder |

### Bugs encontrados durante la implementación y cómo fueron corregidos

1. **`Tenant.settings` en `seed.ts` solo se actualizaba en la rama `create` del upsert, no en `update`.** Como el tenant ya existía desde F0, volver a correr el seed nunca habría aplicado `aiMonthlyBudgetUsd` a un entorno ya sembrado. Encontrado por inspección antes de ejecutar el seed. Corregido agregando el mismo objeto `settings` a la rama `update`.
2. **OpenAI SDK rechaza el rol `"tool"` de `LLMMessage` en tiempo de compilación** (`ChatCompletionToolMessageParam` exige `tool_call_id`, que la interfaz genérica de F0 no tiene). Encontrado por `tsc` al escribir `openai-provider.ts`. Corregido acotando explícitamente el mapeo a los roles que el `AgentRuntime` de F2 realmente produce (`system`/`user`/`assistant`) y lanzando un error claro si algún día aparece un mensaje `"tool"`, en vez de forzar un cast amplio que ocultaría el problema.
3. **`react-hooks/set-state-in-effect` (ESLint) en `useAgentTask.ts`**: la primera versión llamaba `setState` de forma síncrona dentro de un `useEffect` para evitar notificar dos veces el mismo `onSettled`. Corregido reemplazando ese `useState` por un `useRef` — el seguimiento de "ya notificado" no necesita re-renderizar nada, así que no hace falta `setState` ahí.
4. **`Cannot find name 'queryClient'` en `CompanyDetail.tsx`**: al conectar `onSettled` de las nuevas acciones de IA con `queryClient.invalidateQueries`, el componente no tenía su propio `useQueryClient()` en scope (antes no lo necesitaba). Encontrado inmediatamente por `tsc`. Corregido agregando el hook al inicio del componente.
5. **`PageHeader`'s `title` estaba tipado como `string`**, pero el badge "AI" junto al nombre del lead necesitaba renderizar un `ReactNode`. Ensanchado el tipo (cambio compatible hacia atrás: todo `string` sigue siendo un `ReactNode` válido).
6. **Script de verificación en Playwright** (no un bug de la app): un `page.locator("tr", { hasText: "AI" }).click()` no disparaba la navegación de forma confiable. Corregido navegando directamente por `id` de lead (obtenido por consulta a la base de datos) en vez de depender de un selector de fila ambiguo.
7. **Hallazgo estructural, no funcional, encontrado durante esta revisión final**: `salesAgent.tools` (el array declarado en `packages/agents/src/definitions/sales.agent.ts`) sigue apuntando a los objetos stub originales de `sales-tools.ts` (`execute: notImplemented()`) — nunca se ejecutan en runtime, porque `task-runner.ts` construye su propio `ToolRegistry` con tools reales vía `createSalesTools()`, sin leer `salesAgent.tools` en ningún momento. No rompe nada (nadie invoca ese array), pero es metadata descriptiva sin uso real — candidato a limpieza o a redefinirse explícitamente como "no usado en ejecución" en F3.

### Desviaciones aprobadas respecto al plan original

1. **Reasignación de tools entre agentes.** El plan original (y el propio F1) dejaban `searchCompanies`/`detectHiringSignals` en el Market Intelligence Agent (stub) y `scoreOpportunity`/`suggestFollowUp` en el Revenue Agent (stub). La decisión de alcance aprobada para F2 dice explícitamente que el Sales Agent "puede: analizar empresas, calificar leads" — imposible de cumplir si esos tools se quedan en agentes que deben seguir siendo stubs. Se reasignaron los 4 al Sales Agent; Market Intelligence Agent y Revenue Agent quedan con `tools: []`, tal como se aprobó (cero comportamiento real).
2. **`scoreOpportunity` renombrado a `scoreCompany`** con `companyId` en vez de `opportunityId`. El único campo de schema aprobado para scoring fue `Company.commercialScoreReason` — no existe nada equivalente en `Opportunity`, así que el tool califica empresas prospecto (que es además lo que pide el plan §7), no oportunidades ya abiertas.
3. **`AgentRuntime` implementado como despacho determinístico de un tool por tarea**, no como un planificador ReAct multi-turno que elige libremente entre tools. Decisión consciente de seguridad y auditabilidad para el primer agente con LLM real: el `type` de cada `AgentTask` (elegido por el humano o por la UI) determina el tool, el modelo nunca decide qué acción tomar por su cuenta. Documentado en `AgentRuntime.ts`.
4. **Sin vista centralizada de "historial de tareas" con cadena `parentTaskId`.** En su lugar, cada acción de IA muestra su resultado en el lugar donde se lanzó (tarjeta "Sales Agent" en `CompanyDetail`/`LeadDetail`, sección de prospección en `AgentsCenter`), reusando los mismos endpoints (`GET /agents/tasks/:id`). Ningún tool de F2 encadena sub-tareas — no había un flujo de un solo agente que lo necesitara todavía. El campo `parentTaskId` y el endpoint `GET /agents/tasks` (con filtros) ya existen y quedan listos para cuando la orquestación multi-agente de una fase futura sí lo necesite.

### Evidencia de verificación en navegador real

Flujo completo verificado con Playwright contra el backend real (Postgres en Docker + OpenAI real), cero errores de consola/HTTP en toda la corrida:

1. AI Agents Center: tarjetas de los 6 agentes, Sales Agent mostrando tareas completadas y costo mensual reales.
2. "Buscar empresas nuevas" → resultados reales con nombre/industria/ubicación, cada uno con botón "Crear lead".
3. "Crear lead" → lead creado, badge "AI" visible en `Leads.tsx`.
4. `CompanyDetail`: "Calificar con IA" → score persistido (100/100 en el caso de prueba, empresa Cliente grande en industria activa) con rationale real en español, sin datos inventados.
5. "Buscar señales" → señales reales basadas en `JobOrder`/`Opportunity` internos, con score de confianza.
6. "Identificar contactos" → nombres reales de contactos existentes.
7. `LeadDetail`: badge "AI" junto al título, "Redactar email (IA)" → borrador real personalizado (nombre del contacto correcto, sin precios ni compromisos, marcado `Pending`).
8. Aprobar el borrador desde el lead → badge cambia a `Approved`, atribución "Decidido por [usuario real]".
9. `/approvals`: tabs Pending/Approved/Rejected/Todas, enlace "Ver lead" de vuelta al lead de origen.
10. Modo oscuro verificado en `AgentsCenter` y `Approvals` — legible, sin problemas de contraste.

### Estado final del Sales Agent

- Autonomía: `ASSISTED` (sin cambios respecto a F1).
- 7 tools reales; 2 con llamada a OpenAI (`scoreCompany`, `draftOutreach`), 5 deterministas sin costo.
- Presupuesto mensual: $50/tenant (configurable en `Tenant.settings.aiMonthlyBudgetUsd`), guardia verificado con test automatizado.
- Market Intelligence Agent y Revenue Agent: siguen 100% stub (`tools: []`, `systemPromptTemplate: ""`), como se aprobó.
- Cero integraciones de envío real, cero scraping, cero fuentes de datos pagas — exactamente el alcance aprobado.

### Preparación dejada para F3

- `LLMProvider`, `AgentRuntime`, `CostTracker` y `ApprovalGate` son genéricos (viven en `packages/agents`, sin conocimiento de "leads" ni "companies") — listos para que cualquier otro agente los reutilice sin duplicar código.
- El patrón híbrido determinista+LLM (D8) quedó probado end-to-end en `scoreCompany` — mismo patrón que el Pricing Agent va a necesitar.
- La bandeja de `Approvals` y el modelo `ApprovalRequest` están listos para cualquier agente futuro que necesite aprobación humana, no solo el Sales Agent.
- `AgentTask.parentTaskId` existe y está sin usar — listo para cuando la orquestación multi-agente (`Orchestrator.ts`, todavía no construido) encadene tareas entre agentes.
- `Tenant.settings.aiMonthlyBudgetUsd` y el guardia de presupuesto son por tenant, no por agente — un segundo agente con LLM real comparte automáticamente el mismo control de costos.
- Deuda técnica menor identificada (hallazgo #7): limpiar o redefinir `salesAgent.tools` en `packages/agents` para que no sugiera falsamente que esos stubs se ejecutan.
- Siguen fuera de alcance, sin cambios: `AgentMemory`/pgvector, Redis/BullMQ/Socket.io, envío real de email/LinkedIn, Market Intelligence Agent y Revenue Agent con comportamiento real.

---

**Siguiente paso:** F3, a definir — candidatos naturales según lo dejado listo arriba: dar comportamiento real a un segundo agente (Market Intelligence, Revenue o Pricing), o construir la integración de envío real de outreach una vez que el volumen de borradores aprobados lo justifique.
