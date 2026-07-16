# F6 — Matching por IA + Dashboards Operativos — Propuesta Técnica

**Estado: APROBADO por el PO (2026-07-14).** Alcance definitivo aprobado explícitamente: **Matching por IA (Recruiter Agent) + Dashboards Operativos + cierre de la deuda de tests RBAC 403 heredada de F5.** El contenido del roadmap original de "F6" (Marketing Agent, Indeed, LinkedIn, Twilio SMS, WhatsApp, job boards externos, marketing automation externo) queda **explícitamente fuera de alcance y no se considera aprobado** — ver §3. Este documento incorpora las 17 decisiones definitivas dadas por el PO como aprobadas; no hay decisiones abiertas de alcance pendientes de este momento en adelante (ver §27 para el registro histórico de cómo se resolvió cada una).

**Este documento sigue siendo de planificación en cuanto a código: no se ha escrito ninguna línea de implementación.** Sin cambios de schema, sin migraciones, sin endpoints nuevos, sin UI nueva, sin commits de código hasta que el PO apruebe explícitamente el inicio de F6.0.

**Precedente inmediato:** `docs/F5_STAFFING_OPERATIONS_PLAN.md` (aprobado, implementado, cerrado — F5.1–F5.8) y `docs/F6_IMPLEMENTATION_REPORT.md` (auditoría de esa sesión). La primera versión de este documento presentó el alcance como propuesta con 7 decisiones pendientes; el PO las resolvió todas en una sola ronda de aprobación (registrada en §27).

**Metodología de esta auditoría (sin cambios respecto a la primera versión, ampliada con verificación adicional de la infraestructura real de agentes):** cada afirmación está verificada contra `docs/MASTER_PROJECT_STATUS.md`, `docs/ROADMAP.md`, `docs/F5_STAFFING_OPERATIONS_PLAN.md` (826 líneas, completo), `docs/F6_IMPLEMENTATION_REPORT.md`, `docs/01_ARQUITECTURA_v1.1.md` (728 líneas, completo), `docs/DECISION_LOG.md`, `packages/db/prisma/schema.prisma` (67 declaraciones de `model`/`enum`, todas leídas), `packages/shared/src/permissions.ts` (completo), `packages/db/prisma/seed.ts` (roles/permisos/agentes, incluyendo la sección de `AgentDefinition`/`AgentInstance` completa), `apps/api/src/core/env.ts` (completo), los 25 módulos de `apps/api/src/modules/`, `packages/agents/src/{core,definitions,tools,providers}/` (completo), `packages/agents/src/core/ApprovalGate.ts` (completo), y — nuevo en esta revisión — `apps/api/src/modules/agents/task-executor.ts`, `apps/api/src/modules/agents/budget.ts`, `apps/api/src/modules/agents/router.ts`, y `packages/agents/src/tools/sales-tools.ts` (para documentar con precisión el mecanismo real de "graduar un agente").

---

## 1. Objetivo de F6

**Objetivo aprobado:** graduar el **Recruiter Agent** (hoy `AgentDefinitionStub` con `tools: []`) con un primer tool real, `matchWorkersToJobOrder`, que propone — nunca decide — una lista priorizada de Workers elegibles para un Job Order real, combinando un score determinista y auditable con una capa LLM opcional que solo interpreta y explica dentro de un margen acotado. En paralelo, extender la visibilidad operativa (`Dashboard.tsx`) con secciones reales por rol, y cerrar la deuda de cobertura de tests 403 heredada del DoD de F5.

**La IA propone. La IA no decide. La IA no crea Assignments automáticamente. Toda asignación sigue siendo una acción humana explícita** — mismo principio D6 del `DECISION_LOG.md` ("la IA nunca rechaza candidatos, nunca aprueba payroll, nunca fija tarifas finales"), extendido aquí explícitamente a "nunca crea una Assignment".

**Corrección de una imprecisión propia de la primera versión de este documento** (auto-verificación, no señalada por el PO): esa versión afirmaba "8 de 17 `AgentDefinition` siguen siendo stubs". Al releer `seed.ts` completo para esta revisión se encontró un decimoctavo `AgentDefinition` (`revenue`, `packages/agents/src/definitions/revenue.agent.ts`, también `tools: []`, con un comentario propio que explica por qué: *"F2: sigue como stub — scoreCompany/suggestFollowUp se reasignaron al Sales Agent... este agente queda sin tools hasta que se apruebe una fase futura"*). El número correcto es **9 de 18** `AgentDefinition` como cáscaras vacías antes de F6; con la graduación de `recruiter`, quedan 8 de 18.

---

## 2. Alcance

Aprobado, textualmente:

- Matching por IA entre Job Orders y Workers.
- Scoring determinista.
- Rationale explicable.
- Ranking de candidatos.
- Dashboards operativos por rol.
- Cobertura de tests 403 pendiente de F5.
- Verificación real end-to-end (backend + Playwright).

Con las siguientes precisiones de diseño, resueltas en esta revisión a partir de la auditoría técnica adicional (§4, §7):

- El agente que ejecuta el matching es el **Recruiter Agent** — ya existe como `AgentDefinition`/`AgentInstance` sembrado (`seed.ts`, incluido en el loop que crea una `AgentInstance` por tenant para cada definición, línea ~1513) — **no se crea un agente nuevo**, se gradúa el que ya existe, exactamente como Sales (F2)/Market Intelligence (F3)/Campaign-Outreach-Conversation (F4)/CEO (F4)/Discovery/Contact Intelligence (F4.5-F4.7) ya se graduaron.
- La disponibilidad real (`isWorkerAvailable`, con solapamiento de fechas) se implementa **dentro de F6** (F6.2) — no queda como limitación conocida.
- El resultado del matching se persiste en `AgentTask.output` (Json, ya existe) — no se crea un modelo `MatchResult` nuevo.
- El permiso es un recurso nuevo `matching` (`matching.view`, `matching.run`) — no se reutiliza `jobOrders.view` ni `agents.execute`.

---

## 3. Fuera de alcance

**Explícitamente no aprobado, no se implementa bajo ninguna circunstancia dentro de F6:**

- Indeed.
- LinkedIn (como integración de publicación de anuncios — el campo `Contact.linkedinUrl` y el enum `CompanyOrigin.LINKEDIN` ya existen desde F0/F1 como *datos de referencia*, sin relación con esta exclusión; no se toca ninguno de los dos).
- Twilio.
- SMS (el campo `Candidate.smsOptIn` sigue existiendo desde F0, sin ningún cliente de SMS asociado — se mantiene exactamente igual, sin uso).
- WhatsApp.
- Job boards externos de cualquier tipo.
- Marketing automation externo.

**Además, fuera de alcance por continuidad de las reglas ya vigentes en F5 y en esta sesión:**

- Cualquier cambio a Clerk/autenticación, Render/deployment, `apps/marketing`, CRM comercial (Companies/Leads/Opportunities/Pipeline), Campaigns/Outreach/Missions ya construidos.
- Creación automática de `Assignment` sin confirmación humana — el botón "Create Assignment" desde la pantalla de resultados de matching puede existir *reutilizando exclusivamente* el flujo manual ya construido en F5.4 (`POST /assignments`, con sus gates de compliance/cupo intactos) — no se implementa sin que quede claro que sigue exigiendo confirmación humana explícita, y no se construye lógica de creación nueva para él.
- Un sexto dashboard/página nueva — se extiende `Dashboard.tsx`.
- Tax engine externo, integración de nómina (Check/Gusto), pagos online (Stripe) — D7/P1 del `DECISION_LOG.md`.
- **F7 — fuera de alcance absoluto, sin excepción, en cualquier circunstancia.**
- Cualquier cambio de schema no aprobado explícitamente (§10, §14 del pedido del PO) — la expectativa de partida es cero migraciones.

---

## 4. Auditoría del estado actual

*(Sin cambios respecto a la versión previa salvo la corrección de §1 y las adiciones marcadas explícitamente como "nuevo en esta revisión")*

### 4.1 El roadmap original de F6, y por qué no se tomó al pie de la letra — confirmado correcto por el PO

La primera versión de este documento documentó, con evidencia, que el roadmap original (`docs/ROADMAP.md`, `docs/01_ARQUITECTURA_v1.1.md` §8, anteriores a cualquier línea de código) definía F6 como "Marketing + Integraciones: Marketing Agent, Indeed/LinkedIn, Twilio SMS con TCPA", y que `docs/MASTER_PROJECT_STATUS.md` §1.2 documenta que cada fase desde F1 abandonó el contenido que el roadmap original le asignaba. **El PO confirmó esta lectura y aprobó explícitamente no continuar ese contenido** (§3). Este hallazgo queda registrado como correcto, no como una alternativa más a evaluar.

### 4.2 Lo que sí quedó diseñado y aprobado, adyacente a F6, sin implementar — es la base de este documento

`F5_STAFFING_OPERATIONS_PLAN.md` §11 (Matching por IA) y §12 (Dashboards operativos) — diseñados en detalle como parte del mismo documento madre aprobado, explícitamente excluidos del alcance mandatado de F5 (línea 506: *"quedan fuera del alcance mandatado para F5 — no fueron parte de la orden de trabajo de esta fase"*). Esta es la base técnica que F6 retoma y expande con el detalle adicional que el PO aprobó en su ronda de decisiones.

### 4.3 Estado real de los agentes stub — corregido (9 de 18, no 8 de 17)

| Agente | `tools` (código real) | Descripción en seed |
|---|---|---|
| `recruiter` | `[]` → **se gradúa en F6** | "Screens candidates, scores CVs, and builds shortlists." |
| `operations` | `[]` (sigue stub) | "Proposes assignments and schedules for open job orders." |
| `compliance` | `[]` (sigue stub) | "Extracts document data and tracks expiration alerts." |
| `pricing` | `[]` (sigue stub) | "Recommends pay/bill rates from benchmarks and burden costs." |
| `payroll` | `[]` (sigue stub) | "Validates time entries and drafts payroll runs." |
| `marketing` | `[]` (sigue stub) | "Proposes job ad campaigns for talent gaps." |
| `assistant` | `[]` (sigue stub) | "Answers questions about company data across modules." |
| `admin` | `[]` (sigue stub) | "Assists with tenant configuration and user management." |
| `revenue` | `[]` (sigue stub) | "Scores opportunities and suggests follow-ups to protect pipeline health." |

**El PO decidió explícitamente `recruiter` sobre `operations`** — motivo dado: "el objetivo es proponer Workers para un Job Order; la decisión pertenece al flujo de recruiting; Operations puede consumir el resultado, pero no ser el dueño principal del matching." Esto es consistente con la evidencia ya encontrada en `F5_STAFFING_OPERATIONS_PLAN.md` §11.5, que ya señalaba a ambos como "candidatos naturales" sin resolver cuál — el PO resuelve esa decisión abierta ahora.

### 4.4 Infraestructura real de "graduación de agente" — verificada con precisión adicional (nuevo en esta revisión)

Se auditó el mecanismo exacto que cada agente ya graduado usa, leyendo el código real (no solo la documentación):

- **`apps/api/src/modules/agents/task-executor.ts`** — motor de ejecución **ya generalizado y compartido** por los 9 agentes graduados (comentario propio del archivo: *"F3: generalización de task-runner.ts (F2)... el mismo mecanismo (crear AgentTask, chequear presupuesto, correr el tool, persistir) lo pueden usar también..."*). Expone, entre otras, `createAndRunTaskSync(tenantId, operatorUserId, params)` — crea el `AgentTask` en `QUEUED`, lo ejecuta, y devuelve la fila ya completada con su `output`. **F6 reutiliza esta función literalmente, sin modificarla.**
- **`resolveAgentInstance("recruiter")`** (dentro del mismo archivo) — hace `scopedDb.agentInstance.findFirst({ where: { definition: { key: "recruiter" } } })`. Verificado que **la `AgentInstance` de `recruiter` ya existe por tenant** — `seed.ts` la crea en el mismo loop que crea la de los 9 agentes ya graduados (línea ~1513, `"recruiter"` está en la lista). **Cero cambio de seed necesario.**
- **`apps/api/src/modules/agents/budget.ts`** — `getMonthlyBudgetStatus(tenantId)` sí ya implementa el guardrail de presupuesto (`Tenant.settings.aiMonthlyBudgetUsd`, default $50/mes, suma `AgentTask.costUsd` del mes calendario) — debe llamarse **antes** de invocar el LLM. F6 lo reutiliza sin cambios.
- **Patrón de dos archivos por agente**, verificado en `packages/agents/src/tools/sales-tools.ts` (declarativo: `name`/`description`/`inputSchema` con Zod, `execute()` lanza `NotImplementedError` hasta graduarse) + `apps/api/src/modules/agents/tools/sales-tools.impl.ts` (real: factory que construye el tool con un `execute()` real, atado a un `AgentTask` concreto). **Regla de oro confirmada en el propio comentario del archivo: "ninguna tool toca SQL directo, todas pasan por los services que también usan los humanos"** — el tool de matching debe invocar `matching/service.ts` (el mismo servicio que expondría el endpoint HTTP), nunca Prisma directo.
- **`apps/api/src/modules/agents/router.ts`** — el patrón de endpoint ya existente es `POST /agents/sales/tasks` (gateado por el permiso especial `agents.execute`, único para todos los agentes) + `GET /agents/tasks` + `GET /agents/tasks/:id`. **F6 no reutiliza esta ruta genérica** — ver razonamiento en §12.

### 4.5 Modelos de dato relevantes (sin cambios respecto a la versión previa, mantenidos por precisión)

- `Candidate.categories` (M:N a `JobCategory`), `.yearsExperience`, `.city`/`.state`, `.languages` (String[]) — sin `latitude`/`longitude`.
- `Worker.status` (`AVAILABLE`, `ASSIGNED`, `ON_LEAVE`, `TERMINATED`) y `.complianceStatus` (`COMPLIANT`, `PENDING`, `BLOCKED`) — enums verificados letra por letra en `schema.prisma` líneas 165-178.
- `JobOrder.categoryId`, `.location` (Json), `.requirements` (Json, keys de `DocumentType`), `.startDate`/`.endDate` (`endDate` nullable) — sin `supervisorContactId` propio (gap ya documentado, no bloqueante).
- **Corrección real encontrada durante esta revisión, respecto al pedido original del PO:** el pedido menciona *"Assignments CLOSED/CANCELLED no bloquean"*. Verificado en `schema.prisma` línea 208-213: **`AssignmentStatus` es `SCHEDULED`/`ACTIVE`/`COMPLETED`/`TERMINATED` — no existen los valores `CLOSED` ni `CANCELLED` en este enum** (esos sí existen en `JobOrderStatus`, un modelo distinto). La regla se adapta, preservando la intención exacta del PO: los estados terminales de `Assignment` que **no bloquean** disponibilidad son `COMPLETED` y `TERMINATED`; los que si compiten por el rango de fechas de un worker son `SCHEDULED` y `ACTIVE`. Ver §7.3 para el algoritmo exacto ya corregido.
- `Notification`/`DomainEvent` — dormidos (confirmado: `Notification` solo se lee en `dashboard/service.ts`, solo se escribe en `seed.ts`; `DomainEvent` no se lee ni escribe en ningún módulo real). No se activan en F6.
- `Campaign`/`CampaignCompany` — 100% orientado a Companies, no reutilizable para nada de F6 (era relevante solo para la alternativa de roadmap original, ahora descartada).
- `Tenant.settings` (Json) — patrón reutilizable para cualquier flag de configuración de matching (§18).

### 4.6 Estado de RBAC/permisos relevante (actualizado con el recurso nuevo aprobado)

16 `PERMISSION_RESOURCES` existentes + 10 permisos especiales (ver `F6_AUTONOMOUS_RECRUITING_AND_OPERATIONS_PLAN.md` versión previa para la lista completa, sin cambios). **Aprobado agregar un recurso 17: `matching`** (§15).

### 4.7 Estado de testing/regresión (línea base para F6, sin cambios)

320/320 tests backend al cierre de F5.8, working tree limpio, `pnpm typecheck`/`lint` limpios salvo 2 warnings preexistentes no relacionados.

---

## 5. Dependencias con F5

*(Actualizado: `isWorkerAvailable` pasa de "decisión abierta" a "dentro de alcance de F6")*

| Dependencia | Estado en F5 (cerrado) | Tratamiento en F6 |
|---|---|---|
| `Worker.complianceStatus` derivado de alertas reales | ✅ F5.5 | Filtro duro de elegibilidad |
| `Worker.status` (`AVAILABLE`/`ASSIGNED`/`ON_LEAVE`/`TERMINATED`) | ✅ F5.4 | `ON_LEAVE`/`TERMINATED` = filtro duro; `AVAILABLE`/`ASSIGNED` = elegibles condicionados a disponibilidad real (§7.3) |
| `JobOrder.workersFilled`/`.status` derivado de Assignments | ✅ F5.4 | El matching solo tiene sentido sobre Job Orders con cupo real — se valida en el servicio |
| `Candidate`/`Worker` CRUD real | ✅ F5.2/F5.3 | Datos editables reales para operar el matching, no solo seed congelado |
| `Assignment` ciclo completo (creación con gates) | ✅ F5.4 | El match propuesto se confirma con el mismo `POST /assignments` ya existente, sin duplicar su lógica |
| `isWorkerAvailable` (fechas reales) | ❌ No implementada al cierre de F5 | **Aprobado implementarla en F6.2** — ver §7.3 para el algoritmo exacto |
| RBAC (24 permission keys de F5.1-F5.3, sin test de 403) | 🟡 Existen, sin cobertura de test completa | **Aprobado cerrarlo en F6.9** |
| `GET /dashboard/summary` (F0) | ✅ Existe | Se extiende, no se reemplaza |

**F6 depende 100% de piezas ya cerradas y verificadas en F5. Cero dependencia externa bloqueante.**

---

## 6. Riesgos

*(Resumen — desglose completo en §24-26)*

- Riesgo de nombre/alcance: **resuelto** — el PO confirmó el alcance definitivo en §1-3.
- Riesgo de alucinación/sesgo del matching — mitigado por filtros duros deterministas aplicados **antes** de que el LLM vea la lista, margen acotado ±10, y la prohibición explícita de atributos protegidos (§15 del pedido del PO, incorporada en §7.5/§26).
- Riesgo de fragmentación de dashboards — mitigado por diseño (extender `Dashboard.tsx`).
- Riesgo legal/EEOC/NYC LL144 si el matching alguna vez decidiera en vez de proponer — mitigado por el principio D6 extendido explícitamente a "nunca crea Assignment".
- Riesgo de PII innecesaria enviada al LLM — mitigado explícitamente en §7.5/§26 (nunca se envían documentos completos ni datos sensibles al LLM).

---

## 7. Arquitectura propuesta

### 7.1 Principio rector (sin cambios)

Mismo patrón que cada módulo desde F1: `apps/api/src/modules/<módulo>/router.ts` + `service.ts`, contratos Zod en `packages/shared/src/schemas/`, `requirePermission`, *verify-then-act*, `AuditLog`, `Activity`. Para la pieza de IA: patrón híbrido D8 (determinista primero, LLM interpreta/explica), reutilizando `AgentRuntime`/`CostTracker`/`ApprovalGate`/`task-executor.ts` ya construidos (§4.4) — **cero infraestructura de agentes nueva**.

### 7.2 Elegibilidad — filtros duros (antes de cualquier score)

Un Worker **nunca** aparece en la lista de elegibles (aparece en "no elegibles" con el motivo exacto en `disqualifiers`) si:

1. `Worker.status === "TERMINATED"` — disqualifier: `"worker_terminated"`.
2. `Worker.status === "ON_LEAVE"` — disqualifier: `"worker_on_leave"`.
3. `Worker.complianceStatus !== "COMPLIANT"` (es decir, `PENDING` o `BLOCKED`) — disqualifier: `"compliance_not_cleared"`.
4. Ninguna de las `Candidate.categories` del worker coincide con `JobOrder.categoryId` — disqualifier: `"category_mismatch"`.
5. `Worker.status === "ASSIGNED"` **y** tiene al menos una `Assignment` en estado `SCHEDULED`/`ACTIVE` cuyo rango de fechas se solapa con el del `JobOrder` (algoritmo exacto en §7.3) — disqualifier: `"date_overlap"`.

**Corrección respecto al pedido original del PO** (§4.5): las reglas se expresan con los valores reales del enum `AssignmentStatus` (`SCHEDULED`/`ACTIVE`/`COMPLETED`/`TERMINATED`), no con `CLOSED`/`CANCELLED` (que no existen para `Assignment`). La intención — "los estados terminales no bloquean" — se preserva exactamente: `COMPLETED` y `TERMINATED` nunca cuentan para el solapamiento.

Todo Worker que pase estos 5 filtros entra al cálculo de score determinista (§7.4). Los filtros 1-4 son binarios de tipo "nunca". El filtro 5 depende del rango de fechas específico del `JobOrder` consultado — el mismo worker podría ser elegible para un Job Order y no elegible para otro simultáneamente, correctamente.

### 7.3 Disponibilidad real — `isWorkerAvailable(workerId, jobOrder)` (nuevo en F6.2)

Algoritmo determinista, sin geocodificación ni heurísticas:

```
1. Obtener todas las Assignment del worker con status IN ("SCHEDULED", "ACTIVE").
2. Para cada una, calcular su rango [assignment.startDate, assignment.endDate ?? +∞).
3. Calcular el rango del JobOrder consultado: [jobOrder.startDate, jobOrder.endDate ?? +∞).
4. Hay solapamiento si: assignment.startDate <= (jobOrder.endDate ?? +∞)
                     Y  jobOrder.startDate   <= (assignment.endDate ?? +∞)
5. Si CUALQUIER Assignment del worker se solapa → no disponible (disqualifier "date_overlap").
6. Si NINGUNA se solapa → disponible para este JobOrder específico, independientemente
   de si Worker.status es AVAILABLE o ASSIGNED (ASSIGNED solo refleja que tiene AL MENOS
   una asignación activa en algún lado, no que esté ocupado en estas fechas concretas).
```

**Regla conservadora explícita para `endDate = null`** (pedida por el PO como obligatoria, no opcional): un rango sin fecha de fin se trata como **abierto hacia el infinito** — nunca se asume que "probablemente termina pronto". Esto es deliberadamente conservador: prefiere marcar un posible conflicto de más (que un humano puede descartar con un vistazo) a dejar pasar un conflicto real. Se documenta explícitamente en el `rationale`/`warnings` de cualquier resultado afectado por esta regla (ej. *"Este worker tiene una Assignment activa sin fecha de fin declarada — se asumió solapamiento conservador."*).

**Ningún cambio de schema** — usa `Assignment.startDate`/`.endDate` ya existentes; es una función nueva en `matching/service.ts`, no una columna nueva.

### 7.4 Scoring determinista — fórmula v1 (propuesta, versionada, a validar con datos reales una vez implementada)

Aplica únicamente a Workers que ya pasaron los 5 filtros de §7.2. Escala 0-100, pesos explícitos y testeables:

| Factor | Peso máx. | Cómo se calcula | Fuente de datos |
|---|---|---|---|
| Documentos requeridos presentes | 25 | % de `JobOrder.requirements` (keys de `DocumentType`) que el worker tiene como `Document` real, vigente (no `EXPIRED`) — 25 si 100%, proporcional si parcial, cada faltante se lista en `requiredDocumentsMissing` | F5.5 (`Document`/`DocumentType`) |
| Experiencia | 20 | `Candidate.yearsExperience` normalizado, con techo en 10 años (10+ años = 20 puntos, escala lineal por debajo) | F0 |
| Ubicación | 15 | Comparación de texto: misma ciudad = 15, mismo estado (ciudad distinta) = 8, estado distinto = 0 — **sin geocodificación**, consistente con la decisión ya tomada en `F5_STAFFING_OPERATIONS_PLAN.md` §11.2 de no agregar una API de mapas sin aprobación | F0 (`Candidate.city`/`.state`, `JobOrder.location` Json) |
| Alineación de tarifa de pago | 15 | `1 − abs(Worker.defaultPayRate − JobOrder.payRate) / JobOrder.payRate`, acotado a [0,1] y escalado a 15 — penaliza tanto pedir de más como de menos (evita proponer un match que genere fricción salarial en cualquier dirección) | F0/F5 |
| Historial de Assignments | 15 | Bonus si el worker ya tuvo al menos una `Assignment` `COMPLETED` (nunca `TERMINATED`) en la misma `JobCategory` o con la misma `Company` — señal de desempeño ya probado | F5.4 |
| Idiomas | 5 | **Gap real encontrado durante esta auditoría, documentado sin resolver:** `JobOrder` no tiene ningún campo de idioma requerido en el schema actual — no hay contra qué comparar `Candidate.languages` de forma exacta. Este factor se mantiene como señal genérica de baja ponderación (multilingüe = +5, monolingüe = 0), no como un match real contra un requisito — **no se agrega `JobOrder.requiredLanguages` en esta fase** (sería un cambio de schema no incluido, ver §10) | F0 (`Candidate.languages`) |
| Recencia de datos | 5 | Perfil (`Candidate.updatedAt`) actualizado en los últimos 90 días = 5, más antiguo = escala decreciente a 0 — incentivo de higiene de datos, no señal de calidad del worker en sí | F0 |

**Total: 100.** Ningún factor usa, infiere, o deriva atributos protegidos (§7.5).

### 7.5 Seguridad y ética del scoring (obligatorio, no opcional)

- **Nunca se usan como factor de scoring:** raza, etnia, religión, sexo, edad, discapacidad, nacionalidad, embarazo, ni cualquier otro atributo protegido. Ninguno de estos campos existe en `Candidate`/`Worker` (verificado en schema) — no hay ningún dato de este tipo que scoring pudiera usar aunque quisiera.
- **Nunca se infieren atributos protegidos** a partir de nombre, idioma, ubicación o documentos — el servicio de scoring no ejecuta ningún análisis de texto libre sobre `firstName`/`lastName`/`languages`/`city` más allá de las comparaciones exactas ya descritas en §7.4 (idioma = lista exacta de códigos, ubicación = comparación de string exacta ciudad/estado). No se pasa `firstName`/`lastName` al LLM en el prompt — el rationale se redacta con `workerId` + factores ya calculados, nunca con el nombre completo expuesto al modelo (mitiga cualquier sesgo asociado a nombres que suenan de un origen étnico particular — riesgo documentado en la literatura de sesgo de IA en contratación).
- **Nunca se envían al LLM:** documentos completos, contenido de `Document.fileUrl`, ni ningún campo más allá de los factores ya calculados en `matchFactorsSchema` (§14) — el prompt de la capa LLM (§7.6) recibe únicamente números/categorías ya derivados, nunca datos crudos sensibles.

### 7.6 Capa LLM (opcional, encima del score)

1. Cálculo determinista (§7.4) → `deterministicScore`.
2. Filtros de elegibilidad ya aplicados (§7.2) — el LLM nunca ve un worker descalificado.
3. LLM recibe: los factores ya calculados (números + categorías, nunca datos crudos, §7.5) + metadata del Job Order (categoría, ubicación, tarifa) — redacta `rationale` (texto legible) y puede proponer un `llmAdjustment` acotado a **±10 puntos** (mismo margen que `scoreCompany` de F2 ya estableció como precedente, verificado en ese código).
4. `finalScore = clamp(deterministicScore + llmAdjustment, 0, 100)`.
5. El LLM **no puede**: convertir un worker no elegible en elegible (los filtros de §7.2 ya lo excluyeron antes de que el LLM lo vea — estructuralmente imposible, no solo una regla), ignorar compliance bloqueado, ignorar conflicto de fechas, crear datos, ni recomendar la creación de una `Assignment` (el tool no expone ninguna acción de escritura, solo lectura/análisis).
6. **Fallback si OpenAI falla o el presupuesto mensual se agotó** (`getMonthlyBudgetStatus`, §4.4): se devuelve el ranking determinista completo (`deterministicScore` = `finalScore`, `llmAdjustment = 0`), con `llmStatus: "skipped_budget_exceeded"` o `"failed"` marcado explícitamente en el resultado — **la funcionalidad de matching nunca falla completa por un problema del LLM**, degrada con gracia al mismo criterio ya usado por `discoverCompaniesTool`/`findEmailTool` ("sin proveedor configurado, usa solo la fuente gratuita/determinista, nunca inventa").

### 7.7 Agente que lo ejecuta — Recruiter Agent (aprobado, §4.3)

Se gradúa `packages/agents/src/definitions/recruiter.agent.ts` (hoy `tools: []`) agregando `matchWorkersToJobOrder`. Sigue el patrón de dos archivos ya verificado en §4.4: `packages/agents/src/tools/recruiter-tools.ts` (nuevo — declara `matchWorkersToJobOrderInputSchema`/`OutputSchema` con Zod, `execute()` lanza `NotImplementedError` hasta el paso de implementación) + `apps/api/src/modules/agents/tools/recruiter-tools.impl.ts` (nuevo — factory con el `execute()` real, que llama a `matching/service.ts`, nunca Prisma directo — misma regla de oro ya confirmada en `sales-tools.impl.ts`).

### 7.8 Dashboards — arquitectura (heredada de F5 §12, con las secciones exactas aprobadas en §11 del pedido del PO)

Se extiende `GET /dashboard/summary` (F0) con secciones nuevas filtradas por el permiso del usuario que llama, renderizadas condicionalmente dentro de `Dashboard.tsx` — **cero ruta nueva, cero componente de UI nuevo más allá de Card/Table/Badge ya existentes.**

---

## 8. Módulos que compondrán F6

| Módulo/archivo | Tipo | Reutiliza |
|---|---|---|
| `apps/api/src/modules/matching/service.ts` (nuevo) | Nuevo, backend | `scopedDb`, factores de §7.2-7.4 |
| `apps/api/src/modules/matching/router.ts` (nuevo) | Nuevo, backend | `requirePermission("matching.view"/"matching.run")`, `createAndRunTaskSync` de `agents/task-executor.ts` |
| `packages/agents/src/tools/recruiter-tools.ts` (nuevo) | Nuevo, declarativo | Mismo patrón que `sales-tools.ts` |
| `apps/api/src/modules/agents/tools/recruiter-tools.impl.ts` (nuevo) | Nuevo, implementación | Llama a `matching/service.ts`, nunca Prisma directo |
| Extensión de `packages/agents/src/definitions/recruiter.agent.ts` | Extensión (1 línea: `tools: [matchWorkersToJobOrderTool]`) | — |
| Extensión de `apps/api/src/modules/dashboard/service.ts` | Extensión | Ya existe, calcula desde la DB |
| Extensión de `apps/web/src/pages/Dashboard.tsx` | Extensión | Ya existe |
| Extensión de `apps/web/src/pages/JobOrderDetail.tsx` | Extensión | Mismo patrón de secciones read-only ya usado para Assignments en F5.4 |
| `apps/api/src/modules/agents/task-executor.ts` | **Sin modificar** — solo se le agrega una entrada a `TASK_TYPE_TO_TOOL_NAME` (`match_workers_to_job_order: "matchWorkersToJobOrder"`) | Reutilizado tal cual |

**Ningún módulo backend nuevo fuera de `matching/`.** No se crea `projects/`, `marketing/`, `sms/`, ni ningún módulo de integración externa.

---

## 9. Orden exacto de implementación

Ver §30 para la versión formal con nombres de subfase — resumen aquí:

1. F6.0 — Auditoría técnica específica (releer el código real de Worker/JobOrder/Assignment en el momento de implementar).
2. F6.1 — Contratos compartidos de Matching + permiso `matching` (view/run) + grants de rol (seed).
3. F6.2 — `isWorkerAvailable` real (servicio, sin UI todavía).
4. F6.3 — Scoring determinista (`matching/service.ts`, sin capa LLM).
5. F6.4 — Tests backend del scoring determinista + disponibilidad (sin LLM).
6. F6.5 — Recruiter Agent graduado + capa LLM acotada.
7. F6.6 — API (`matching/router.ts`) + integración con `AgentTask`/historial.
8. F6.7 — Frontend en `JobOrderDetail.tsx`.
9. F6.8 — Dashboards por rol.
10. F6.9 — Tests RBAC 403 (deuda de F5).
11. F6.10 — Verificación final + documentación + commit de cierre.

---

## 10. Cambios de schema necesarios (si existen)

**Cero cambios de schema en el alcance aprobado.** Confirmado explícitamente por el pedido del PO (§14: "no aprobar cambios de schema por adelantado... implementar F6 sin cambios de schema, reutilizando `AgentTask.output`, `JobOrder`, `Worker`, `Candidate`, `Assignment`, `Document`, `ComplianceAlert`, `TimeEntry`, `PayrollRun`, `Invoice`, `Payment`"). Todos estos modelos ya existen y ya tienen los campos que F6 necesita (§4.5, §7.2-7.4).

**Cláusula de excepción, tal como la pidió el PO, preservada literalmente:** si durante la implementación (F6.0-F6.10) se encuentra evidencia de que algún cambio de schema es estrictamente necesario (ej. si `AgentTask.output` demostrara ser insuficiente para una consulta real de UI o auditoría, ver §11), **la implementación se detiene, se presenta la evidencia encontrada, se explican las alternativas, y se espera aprobación explícita antes de tocar schema** — mismo protocolo ya usado con éxito para la decisión de `Payment` en F5.8.

**Gap de schema identificado pero NO propuesto como cambio** (§7.4): `JobOrder` no tiene un campo de idioma requerido. Esto se documenta como limitación conocida del factor "Idiomas" del scoring (peso reducido a 5/100, señal genérica), no como un cambio de schema a aprobar en esta fase.

---

## 11. Cambios NO necesarios

- Ningún cambio a `Worker`/`Candidate`/`JobOrder`/`Assignment` — todos los campos que el matching necesita ya existen.
- Ningún modelo `MatchResult` — se reutiliza `AgentTask.output` (Json), tal como aprobó el PO.
- Ningún cambio a `STRICT_TENANT_MODELS`/`HYBRID_GLOBAL_MODELS` — no hay modelo nuevo que agregar.
- Ninguna columna de geocodificación (`latitude`/`longitude`).
- Ningún cambio al modelo `Campaign`/`CampaignCompany`.
- Ningún cambio a `AgentDefinition`/`AgentInstance`/`AgentTask`/`ApprovalRequest` — el modelo ya soporta graduar un agente sin tocar su schema.
- Ninguna activación de `Notification`/`DomainEvent` — quedan dormidos, sin necesidad de tocarlos para F6.
- Ningún cambio a `ApprovalGate.ts` en su forma (tabla estática) — el matching no dispara ninguna tool que requiera aprobación (es de solo análisis); no hay necesidad de agregarlo a `TOOLS_REQUIRING_APPROVAL`.

**Nota sobre `AgentTask.output` como elección de persistencia — verificación de suficiencia (respuesta directa a la instrucción del PO de "detente y presenta evidencia si resulta insuficiente"):** `AgentTask` ya tiene índices por `[tenantId, status]` y `[agentInstanceId, createdAt]` (`schema.prisma` líneas 1185-1186), y el campo `input` (Json) puede incluir `jobOrderId` de forma consultable con un filtro JSON de Postgres (`input->>'jobOrderId'`). Para el volumen esperado de este proyecto (un tenant, decenas de Job Orders, no miles) esto es suficiente para `GET /job-orders/:id/matching/latest`/`history` sin un índice dedicado. **Si en producción real esto demostrara ser lento o insuficiente para un reporte agregado (ej. "tasa de aceptación de matches por categoría, across todos los Job Orders"), esa sería la evidencia concreta a presentar antes de proponer `MatchResult` — no se anticipa este escenario ahora, no se resuelve preventivamente.**

---

## 12. Cambios de API

### 12.1 Diseño elegido y su razonamiento (el PO delegó esta decisión explícitamente: *"no fuerces estas rutas si hay una convención mejor ya establecida"*)

Se auditaron dos convenciones reales ya existentes en el repo (§4.4):

- **Convención A (genérica de agentes):** `POST /agents/:key/tasks`, gateada por el permiso especial único `agents.execute` (compartido por los 9 agentes ya graduados).
- **Convención B (entidad-céntrica):** cada módulo de negocio (Job Orders, Assignments, Invoices...) tiene su propio `router.ts` con permisos de recurso específicos.

**El PO aprobó explícitamente un recurso de permiso dedicado (`matching.view`/`matching.run`), distinto de `agents.execute`** (§15) — esto hace que reutilizar la Convención A tal cual sea incompatible (esa ruta genérica está hardcodeada a `agents.execute` para los 9 agentes existentes; cambiarla para aceptar un permiso distinto por tipo de tarea tocaría un router del que ya dependen y contra el que ya hay tests pasando para Sales/CEO/etc. — riesgo de regresión innecesario para F6). Se elige un **módulo `matching/` propio (Convención B)**, cuyo `router.ts` internamente llama a `createAndRunTaskSync` (la misma función ya compartida, §4.4/§8) — **reutiliza el motor de ejecución real, sin reutilizar ni modificar la ruta HTTP genérica.**

### 12.2 Endpoints nuevos

```
POST /api/v1/job-orders/:id/matching/run
  - Requiere: matching.run
  - Valida: Job Order existe y pertenece al tenant (verify-then-act ya establecido)
  - Verifica presupuesto (getMonthlyBudgetStatus) antes de invocar el LLM
  - Crea un AgentTask (agentKey: "recruiter", type: "match_workers_to_job_order",
    input: { jobOrderId }, triggeredBy: "USER") vía createAndRunTaskSync
  - El tool matchWorkersToJobOrder corre síncronamente (mismo patrón que
    scoreCompany/analyzeIndustry — sin cola, el frontend espera la respuesta)
  - Registra Activity (entityType: "jobOrder") + AuditLog (action: "matching.executed")
  - Devuelve el AgentTask completo (incluyendo su output ya calculado)

GET /api/v1/job-orders/:id/matching/latest
  - Requiere: matching.view
  - Devuelve el AgentTask más reciente de type "match_workers_to_job_order"
    para ese jobOrderId (filtrando input Json), o 404 si nunca se corrió

GET /api/v1/job-orders/:id/matching/history
  - Requiere: matching.view
  - Lista paginada (cursor, mismo patrón que el resto del repo) de AgentTasks
    pasados de matching para ese Job Order — permite comparar corridas
```

### 12.3 Extendido (sin romper compatibilidad)

```
GET /api/v1/dashboard/summary   (F0, ya existe) — se le agregan los campos
                                  nuevos de §13 (uno por rol), cada uno
                                  visible solo si el usuario tiene el
                                  permiso correspondiente
```

### 12.4 Sin cambios a ningún endpoint existente

Job Orders/Workers/Assignments/Compliance/Payroll/Billing/Agents (genérico) permanecen exactamente iguales.

---

## 13. Cambios de frontend

| Página | Cambio |
|---|---|
| `apps/web/src/pages/JobOrderDetail.tsx` | Nueva sección "AI Matching": botón **"Run AI Matching"** (visible solo con `matching.run`), estado `running`/`completed`/`failed` mientras corre, y tras completar: costo (`AgentTask.costUsd`), fecha (`AgentTask.completedAt`), versión del score (`scoreVersion`), tabla de ranking con filtros (elegibles / no elegibles), por cada fila: score, rationale, strengths/gaps, `requiredDocumentsMissing`, evaluación de disponibilidad, evaluación de tarifa, enlace a `WorkerDetail.tsx`. Historial de corridas anteriores (`GET .../matching/history`) en una sub-sección colapsable. Visible con `matching.view` incluso sin `matching.run` (un Operations sin `run` puede ver corridas ya hechas por un Recruiter). |
| `apps/web/src/pages/Dashboard.tsx` | Secciones nuevas condicionales por rol (§13 detallado abajo), reutilizando Card/Table/Badge ya existentes — cero componente nuevo de UI. |
| Ninguna página nueva | No se crea `Matching.tsx` ni un sexto dashboard — consistente con §3. |

**Botón "Create Assignment" desde un resultado de match:** puede existir, pero limitado exclusivamente a navegar/pre-rellenar el formulario ya construido de F5.4 (`POST /assignments`) con `workerId`/`jobOrderId` — el humano sigue confirmando manualmente en la pantalla ya existente, sin lógica de creación nueva. Si esto resulta más complejo de lo esperado durante F6.7, se puede diferir a una aprobación aparte sin bloquear el resto de F6 (el PO ya lo autorizó como "puede existir... pero queda fuera de F6 salvo que reutilice exclusivamente el flujo manual").

---

## 14. Cambios en `packages/shared`

- **Nuevo:** `packages/shared/src/schemas/matching.ts`:
  - `matchFactorsSchema` — desglose de los 7 factores de §7.4, cada uno con su valor y su peso máximo, para que el frontend muestre "por qué" sin recalcular nada.
  - `matchResultItemSchema` — `workerId`, `candidateId`, nombre, categoría/trade, `workerStatus`, `complianceStatus`, `availabilityStatus`, `deterministicScore`, `llmAdjustment`, `finalScore`, `rationale`, `strengths` (string[]), `gaps` (string[]), `disqualifiers` (string[]), `requiredDocumentsMissing` (string[]), evaluación de ubicación, evaluación de tarifa.
  - `matchRunResultSchema` — `jobOrderId`, `generatedAt`, `scoreVersion` ("v1"), `llmStatus` (`"ok"`/`"skipped_budget_exceeded"`/`"failed"`), `costUsd`, `provider`/`model`, lista de `matchResultItemSchema` (elegibles, ordenados por `finalScore` desc) + lista separada de no elegibles (con `disqualifiers`).
  - `runMatchingInputSchema` — vacío o con opciones mínimas (ej. `withLlm: boolean` opcional, default `true`).
- **Extensión:** `dashboardSummarySchema` existente gana los campos nuevos de §13, todos opcionales — el frontend ya filtra por permiso.
- **Sin cambios** a `activityEntityTypeSchema` — el matching registra su `Activity` sobre `entityType: "jobOrder"` (ya existe desde F5.1), no crea una entidad nueva con timeline propio.

---

## 15. Cambios en RBAC

### 15.1 Recurso nuevo — aprobado

`matching` agregado a `PERMISSION_RESOURCES` (`packages/shared/src/permissions.ts`), generando `matching.view`/`matching.create`/`matching.update`/`matching.delete` automáticamente (mismo mecanismo que cada recurso ya declarado) — **pero solo `matching.view` y `matching.run` se usan realmente.** `matching.run` se agrega como permiso especial (`SPECIAL_PERMISSION_KEYS`), no como acción CRUD estándar (no encaja en view/create/update/delete — "ejecutar un análisis" es conceptualmente distinto de "crear un registro"). `matching.create`/`.update`/`.delete` quedan generados pero sin usar — mismo patrón ya aceptado en el repo (`invoices.delete`/`missions.delete` tampoco se usan, documentado explícitamente como aceptable en `seed.ts`).

### 15.2 Grants de rol — mapeo exacto contra la matriz real de 11 roles (verificada en `seed.ts`)

| Rol | `matching.view` | `matching.run` | Justificación |
|---|---|---|---|
| CEO | ✅ (vía `ALL_KEYS`) | ✅ | Aprobado explícitamente por el PO |
| Admin | ✅ (vía `ALL_KEYS.filter(...)`) | ✅ | Aprobado explícitamente por el PO |
| Recruiter | ✅ | ✅ | Aprobado explícitamente — dueño del flujo |
| Operations | ✅ | ❌ | Aprobado explícitamente — "No otorgues `matching.run` a Operations en esta fase" |
| Compliance | ✅ | ❌ | Aprobado explícitamente |
| Payroll | ❌ | ❌ | Aprobado explícitamente ("sin acceso") |
| Sales | ❌ | ❌ | Aprobado explícitamente ("sin acceso") |
| **Manager** | **✅ (propuesto, no en la lista original del PO)** | ❌ | **La matriz real de roles (`seed.ts`) tiene 11 roles, no los 7 que cubrió la instrucción del PO.** `Manager` es un rol de supervisión cross-cutting que ya recibió `.view` de cada recurso operativo nuevo sin pedirlo explícitamente en F5.4 (`assignments.view`) y F5.8 (`invoices.view`) — mismo principio aplicado aquí. **Esto es una extensión propuesta por consistencia de patrón, no una instrucción literal del PO — señalada explícitamente para confirmar o rechazar, no asumida en silencio.** |
| HR | ❌ | ❌ | HR no tiene hoy `jobOrders.view` ni `assignments.view` — sin conexión funcional al matching, se mantiene sin acceso por defecto, consistente con su alcance actual estrecho (candidates/workers/documents) |
| Marketing | ❌ | ❌ | Sin acceso a `jobOrders`/`workers` hoy — sin conexión funcional |
| Accounting | ❌ | ❌ | Rol de facturación, sin conexión funcional al matching de recruiting |

**Nota de nomenclatura:** el pedido del PO menciona "Billing/Finance, si el rol existe" (§11 de su instrucción, para el dashboard, no para matching) — el rol real en este sistema se llama **`Accounting`**, no "Billing" ni "Finance" (verificado en `seed.ts`). La sección de dashboard correspondiente (§13) se gatea con el permiso ya existente `invoices.view`, que hoy tienen `Accounting`, `Manager`, `CEO`, `Admin` — sin necesidad de inventar un rol nuevo.

### 15.3 Sin cambios a `MFA_REQUIRED_PERMISSIONS`

El matching es de solo análisis, sin acción financiera/de acceso sensible — no encaja en el criterio ya usado para esa lista.

### 15.4 Dashboards — sin permisos nuevos

Las secciones de §13 se filtran con permisos **ya existentes** (`candidates.view`, `jobOrders.view`, `assignments.view`, `documents.view`, `timeEntries.view`, `payrollRuns.view`, `invoices.view`) — ninguno nuevo.

---

## 16. Cambios en Activity y AuditLog

- **`AuditLog`:** cada ejecución real de matching (`POST /job-orders/:id/matching/run`) registra `action: "matching.executed"`, `entityType: "jobOrder"`, `entityId: jobOrderId`, `after: { agentTaskId, workersEvaluated, eligibleCount, costUsd, scoreVersion }` — mismo patrón que cada escritura relevante desde F1.
- **`Activity`:** se registra sobre `entityType: "jobOrder"` (ya válido en `activityEntityTypeSchema` desde F5.1) con `type: "SYSTEM"`, `subject: "AI Matching run: N eligible workers found"` — visible en el timeline ya existente de `JobOrderDetail.tsx`, sin timeline nuevo.
- **Dashboards:** ningún registro de auditoría nuevo — es una lectura agregada, mismo criterio que el resto de `dashboard/service.ts`.
- **`GET .../matching/latest`/`.../history`:** son lecturas — no generan `AuditLog` (mismo criterio que cualquier otro `GET` del repo).

---

## 17. Integraciones externas requeridas

**Ninguna.** El matching usa exclusivamente datos ya en la base de datos del tenant; la capa LLM reutiliza `OPENAI_API_KEY` ya configurado, ya usado por 9 agentes. **Confirmado explícitamente por el PO: Indeed/LinkedIn/Twilio/SMS/WhatsApp/job boards/marketing automation quedan fuera de alcance — cero evaluación de proveedor en esta fase (§3).**

---

## 18. Configuración

- Ninguna configuración nueva obligatoria — reutiliza `OPENAI_API_KEY` ya configurado y `Tenant.settings.aiMonthlyBudgetUsd` ya existente.
- Configuración opcional: un flag `settings.matching.llmEnabled` en `Tenant.settings` (Json, patrón ya establecido — ver `security-settings.ts`), default `true`, para desactivar la capa LLM por tenant sin tocar código.

---

## 19. Variables de entorno

**Ninguna variable de entorno nueva.** `OPENAI_API_KEY` ya existe y ya es usada por 9 agentes graduados.

---

## 20. Estrategia de migraciones

**Cero migraciones**, confirmado por el alcance aprobado (§10). Si la cláusula de excepción de §10 se activara durante la implementación, seguiría exactamente el protocolo ya usado en F5.8 para `Payment`: `prisma migrate diff` (no interactivo) para obtener el SQL exacto, inspección antes de aplicar, explicación de impacto, `prisma migrate deploy` (nunca `migrate dev`/`reset`), verificación con `migrate status`/`validate`/`generate`, typecheck inmediato — solo después de aprobación explícita del PO sobre ese cambio puntual.

---

## 21. Estrategia de rollback

- **Código:** el módulo `matching/` es autocontenido — un rollback es dejar de montar `matchingRouter` en `app.ts` (una línea), sin impacto en ningún otro módulo.
- **Agente graduado:** revertir es devolver `recruiter.agent.ts` a `tools: []` — `AgentTask`/`AgentMemory` ya generados quedan como historial, nunca se borran retroactivamente (mismo principio que `AuditLog`).
- **Dashboards:** revertir es remover las secciones nuevas de `Dashboard.tsx` y los campos nuevos de `GET /dashboard/summary` — el endpoint sigue funcionando para todo lo que F0-F5 ya construyeron.
- **RBAC:** revertir el recurso `matching` es dejar de asignarlo en `seed.ts` — las keys ya generadas (`matching.view`, etc.) simplemente no se le asignan a ningún rol, sin necesidad de migración (los permisos viven en filas de `Permission`/`RolePermission`, no en columnas de schema).
- **Sin migraciones en el escenario base** — nada que revertir a nivel de base de datos.

---

## 22. Estrategia de testing

Mismo patrón exacto que cada fase de F5 (306→320 tests sin regresión, integración real contra Postgres, sin mocks de DB):

- Ver §16 del pedido del PO (lista exhaustiva de 18 casos) — incorporada punto por punto:
  - Worker elegible / no disponible / conflicto de fechas / compliance `BLOCKED` / documentos faltantes / categoría incompatible / pay rate incompatible.
  - Ranking correcto + desempates deterministas (mismo `finalScore` → orden estable por `workerId` o criterio declarado).
  - Ajuste LLM dentro del límite ±10 (nunca fuera).
  - OpenAI fallando (mock de error) → fallback determinista, `llmStatus: "failed"`.
  - Presupuesto agotado (`getMonthlyBudgetStatus` ya excedido) → fallback determinista, `llmStatus: "skipped_budget_exceeded"`, **sin llamar a OpenAI en absoluto** (verificado explícitamente, no solo el resultado).
  - Tenancy: un `AgentTask` de matching de un tenant nunca visible desde otro (`runWithTenancyContext({tenantId: "tenant-does-not-exist"...})`, mismo patrón de cada suite de F5).
  - RBAC: 403 para roles sin `matching.view`/`matching.run` según corresponda.
  - `Activity`/`AuditLog` generados correctamente.
  - Historial de matching: dos corridas para el mismo Job Order, ambas recuperables por separado.
  - **Cero Assignment creada automáticamente** — verificado explícitamente contando `Assignment` antes/después de correr matching.
- Fixtures con fechas lejanas (ej. rango 2034, siguiente disponible tras 2029/2031-2032 ya usados por F5.7/F5.8) para aislamiento total.
- Regresión completa obligatoria después de cada cambio.

---

## 23. Estrategia Playwright

Mismo patrón exacto que cada fase de F5 (desktop 1440×900 + mobile iPhone 13 390×844):

1. Sembrar (vía API real) un Job Order abierto con Workers elegibles y al menos uno no elegible (`BLOCKED` o con conflicto de fechas real), para verificar visualmente el filtro.
2. Navegar a `JobOrderDetail.tsx`, click en "Run AI Matching", confirmar estado `running` → `completed`, costo/fecha/versión visibles.
3. Confirmar que la sección de no elegibles muestra el motivo exacto (`disqualifiers`) por worker.
4. Correr una segunda vez, confirmar que el historial muestra ambas corridas por separado.
5. Navegar a `Dashboard.tsx` como al menos 2 roles distintos (`x-dev-user`), confirmar secciones correctas por permiso.
6. Cero errores de consola, cero requests fallidos, ambos viewports.
7. Limpiar cualquier fixture creado, confirmar conteos de seed sin cambios.

---

## 24. Riesgos técnicos

- `ApprovalGate.ts` sigue siendo tabla estática (§4.4/§11) — no aplica a F6 (el matching no dispara ninguna tool que requiera aprobación), pero se documenta como deuda heredada, no nueva.
- Ubicación sin geocodificación real (§7.4) — limitación conocida, aceptada.
- Costo de OpenAI si la capa LLM se invoca sin control — mitigado: solo bajo demanda explícita del botón "Run AI Matching", nunca automático al cargar la página, y con el guardrail de presupuesto ya verificado (§4.4/§7.6).
- `AgentTask.output` como única persistencia (§10/§11) — riesgo bajo, con cláusula de excepción explícita si demuestra ser insuficiente.

## 25. Riesgos funcionales

- Regla conservadora de `endDate = null` (§7.3) puede sobre-marcar conflictos — mitigado mostrando el `warning` explícito en la UI, no ocultándolo.
- Factor "Idiomas" sin un requisito real de `JobOrder` contra qué comparar (§7.4/§10) — señal débil, documentada como tal, peso reducido a 5/100.
- Un match "alto score" puede no ser el mejor en la práctica por factores no capturados (relación personal, preferencia subjetiva del cliente) — mitigado porque el matching siempre es sugerencia, nunca decisión.

## 26. Riesgos de negocio

- Riesgo de sesgo/discriminación (EEOC/Title VII, NYC LL144) — mitigado por §7.5 (exclusión explícita de atributos protegidos, nombre nunca enviado al LLM) y por el principio D6 (la IA nunca decide). El riesgo de auditoría de sesgo formal (NYC LL144, "auditoría anual" si se venden cuentas en NYC) sigue latente y no resuelto por este documento — mismo estado que en cada fase anterior que lo mencionó, no es una regresión nueva de F6.
- Riesgo de PII innecesaria persistida en `AgentTask.input`/`.output` — mitigado por diseño: el snapshot de input es mínimo (`jobOrderId` + IDs de workers evaluados, nunca su CV completo ni documentos).

---

## 27. Decisiones que requerían aprobación del Product Owner — registro de resolución

*(Las 7 decisiones originales de la primera versión de este documento, todas resueltas en la ronda de aprobación del PO. Se conservan aquí como registro histórico de auditoría, no como preguntas abiertas.)*

1. **¿Qué es F6?** → **Resuelto: Matching por IA + Dashboards Operativos** (Opción A del PO), excluyendo explícitamente el roadmap original.
2. **Proveedor de job board/SMS si se retomaba el roadmap original** → **Resuelto: no se retoma, sin evaluación de proveedor.**
3. **¿Qué agente ejecuta el matching?** → **Resuelto: Recruiter Agent**, no Operations Agent.
4. **¿Modelo `MatchResult` nuevo o `AgentTask.output`?** → **Resuelto: `AgentTask.output`**, con cláusula de excepción si demuestra insuficiencia (§10/§11).
5. **¿Reutilizar `jobOrders.view` o crear recurso `matching`?** → **Resuelto: recurso `matching` nuevo** (`matching.view`/`matching.run`).
6. **¿Implementar `isWorkerAvailable` en F6 o dejarlo como limitación conocida?** → **Resuelto: se implementa en F6.2.**
7. **¿Cerrar la deuda de tests 403 de F5 en F6?** → **Resuelto: sí, en F6.9.**

**Única extensión propuesta por este documento que el PO no cubrió explícitamente, señalada para confirmar o rechazar (no una decisión abierta bloqueante — F6 puede empezar sin resolverla, es de bajo riesgo):**

8. **¿Se agrega `matching.view` (no `.run`) al rol `Manager`?** — no estaba en la tabla de 7 roles del PO; se propone por consistencia con el patrón ya repetido de que `Manager` recibe `.view` de cada recurso operativo nuevo (F5.4, F5.8) sin pedirlo explícitamente. Ver §15.2.

---

## 28. Definición de Done (DoD)

- [ ] `POST /job-orders/:id/matching/run` devuelve un ranking real priorizado de Workers elegibles, con `deterministicScore`/`llmAdjustment`/`finalScore`/`rationale`, para al menos un Job Order real.
- [ ] `isWorkerAvailable` implementada y verificada con al menos un caso real de conflicto de fechas.
- [ ] Ningún Worker `TERMINATED`/`ON_LEAVE`/`BLOCKED`/con conflicto de fechas real aparece jamás en la lista de elegibles — verificado con tests explícitos.
- [ ] El matching nunca crea una `Assignment` automáticamente — verificado explícitamente (test + Playwright).
- [ ] El `llmAdjustment` nunca excede ±10 puntos — verificado con un test.
- [ ] Fallback determinista funciona si OpenAI falla o el presupuesto se agotó — verificado sin llamar realmente a OpenAI en ese caso.
- [ ] Resultado persistido en `AgentTask.output`, recuperable vía `.../matching/latest` y `.../matching/history`.
- [ ] Recruiter Agent graduado (`tools` deja de estar vacío), reutilizando `AgentRuntime`/`CostTracker`/`task-executor.ts` sin modificarlos.
- [ ] Recurso de permiso `matching` (`view`/`run`) creado y asignado exactamente según §15.2.
- [ ] Dashboards: secciones nuevas por rol (§13) visibles con datos reales en `Dashboard.tsx`, verificado con al menos 2 roles distintos.
- [ ] Cero páginas nuevas de dashboard.
- [ ] Tests de 403 para los 24 permission keys heredados de F5.1-F5.3 + los nuevos de `matching` — cerrados en F6.9.
- [ ] `Activity`/`AuditLog` generados correctamente en cada ejecución real de matching.
- [ ] Tenancy verificada — un `AgentTask` de matching nunca visible entre tenants.
- [ ] `pnpm typecheck`/`lint`/`test` limpios en todo el monorepo, sin regresión sobre los 320 tests ya existentes.
- [ ] F0–F5.8 intactos.
- [ ] Verificación Playwright real, desktop y mobile, cero errores de consola, cero requests fallidos.
- [ ] Cero cambios de schema aplicados sin aprobación explícita previa (cláusula de excepción de §10, si llegara a activarse).
- [ ] Ningún dato inventado, ningún atributo protegido usado o inferido.
- [ ] Documento de cierre actualizado con el resultado real (§16-§23 en el mismo formato que F5).
- [ ] **F7 no se inicia bajo ninguna circunstancia.**

---

## 29. Checklist completo

- [x] PO aprueba explícitamente el alcance de F6 — **hecho, esta revisión lo incorpora.**
- [x] PO resuelve las Decisiones #1-#7 (§27) — **hecho.**
- [ ] PO confirma o rechaza la extensión propuesta #8 (`Manager` + `matching.view`, §15.2/§27) — puede confirmarse en paralelo, no bloquea el inicio de F6.0.
- [ ] Auditoría técnica específica de matching (F6.0) — releer el código real en el momento de implementar.
- [ ] Contratos compartidos + permiso `matching` (F6.1) antes de tocar backend.
- [ ] `isWorkerAvailable` (F6.2) antes del scoring que depende de ella.
- [ ] Scoring determinista (F6.3) con tests (F6.4) antes de la capa LLM (F6.5).
- [ ] Recruiter Agent graduado (F6.5) reutilizando infraestructura existente sin modificarla.
- [ ] API (F6.6) en módulo propio, sin tocar el router genérico de agentes.
- [ ] Frontend (F6.7) reutilizando componentes existentes, sin página nueva.
- [ ] Dashboards (F6.8) puede correr en paralelo a F6.1-F6.7.
- [ ] Tests RBAC 403 (F6.9) — deuda de F5 + nuevos de `matching`.
- [ ] Verificación continua: typecheck/lint/test completo después de cada paso.
- [ ] Playwright real, desktop + mobile.
- [ ] Commits pequeños, uno por paso.
- [ ] Documentación actualizada al cierre, con evidencia.
- [ ] **Nunca iniciar F7.**

---

## 30. División oficial en subfases (aprobada)

```
F6.0 — Auditoría y baseline (sin código)
  Depende de: nada (F5 ya cerrado y verificado)

F6.1 — Contratos compartidos + permisos matching
  packages/shared/src/schemas/matching.ts
  packages/shared/src/permissions.ts (recurso "matching" + special key "matching.run")
  packages/db/prisma/seed.ts (grants de rol, §15.2)
  Depende de: F6.0

F6.2 — Disponibilidad real (isWorkerAvailable)
  matching/service.ts — función pura, testeable sin HTTP todavía
  Depende de: F6.1

F6.3 — Scoring determinista
  matching/service.ts — los 7 factores de §7.4, sin capa LLM
  Depende de: F6.2

F6.4 — Tests deterministas
  Elegibilidad + disponibilidad + scoring, sin LLM, sin HTTP todavía
  Depende de: F6.3

F6.5 — Recruiter Agent + capa LLM acotada
  packages/agents/src/tools/recruiter-tools.ts
  apps/api/src/modules/agents/tools/recruiter-tools.impl.ts
  packages/agents/src/definitions/recruiter.agent.ts (tools: [...])
  apps/api/src/modules/agents/task-executor.ts (solo agregar entrada a
  TASK_TYPE_TO_TOOL_NAME, sin modificar el resto)
  Depende de: F6.4

F6.6 — API + historial
  matching/router.ts (nuevo módulo) — run/latest/history
  Activity + AuditLog
  Depende de: F6.5

F6.7 — Frontend en JobOrderDetail.tsx
  Depende de: F6.6

F6.8 — Dashboards por rol
  apps/api/src/modules/dashboard/service.ts (extensión)
  apps/web/src/pages/Dashboard.tsx (extensión)
  Depende de: nada de lo anterior — puede correr en paralelo desde F6.1

F6.9 — Tests RBAC 403 (deuda de F5 + matching)
  Depende de: F6.6 (para los de matching) — los de F5.1-F5.3 pueden
  hacerse en cualquier momento, en paralelo a todo F6

F6.10 — Verificación final + documentación + commit de cierre
  Depende de: F6.7, F6.8, F6.9 (todo lo demás debe estar cerrado primero)
```

**No avanzar a una subfase si la anterior no está verificada** (typecheck/lint/test + regresión completa) — mismo hábito disciplinado de cada fase de F5.

---

## 31. Resultado de F6.0 — Auditoría y baseline

F6 fue autorizado a comenzar. Este es el resultado de la auditoría de solo lectura previa a cualquier código funcional — cero cambios de schema, migración, endpoint, UI o graduación del Recruiter Agent; cero llamadas a OpenAI; cero dato real modificado.

### 31.1 Job Orders — campos reales y datos disponibles

`JobOrder`: `companyId`, `projectId?`, `categoryId` (1 sola `JobCategory`, no array), `title`, `description?`, `workersNeeded`/`workersFilled` (derivado en servicio, nunca recalculado a mano en el matching), `billRate`/`payRate` (`Decimal(10,2)`), `location` (`Json? { city, state, address }`), `shiftType`, `scheduleNotes?`, `startDate`/`endDate?`, `status` (`DRAFT|OPEN|PARTIALLY_FILLED|FILLED|CLOSED|CANCELLED`), `requirements` (`Json` array de **keys** de `DocumentType`, ej. `["forklift_cert","drug_test"]`), `urgency`, `createdById?`. Relación real a `Assignment[]` — la disponibilidad real del matching debe leerse desde ahí, nunca de un campo plano.

**Datos reales disponibles:** 4 Job Orders en estado `OPEN`/`PARTIALLY_FILLED` (todas en Chicago, IL, `tenantId=tenant-titan`):

| id | título | status | categoría | requirements | payRate | workersNeeded/filled |
|---|---|---|---|---|---|---|
| `joborder-01` | Forklift Operators — Night Shift | OPEN | Forklift Operator | `forklift_cert`, `drug_test` | 21 | 12/6 |
| `joborder-02` | General Warehouse Associates | OPEN | Warehouse Worker | `drug_test`, `background_check` | 19 | 20/5 |
| `joborder-03` | Journeyman Electricians — Data Center Buildout | PARTIALLY_FILLED | Journeyman Electrician | `electrical_license`, `osha30` | 36 | 8/4 |
| `joborder-04` | Apprentice Electricians — Commercial Build | PARTIALLY_FILLED | Apprentice Electrician | `osha10` | 24 | 6/3 |

### 31.2 Workers — campos reales y datos disponibles

`Worker`: `candidateId` (único, 1:1 con `Candidate`), `employmentType`, `defaultPayRate`, `status` (`AVAILABLE|ASSIGNED|ON_LEAVE|TERMINATED`), `complianceStatus` (`COMPLIANT|PENDING|BLOCKED`), `hiredAt?`, relaciones a `documents`/`assignments`/`payrollItems`/`alerts`. **Categorías, ciudad/estado, idiomas y años de experiencia NO viven en `Worker` — viven en `Candidate` (`Worker.candidate`)**: `categories` (M:N a `JobCategory`), `city`/`state`, `languages` (`String[]`), `yearsExperience?`. El matching debe unir ambos modelos, nunca asumir que `Worker` los tiene directo.

**Datos reales disponibles — 10 Workers, todos `tenant-titan`:**

| Worker | Categoría | Status | Compliance | Docs relevantes | Assignment activa |
|---|---|---|---|---|---|
| worker-01 Valeria Mendoza | Apprentice Electrician | ASSIGNED | COMPLIANT | osha10 VERIFIED | Apprentice Electricians (open-ended) |
| worker-02 Alejandro Vargas | Journeyman Electrician | ASSIGNED | COMPLIANT | electrical_license **EXPIRED** 2026-07-04, osha30 VERIFIED | Journeyman Electricians (open-ended) |
| worker-03 Paola Romero | General Labor | ASSIGNED | COMPLIANT | drug_test **EXPIRED** 2026-06-29 | General Labor (open-ended) |
| worker-04 Roberto Chávez | Warehouse Worker | ASSIGNED | COMPLIANT | drug_test/background_check VERIFIED | General Warehouse (open-ended) |
| worker-05 Cristina Suárez | Forklift Operator | ASSIGNED | COMPLIANT | forklift_cert/drug_test VERIFIED | Forklift Operators (open-ended) — **defaultPayRate 24 > joborder-01.payRate 21** |
| worker-06 Emilio Molina | Apprentice Electrician | ASSIGNED | COMPLIANT | osha10 VERIFIED | Apprentice Electricians (open-ended) |
| worker-07 Natalia Delgado | Journeyman Electrician | ASSIGNED | COMPLIANT | electrical_license VERIFIED (exp 2027-03-11), osha30 VERIFIED | Journeyman Electricians (open-ended) |
| worker-08 Destiny Davis | General Labor | ASSIGNED | **PENDING** | drug_test **PENDING_REVIEW** | General Labor (open-ended) |
| worker-09 Kevin Wilson | Warehouse Worker | **AVAILABLE** | **PENDING** | drug_test VERIFIED, background_check **PENDING_REVIEW** | ninguna |
| worker-10 Brittany Anderson | Forklift Operator | **AVAILABLE** | **BLOCKED** | forklift_cert VERIFIED, drug_test **REJECTED** | ninguna |

### 31.3 Assignments — estados y datos suficientes para disponibilidad

`Assignment`: `workerId`, `jobOrderId`, `projectId?`, `payRate`/`billRate` (**snapshot al asignar** — distinto de `Worker.defaultPayRate`/`JobOrder.payRate`, nunca se debe leer el default como si fuera lo que realmente cobra en esa asignación), `startDate`, `endDate?`, `status` (`SCHEDULED|ACTIVE|COMPLETED|TERMINATED`). Índices reales: `(tenantId, workerId, status)`, `(tenantId, jobOrderId)`.

**Hallazgo real:** las 8 Assignments existentes están todas `ACTIVE` con `endDate = null` (indefinidas) — hay señal real de "ocupado indefinidamente" pero **ninguna** ejerce el caso "solapamiento de fechas con fin definido" (ej. una Assignment que termina antes de que empiece el Job Order objetivo, o después). La lógica de disponibilidad (F6.2) debe soportar `endDate = null` (= ocupado hasta nuevo aviso) y solapamiento de rangos con `endDate` definido, pero **el segundo caso no tiene ejemplo real hoy** — requiere fixture controlado (§31.6).

### 31.4 Compliance — cómo determinar elegibilidad real

`DocumentType` (5 reales: `i9`, `w4`, `osha10`, `osha30`, más los específicos por categoría — `forklift_cert`, `drug_test`, `background_check`, `electrical_license`) — cada uno con `key`, `requiresExpiration`. `Document` liga a `Worker` (o `Candidate`) vía `documentTypeId`, con `status` (`PENDING_REVIEW|VERIFIED|REJECTED|EXPIRED`) y `expirationDate?`. `ComplianceAlert` es informativo (no bloquea matching por sí solo — lo que bloquea es `Worker.complianceStatus`/`Document.status`/`expirationDate`).

**Regla de elegibilidad real derivable del schema (a implementar en F6.2/F6.3, no ahora):** un Worker es elegible para un JobOrder solo si: `worker.status = AVAILABLE`; `worker.complianceStatus = COMPLIANT`; y para **cada** key en `jobOrder.requirements`, existe un `Document` de ese Worker con `documentType.key` igual, `status = VERIFIED`, y (si `requiresExpiration`) `expirationDate` posterior a `jobOrder.startDate` (o a "hoy" como mínimo). Documentos `PENDING_REVIEW`/`REJECTED`/`EXPIRED` para una key requerida excluyen al Worker — el matching nunca debe tratarlos como "parcialmente válidos".

**Cobertura real de casos de no-elegibilidad, ya presentes en datos reales sin fixtures:** `PENDING_REVIEW` (worker-08, worker-09), `REJECTED` (worker-10, causa real de su `BLOCKED`), `EXPIRED` (worker-02 electrical_license, worker-03 drug_test) — **tres subcasos distintos de "documento no válido" ya cubiertos por datos reales**, un hallazgo más rico de lo pedido.

### 31.5 Agent infrastructure

- **Recruiter Agent:** sigue siendo un stub puro — `packages/agents/src/definitions/recruiter.agent.ts` tiene `tools: []`. `AgentDefinition` real ya existe en el seed (`key: "recruiter"`, `description: "Screens candidates, scores CVs, and builds shortlists."`), con su `AgentInstance` por tenant ya creada — **no hace falta graduar nada en F6.0/F6.1**, la graduación real (tools reales) es F6.5.
- **AgentRuntime** (`packages/agents/src/core/AgentRuntime.ts`): ya implementado desde F2 — un solo tool call determinístico por `AgentTask` (`toolName` mapea 1:1 al `type` de la tarea), nunca un planificador libre. F6.5 debe seguir exactamente este mismo patrón, no inventar un mecanismo nuevo.
- **CostTracker** (`packages/agents/src/core/CostTracker.ts`): tabla de precios por modelo (`gpt-4o-mini` es el único modelo con pricing real), `estimateCostUsd`/`estimateCostUsdBlended`. La capa LLM acotada de F6.5 debe registrar costo con este mismo mecanismo, no uno paralelo.
- **AgentTask.output**: campo `Json?` de propósito general, ya usado por todo el pipeline existente para persistir el resultado de cada tarea — F6.6 debe escribir el historial de ejecuciones de matching ahí, sin inventar un modelo nuevo.
- **Activity/AuditLog**: `Activity` es polimórfico (`entityType`/`entityId` string, sin FK real); `AuditLog` tiene `actorType`/`actorId`/`action`/`entityType`/`entityId`/`before`/`after`/`ip`. Ambos ya se usan en todos los módulos de F5 — el matching debe seguir el mismo patrón (`entityType="jobOrder"` o `"matchingRun"`, a decidir en F6.6), nunca un mecanismo de auditoría propio.
- **No existe hoy ningún código de matching/scoring** (`grep -rl "matching\|scoring\|matchScore"` en `apps/api/src`, `apps/web/src`, `packages/shared/src` no arroja ningún módulo real) — F6 parte de cero, sin riesgo de duplicar o chocar con algo existente.

### 31.6 Dashboard — riesgo de duplicar

Existen **dos** dashboards reales hoy, ninguno cubre matching:
1. `apps/api/src/modules/dashboard/service.ts` + `apps/web/src/pages/Dashboard.tsx` — operación general (Workers activos, Candidates por status, fill rate, alertas de compliance, horas/margen semanal). **Cero branching por rol** — hoy todos los usuarios ven exactamente el mismo contenido; RBAC solo oculta enlaces del sidebar, no secciones del dashboard. F6.8 sería el primer dashboard con contenido condicionado por rol en todo el proyecto — no hay un patrón previo que copiar, hay que diseñarlo.
2. `apps/api/src/modules/ai-dashboard/service.ts` — métricas comerciales de IA (F3/F4): empresas analizadas, leads/oportunidades creadas por IA, ROI estimado, costo por campaña. Completamente ajeno a staffing/matching.

**Recomendación (ya reflejada en §30 de este plan):** extender `dashboard/service.ts` + `Dashboard.tsx` con una sección de matching condicionada por rol, no crear un tercer archivo de dashboard — evita fragmentar la vista operativa en 3 lugares distintos.

### 31.7 RBAC — confirmado

`matching.view` y `matching.run` **no existen** en `packages/shared/src/permissions.ts` (ni en `PERMISSION_RESOURCES` ni en `SPECIAL_PERMISSION_KEYS`) — confirmado por lectura directa del archivo, no por búsqueda de texto que pudiera fallar. "matching" tampoco es un recurso CRUD (no tiene create/update/delete con sentido) — deben agregarse como **special permission keys** (mismo patrón que `agents.execute`/`compliance.verify`), no como recurso CRUD. La matriz de 11 roles reales hoy (`ROLE_PERMISSIONS` en `packages/db/prisma/seed.ts`) es: CEO, Admin, Recruiter, Compliance, Payroll, Sales, Operations, Marketing, HR, Accounting, Manager. La matriz aprobada para matching cubre 9 de esos 11 (**Marketing y HR quedan sin mención explícita** — ver §31.9 contradicciones). No se implementó ningún permiso todavía — queda preparado exclusivamente para F6.1.

### 31.8 Baseline de tests

- **Typecheck:** limpio, 0 errores, en los 6 workspace projects (`packages/shared`, `packages/agents`, `apps/marketing`, `apps/web`, `packages/db`, `apps/api`).
- **Lint:** limpio, 0 errores. 2 warnings preexistentes en `apps/web` (`toast.tsx`, `theme.tsx` — `react-refresh/only-export-components`), no relacionados con F6.
- **Backend (`apps/api`):** **320 tests, 319 pass, 1 fail.** El fallo es `scheduler: runProspectingSweep processes a newly imported company and skips it on the next run (real OpenAI calls)` (`src/modules/prospecting/prospecting.test.ts`) — falla de forma consistente y reproducible (no es un timeout intermitente), en el módulo de prospecting/scheduler, **explícitamente fuera de alcance de F6** (`no reabras: ... scheduler`). No se investigó a fondo la causa raíz ni se corrigió, por estar fuera de alcance — hipótesis más probable: el test asume que una Company recién creada aparecerá dentro del lote `take: limit*3` (ordenado por `createdAt` ascendente) de `getUnprocessedCompanyIds`, lo cual deja de cumplirse si `tenant-titan` acumuló suficientes Companies sin procesar más antiguas a lo largo de las fases anteriores del proyecto — no se relaciona con el backfill de Illinois (ese trabajo *redujo* el número de Companies sin procesar de ese tenant, nunca lo aumentó).
- **Frontend:** no existe una suite de tests unitarios para `apps/web` (sin Vitest/Jest configurado) — solo `test:e2e` (Playwright). Confirmado leyendo `apps/web/package.json` directamente.
- **Playwright:** solo existen 3 specs en todo el repo — `dashboard.spec.ts`, `navigation.spec.ts`, `settings-users.spec.ts`. Ninguno es específico de JobOrders/Workers/Assignments/Compliance (F5 se verificó manualmente en navegador, no con Playwright persistido). Se corrieron los 2 relevantes (`dashboard.spec.ts` + `navigation.spec.ts`, que cubren `/job-orders`, `/candidates`, `/companies`, `/settings` y el dashboard) — **5/5 passing**, sin errores de consola. `settings-users.spec.ts` no se corrió (Users/Roles/Auth, ajeno a F6).

### 31.9 Contradicciones y riesgos encontrados

1. **(Riesgo real, no solo teórico) El script `"test"` de `apps/api/package.json` (`node --import tsx --test src/**/*.test.ts`) da un falso positivo silencioso bajo `sh` no interactivo** (el que usan `npm test`/`pnpm test` internamente en este entorno): el glob `**` no se expande recursivamente bajo ese shell, así que solo corren los 8 tests de `src/core/*.test.ts` — **312 de 320 tests (98%) nunca se ejecutan** y el comando termina con exit code 0, como si todo hubiera pasado. Esto no es un problema de F6, es preexistente — pero **cualquier verificación futura de F6 (F6.4, F6.9, F6.10) debe invocar los tests con `find src -name "*.test.ts" | sort` explícito** (como se hizo para este baseline), nunca con `pnpm test`/`npm test` a secas, o el "319/320 passing" reportado sería falso. Se documenta, no se corrige (fuera del alcance de F6.0: "no crear endpoints... no modificar UI" no lo menciona explícitamente, pero tocar `package.json` es un cambio de infraestructura de build que tampoco se pidió — se deja para que el PO decida si corregirlo dentro de F6 o por separado).
2. **La matriz de RBAC aprobada para matching no menciona a Marketing ni a HR** — los 11 roles reales incluyen ambos. Asumir "sin acceso" para los dos (igual que Payroll/Accounting/Sales) es la interpretación más conservadora y consistente con el resto de la matriz, pero es una decisión que no fue explícitamente tomada por el PO — se marca aquí para confirmarla o corregirla antes de F6.1.
3. **Ningún Worker real de hoy es 100% elegible para ningún Job Order abierto** (ver §31.10) — el "caso feliz" (elegible) no existe en datos reales, solo en fixtures controlados. Esto es una propiedad genuina de los datos de seed, no un bug.
4. **`Assignment.payRate`/`billRate` son snapshots**, distintos de `Worker.defaultPayRate`/`JobOrder.payRate` — un Worker ya asignado (ej. worker-05) puede mostrar `defaultPayRate` incompatible con un Job Order aunque su tarifa real snapshotada en la Assignment sea otra. El scoring (F6.3) debe dejar explícito cuál de los dos números usa y por qué (probablemente `defaultPayRate`, ya que la Assignment snapshot es del pasado y no aplica a un match nuevo) — a confirmar en F6.3, no decidido aquí.

### 31.10 Fixtures necesarios para F6.2–F6.4 (no creados todavía — solo documentados)

| Caso pedido | ¿Existe en datos reales? | Detalle |
|---|---|---|
| 1 Job Order OPEN | **Sí** | `joborder-01` (Forklift Operators — Night Shift) |
| 3 Workers reales | **Sí** | worker-05, worker-09, worker-10 (cubren Forklift Operator desde 3 ángulos distintos) |
| 1 Worker elegible (disponible + categoría + compliance + docs OK) | **No — requiere fixture controlado** | Ningún Worker `AVAILABLE` de hoy tiene `complianceStatus=COMPLIANT` con todos los documentos requeridos `VERIFIED`. Los 2 `AVAILABLE` (worker-09, worker-10) están `PENDING`/`BLOCKED` respectivamente |
| 1 no disponible por fechas | **Parcial** | Los 8 Workers `ASSIGNED` están indefinidamente ocupados (`endDate=null`) — cubre "ocupado sin fin definido", pero no el caso de solapamiento de rango con `endDate` definido; ese sub-caso requiere fixture controlado |
| 1 BLOCKED por compliance | **Sí** | worker-10 (Brittany Anderson) — `drug_test REJECTED` |
| 1 con documentos faltantes/no verificados | **Sí (y con 3 variantes reales)** | worker-09/worker-08 (`PENDING_REVIEW`), worker-02/worker-03 (`EXPIRED`) |
| 1 con pay rate incompatible | **Parcial** | worker-10 (`defaultPayRate` 24 > `joborder-01.payRate` 21) es real, pero está entrelazado con su propio `BLOCKED` — un caso aislado (pay-incompatible sin ninguna otra razón de exclusión) requiere fixture controlado para que el test de scoring (F6.3/F6.4) aísle ese factor solo |
| 1 con categoría incompatible | **Sí, abundante** | Cualquier Worker no-Forklift contra `joborder-01` (7 de 10 Workers) |

**Conclusión:** de los 8 casos pedidos, 4 están completamente cubiertos por datos reales, 2 están parcialmente cubiertos (requieren un fixture aislado adicional para no mezclar factores en los tests deterministas de F6.4), y 2 no existen en absoluto hoy y necesitan un fixture controlado y desechable (mismo patrón `*-TEST-FIXTURE` ya usado en el backfill de Illinois) al construirse F6.2–F6.4 — nunca datos permanentes nuevos en el seed.

### 31.11 Confirmación de alcance

Durante F6.0: no se tocó `schema.prisma`, no se creó ninguna migración, no se creó ningún endpoint, no se modificó ninguna UI, no se graduó el Recruiter Agent, no se llamó a OpenAI, no se modificó ningún dato real (todas las consultas fueron `SELECT`/lectura), no se inició F6.1. **El único archivo modificado es este documento.** No se hizo commit.

---

**Este documento refleja el alcance de F6 aprobado explícitamente por el Product Owner.** F6.0 (auditoría y baseline) está completo — ver §31. La siguiente acción es la aprobación explícita del PO para iniciar **F6.1**.
