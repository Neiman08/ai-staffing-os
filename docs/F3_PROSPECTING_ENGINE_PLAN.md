# F3 — Autonomous Prospecting Engine — Propuesta Técnica

**Estado:** Pendiente de aprobación del Product Owner. No se ha escrito código de F3.
**Precedente:** F0, F1 y F2 completados y verificados. Este plan no rompe nada de las fases anteriores — todos los cambios son aditivos.
**Alcance:** este documento cubre el motor de prospección autónoma tal como se especificó. El **Marketplace de Proyectos** se documenta por separado como **F3b** (§17) — propuesta a nivel arquitectura, pendiente de aprobación propia, para no bloquear la entrega de lo que sigue.

---

## 0. Prerrequisitos

- Presupuesto mensual de IA: sigue siendo `Tenant.settings.aiMonthlyBudgetUsd` (F2, default $50). F3 agrega un scheduler que corre sin intervención humana — el mismo guardia de presupuesto de F2 (`budget.ts`) se reutiliza sin cambios: una corrida programada que excedería el presupuesto se rechaza antes de llamar a OpenAI, igual que una manual.
- Dos dependencias nuevas de frontend para los conectores de importación: `papaparse` (CSV) y `xlsx`/SheetJS (Excel) — ambas MIT, sin costo, sin llamada de red (parseo 100% en el navegador). Ninguna dependencia nueva de backend.
- Nada de esto requiere Docker, Redis, ni infraestructura nueva más allá de lo que F0 ya levantó.

---

## 1. Objetivo de F3

Convertir al Sales Agent (F2) de "algo que un humano dispara botón por botón" en un **motor que trabaja solo**: recibe empresas (por import estructurado), las analiza, les asigna un score, crea los registros correspondientes en el CRM, prepara un primer contacto y lo dispone para aprobación humana — todo encadenado, sin que un humano tenga que orquestar cada paso. La prioridad es generar pipeline comercial, no automatizar reclutamiento.

---

## 2. Alcance exacto

**Incluye:**
- **Prospecting Agent** (nuevo `AgentDefinition`, key `prospecting`): orquesta la cadena completa import → análisis → CRM → borrador → aprobación.
- **Market Intelligence Agent deja de ser stub**: gana un tool real de análisis de industria (agregados + LLM), distinto de lo que ya hace Sales Agent.
- **Conectores de carga estructurada**: CSV y Excel (parseados en el navegador), "Google Sheets" soportado vía exportación a CSV (ver §4 — no hay integración viva con la API de Sheets).
- **Scheduler interno** (in-process, sin Redis/BullMQ): re-analiza empresas, recalcula scores, genera follow-ups, detecta inactividad — con cadencia y presupuesto acotados.
- **Memoria del agente** sin pgvector: usa el modelo `AgentMemory` ya existente (sin columna de embedding — sigue diferida) para dos usos concretos y funcionales, no decorativos (ver §7).
- **Dashboard Comercial IA** nuevo (página + endpoint propios).
- Reutiliza al 100% la infraestructura de F2: `AgentTask`, `ApprovalRequest`, `AuditLog`, `CostTracker`, `ApprovalGate`, el guardia de presupuesto, y los tools de Sales Agent ya reales (`scoreCompany`, `identifyContacts`, `createLead`, `draftOutreach`, `suggestFollowUp`).

**No incluye (reafirmado explícitamente, igual que F2):**
- Envío automático de emails, LinkedIn automation, llamadas telefónicas, WhatsApp.
- Scraping agresivo — los conectores son de **carga estructurada**, no de extracción automática de sitios de terceros.
- Redis, BullMQ, Socket.io.
- pgvector / embeddings — la memoria es estructurada (consultas por `entityType`/`entityId`/`scope`), no semántica. Esto es una **desviación consciente del comentario original en `schema.prisma`** ("embedding vector — SE AGREGA EN F3 con pgvector"), que quedaba de una decisión de arquitectura anterior a esta conversación — se actualiza el comentario para reflejar que sigue diferido.
- Marketplace de Proyectos — ver §17 (F3b, propuesta separada).
- Cualquier integración paga o nueva API externa sin aprobación explícita del PO (regla heredada de F2).

---

## 3. Agentes de F3

### 3.1 Prospecting Agent (nuevo)

`AgentDefinition` nuevo, `key: "prospecting"`, autonomía `ASSISTED` (igual que Sales Agent — nada cambia en el modelo de autonomía aprobado). No define tools propios de bajo nivel: su único tool es un **orquestador** que llama, en secuencia, a los tools que ya existen (de Sales Agent) más los pasos nuevos de este plan (crear Contact desde datos importados, crear Opportunity, marcar memoria). Cada paso de la secuencia crea su propio `AgentTask` hijo (`parentTaskId` — campo que existe desde F0, sin usar hasta ahora) para que la cadena completa quede auditable paso por paso, no como una caja negra.

**Tool:** `processCompanyPipeline(companyId)` — ver el detalle completo en §5.

### 3.2 Market Intelligence Agent (deja de ser stub)

Gana **un** tool real, deliberadamente no solapado con lo que ya hace Sales Agent (que opera a nivel de una empresa puntual):

**Tool:** `analyzeIndustry(industryId)` — agregados deterministas sobre **todas** las empresas del tenant en esa industria (cuántas activas, score promedio, job orders abiertos, oportunidades ganadas en los últimos 90 días, tendencia vs. el período anterior) + una capa LLM que redacta un resumen corto explicando la lectura (mismo patrón híbrido D8 que `scoreCompany`). El resultado se guarda como `AgentMemory` (scope `ENTITY`, `entityType: "industry"`) — así se acumula a lo largo del tiempo y el Prospecting Agent lo puede consultar antes de decidir en qué industria buscar más. No requiere aprobación (es análisis interno, `FULL_AUTO`, igual que `scoreCompany`).

`marketIntelligenceAgent.tools` pasa de `[]` a `[analyzeIndustryTool]`. Revenue Agent **sigue como stub** (`tools: []`) — no forma parte de F3.

---

## 4. Conectores de carga estructurada

Nada de scraping. Tres formatos soportados, los tres resueltos con el mismo mecanismo:

| Fuente | Cómo se soporta |
|---|---|
| CSV | Parseado 100% en el navegador con `papaparse`. |
| Excel (.xlsx) | Parseado 100% en el navegador con `xlsx` (SheetJS). |
| Google Sheets | **No hay integración viva con la API de Sheets** (requeriría OAuth + una API nueva — needs aprobación explícita de producto, no solo de código, misma regla que F2 §5). Se soporta indirectamente: el humano exporta su Sheet a CSV (`Archivo → Descargar → CSV`, dos clics nativos de Sheets) y lo sube como cualquier otro CSV. |
| "Listas exportadas" / "directorios empresariales" | Mismo camino: cualquier archivo tabular exportado a CSV/Excel entra por el mismo importador genérico. |

**Por qué sin subida de archivo al backend:** el parseo ocurre en el navegador; el frontend arma un array JSON normalizado (mapeo de columnas → campos de `Company`/`Contact`) y lo manda al backend como body JSON normal, igual que cualquier otro POST de la app. Esto evita meter `multer`/manejo de multipart en el backend — cero infraestructura nueva de subida de archivos, consistente con la decisión ya tomada en F2 de no construir eso.

**Flujo de importación:**
1. Humano sube el archivo → preview de las primeras filas.
2. Mapeo de columnas: `name` (requerido), `industry` (se matchea contra `Industry.name` existente; si no matchea ninguna, esa fila se marca como error y no se importa — no se inventa una industria nueva), `city`, `state`, `website`, `estimatedSize`, y opcionalmente columnas de contacto (`contactFirstName`, `contactLastName`, `contactEmail`, `contactTitle`).
3. Confirmar → `POST /prospecting/import` crea las `Company` (y `Contact` si había datos de contacto) **directamente, sin IA** — importar es carga de datos, no una decisión del agente. La IA entra recién en el paso siguiente.
4. Cada `Company` recién importada queda automáticamente en la cola de "por procesar" del scheduler (§6) — o el humano puede forzar el análisis inmediato de una empresa recién importada con un botón "Analizar ahora".

---

## 5. Workflow de prospección automática

La cadena completa, con la autonomía de cada paso resuelta contra la matriz ya aprobada (Arquitectura §3.4 + reglas de F2, sin cambios):

```
Empresa importada (o ya existente sin procesar)
        │
        ▼
Prospecting Agent: processCompanyPipeline(companyId)
        │
        ├─▶ 1. scoreCompany (Sales Agent, ya existe) ─────────── FULL_AUTO, auditado
        │
        ├─▶ 2. crear Contact si el import trajo datos de contacto
        │      (dato literal del archivo, la IA NUNCA inventa personas —
        │       mismo principio de F2) ──────────────────────── FULL_AUTO, auditado
        │
        ├─▶ 3. createLead (Sales Agent, ya existe) ───────────── FULL_AUTO, auditado
        │
        ├─▶ 4. crear Opportunity (nuevo, determinista — ver nota) ─ FULL_AUTO, auditado
        │
        ├─▶ 5. suggestFollowUp → crear el FollowUp sugerido
        │      (F2 solo "sugería"; F3 sí lo crea automáticamente,
        │       porque crear un recordatorio interno es FULL_AUTO
        │       igual que crear un Lead — nunca sale del tenant) ── FULL_AUTO, auditado
        │
        ├─▶ 6. draftOutreach (Sales Agent, ya existe) ────────── SIEMPRE crea ApprovalRequest
        │                                                          — nunca se envía nada
        │
        └─▶ 7. marcar AgentMemory "empresa procesada"
               (dedup: el scheduler no la vuelve a tocar por N días)
```

Cada paso numerado es un `AgentTask` hijo (`parentTaskId` = la tarea del Prospecting Agent), con su propio `costUsd`/`tokensUsed`/`status`. Si un paso falla, los pasos ya completados **no se revierten** (ej. si falla el paso 6, ya existen Company/Contact/Lead/Opportunity/FollowUp reales y útiles) — la tarea padre queda `FAILED` con el error del paso que falló, pero el trabajo parcial es válido y visible, no se descarta.

**Nota sobre "crear Opportunity" (determinista, no LLM):** igual que en F2 con `createLead`, la IA nunca decide precios ni tarifas (`estimatedPayRate`/`estimatedBillRate` quedan `null` — eso sigue siendo exclusivo de un humano o del futuro Pricing Agent). La Opportunity creada por el pipeline usa: `title` derivado del nombre de la empresa + categoría probable de la industria, `stage: MEETING_SCHEDULED`, `probability: 10` (conservador — es pipeline frío recién creado, no una reunión real agendada), `categoryId` tomado de `Company.possibleCategories` si existe. Queda marcada con `Opportunity.createdByAgentTaskId` (campo nuevo, ver §10) para que el Dashboard y la UI puedan distinguirla.

**Reconciliando "todo automáticamente" con "nada sale automáticamente":** los pasos 1–5 y 7 son creación de registros internos (`FULL_AUTO` según la matriz aprobada desde F0/Architecture §3.4) — corren solos, sin que un humano apruete cada uno. El paso 6 es el único que produce algo pensado para llegar a alguien fuera del tenant, y por eso **siempre** para en una `ApprovalRequest` pendiente — exactamente la misma frontera que F2 estableció y que este plan no toca.

---

## 6. Scheduler interno

In-process, arrancado desde `apps/api/src/index.ts` con un `setInterval` — sin Redis, sin BullMQ, sin proceso separado. Limitación consciente y documentada (igual que el task-runner de F2): en un entorno multi-instancia esto correría duplicado por instancia; aceptable para el volumen actual (una agencia, un proceso Node). Se revisita si el volumen o multi-instancia real lo justifican.

**Cadencia propuesta:** cada 6 horas (4 corridas/día), configurable vía `Tenant.settings.prospectingSweepIntervalHours`. Cada corrida (`AgentTask` con `triggeredBy: "SCHEDULE"`, agente Prospecting):
1. Toma hasta 15 empresas sin procesar (importadas sin `AgentMemory` de "procesada") → corre `processCompanyPipeline` en cada una.
2. Recalcula score de empresas cuyo score tiene más de 14 días de antigüedad (según su `AgentMemory` de "procesada", o `updatedAt` si nunca se procesó) → hasta 15 por corrida.
3. Detecta empresas/leads sin `Activity` en los últimos 21 días → crea un `FollowUp` de re-enganche.
4. Cada sub-paso respeta el guardia de presupuesto de F2 (`budget.ts`, reutilizado sin cambios) — si el presupuesto del mes ya se agotó a mitad de la corrida, el resto de esa corrida se corta ahí, no se fuerza.

**Estimado de costo:** con los costos reales observados en F2 (~$0.0005 por empresa procesada, 2 llamadas LLM), 4 corridas/día × ~30 empresas tocadas ≈ 120 empresas/día × 30 días ≈ 3,600 evaluaciones/mes ≈ **$1.80–2/mes** — muy por debajo del presupuesto de $50 aprobado, con margen amplio.

**Persistencia del estado del scheduler:** la última corrida se guarda en `Tenant.settings.lastProspectingSweepAt` (mismo campo JSON ya usado para `aiMonthlyBudgetUsd`/`activeIndustries` — sin cambio de schema) para no relanzar inmediatamente en cada reinicio del proceso.

**Actor de las corridas programadas:** no hay un usuario humano disparándolas. `TenancyContext.userId` (F2) sigue siendo un `string` obligatorio para el resto del código que lo consume incidentalmente (ej. `followups.assignedToId` fallback) — el scheduler resuelve un "usuario operador" por tenant (el primer usuario con rol Admin o CEO, cacheado al iniciar) solo para satisfacer ese campo; toda la atribución real de las escrituras sigue yendo al `AgentInstance` vía `actor: {type: "AGENT", ...}` (F2), nunca al usuario operador.

---

## 7. Memoria del agente (sin pgvector)

`AgentMemory` ya existe desde F0 (sin columna de embedding, que sigue diferida). F3 le da **dos usos funcionales concretos**, no decorativos:

1. **"Empresas ya analizadas" → dedup del scheduler.** Al terminar `processCompanyPipeline`, se escribe una fila (`scope: ENTITY`, `entityType: "company"`, `entityId`, `content`: resumen corto del resultado). El scheduler consulta esto antes de cada corrida para no reprocesar la misma empresa constantemente — es el mecanismo real que hace que "recordar empresas ya analizadas" signifique algo, no solo una frase.
2. **Memoria de industria (Market Intelligence, §3.2)** → cada corrida de `analyzeIndustry` agrega una entrada (`scope: ENTITY`, `entityType: "industry"`); el Prospecting Agent puede leer la más reciente por industria para decidir dónde priorizar `searchCompanies`.

**Lo que el pedido original menciona pero NO se implementa como memoria nueva, porque ya existe un mecanismo que cumple la misma función sin duplicar datos:**
- *"Correos ya preparados"* → ya es 100% consultable vía `AgentTask`/`ApprovalRequest` (F2). Duplicarlo en `AgentMemory` sería redundante.
- *"Decisiones humanas"* → ya es `ApprovalRequest.status` + `decisionNote` + `AuditLog` (F2). Mismo caso.
- *"Historial de conversaciones"* → **no aplica todavía**. Ningún agente de F0-F3 tiene interfaz conversacional (el Assistant Agent sigue siendo un stub sin LLM real) — no hay conversaciones que recordar. Se deja constancia explícita de esto en vez de inventar un mecanismo sin uso real.
- *"Campañas anteriores"* → el concepto más cercano que existe en F3 es la memoria de industria (#2 arriba); un modelo real de "campaña" no existe y no se propone acá (sería scope creep sin un caso de uso claro todavía).

---

## 8. Aprobaciones

Sin cambios respecto a F2. `draftOutreach` sigue siendo la única acción que crea `ApprovalRequest`, sin importar si quien la disparó fue un humano, el Prospecting Agent, o el scheduler. La bandeja `/approvals` (F2) no cambia — simplemente va a recibir más volumen, generado automáticamente en vez de solo bajo demanda.

---

## 9. Auditoría y costos

100% reutilizado de F2, sin cambios de diseño:
- Cada paso del pipeline y cada corrida del scheduler es un `AgentTask` (con `parentTaskId` ahora sí en uso).
- Cada escritura relevante genera `AuditLog` + `Activity`, atribuida al `AgentInstance` correspondiente (Prospecting, Sales, o Market Intelligence — cada paso queda atribuido al agente que realmente lo ejecutó, no todo al Prospecting Agent).
- `costUsd`/`tokensUsed` se acumulan por tarea igual que en F2; el guardia de presupuesto mensual (`budget.ts`) es el mismo, sin cambios — cualquier corrida (humana o programada) lo respeta por igual.

---

## 10. Cambios de schema

Dos campos nuevos, mismo patrón exacto que F2 (nullable, sin `@relation`, sin backfill):

| Campo | Modelo | Precedente que sigue |
|---|---|---|
| `createdByAgentTaskId String?` | `Opportunity` | `Lead.createdByAgentTaskId` (F2) |
| `createdByAgentTaskId String?` | `FollowUp` | `Lead.createdByAgentTaskId` (F2) |

Nada más. No se toca `Company`, `Contact`, `AgentMemory`, ni ningún modelo existente — todos los campos que el pipeline necesita ya existen. Se actualiza el comentario obsoleto en `AgentMemory.embedding` (que decía "se agrega en F3") para reflejar que pgvector sigue diferido, sin agregar la columna.

---

## 11. Nuevas rutas API

| Método | Ruta | Nota |
|---|---|---|
| `POST` | `/prospecting/import` | Recibe el array ya parseado (frontend) de empresas/contactos, crea `Company`/`Contact` directamente (sin IA). Requiere `companies.create` (permiso ya existente). |
| `POST` | `/prospecting/tasks` | Invoca `processCompanyPipeline` para una `companyId` puntual (botón "Analizar ahora"). Requiere `agents.execute` (ya existente). |
| `GET` | `/ai-dashboard/summary` | Todas las métricas del Dashboard Comercial IA en una sola respuesta (ver §12). Requiere `agents.view` (ya existente). |

No se toca ningún endpoint de F0/F1/F2. El scheduler no expone rutas — corre internamente.

---

## 12. Dashboard Comercial IA

Página nueva (`/ai-dashboard`), no reemplaza el Dashboard operativo de F0 ni Revenue de F1 — es un tercer dashboard enfocado en la actividad del motor de prospección.

| Métrica | Cómo se calcula |
|---|---|
| Empresas analizadas hoy | `AgentTask` tipo `score_company` completadas hoy |
| Empresas nuevas | `Company.createdAt` hoy |
| Leads creados por IA | `Lead.createdByAgentTaskId != null`, hoy/semana |
| Score promedio | `avg(Company.commercialScore)` sobre empresas con score |
| Costo IA (mes) | reutiliza `getMonthlyBudgetStatus()` de F2 — mismo número que ya se muestra en AgentsCenter |
| ROI IA | `sum(Opportunity.estimatedRevenue)` de oportunidades `createdByAgentTaskId != null` ÷ costo IA del mes — **mostrado explícitamente como estimado**, no como revenue realizado (ninguna oportunidad recién creada por el pipeline tiene ingreso real todavía — mostrar esto sin la etiqueta "estimado" sería engañoso) |
| Prospectos pendientes | Leads de IA en estado `NEW`/`CONTACTED`, no convertidos |
| Correos pendientes de aprobación | `ApprovalRequest.status = PENDING` (mismo count que ya existe en `/approvals`) |
| Empresas por industria | `groupBy industryId`, gráfico de barras (recharts, ya es dependencia — sin librería nueva) |
| Mapa de oportunidades | **Simplificado a "por estado"** (barras horizontales por `Company.state`, recharts) en vez de un mapa geográfico real — un mapa SVG/choropleth real necesitaría una librería de mapas nueva, fuera del alcance de F3. Documentado como simplificación deliberada, no como pendiente oculto. |

---

## 13. Nuevas páginas o componentes frontend

- **`ImportCompanies.tsx`** (o un drawer dentro de `Companies.tsx`): upload de CSV/Excel, preview, mapeo de columnas, confirmación → `POST /prospecting/import`.
- **`AIDashboard.tsx`**: la página del §12, con las 10 métricas + 2 gráficos (por industria, por estado).
- **`CompanyDetail.tsx`**: botón "Analizar ahora" (dispara `processCompanyPipeline` para esa empresa puntual) además de los botones ya existentes de F2.
- **Sidebar**: nuevo ítem "AI Dashboard" y "Importar empresas" (o el import vive dentro de la página Companies, a definir en implementación — no cambia el alcance).
- **`AgentsCenter.tsx`**: tarjeta del Prospecting Agent y de Market Intelligence Agent ahora también muestran costo/tareas reales (ya lo hacían para Sales Agent desde F2 — mismo patrón, sin cambios de diseño).

---

## 14. Sistema de prompts

- **Prospecting Agent**: no necesita `systemPromptTemplate` propio — es un orquestador determinista de pasos ya definidos (no llama al LLM directamente, cada sub-paso que sí lo necesita usa el prompt del agente dueño de ese tool, ej. `scoreCompany` sigue usando el prompt de Sales Agent).
- **Market Intelligence Agent**: prompt nuevo, mismo estilo y mismas reglas que el de Sales Agent (nunca inventar datos, toda lectura debe venir de los agregados calculados, nunca prometer nada a nombre de la agencia). Se define en código (`market-intelligence.agent.ts`), igual que F2.

---

## 15. Riesgos

1. **Volumen de `ApprovalRequest` sin revisar.** Si el scheduler genera más borradores de los que un humano revisa, la bandeja se acumula sin que nada se pierda (quedan `PENDING` indefinidamente), pero el valor del sistema baja si nadie las mira. Mitigación: el Dashboard Comercial IA muestra el contador de pendientes de forma prominente; no se automatiza ningún recordatorio nuevo (fuera de alcance) pero el número queda visible.
2. **Datos de importación de mala calidad.** Un CSV con nombres de industria que no matchean ninguna `Industry` existente, o filas duplicadas. Mitigación: el importador rechaza (no inventa) industrias sin match y muestra los errores de mapeo antes de confirmar; duplicados por nombre+industria se detectan y se saltan (no crean una segunda `Company`).
3. **Costos del scheduler descontrolados si el volumen de empresas crece mucho.** Mitigado por el tope de 15 empresas/corrida + el guardia de presupuesto ya existente — un tenant con miles de empresas sin procesar tardaría varios días en cubrirlas todas, no genera un pico de gasto.
4. **Opportunities "de juguete" sin contexto humano.** Crear una Opportunity automáticamente con `probability: 10` y sin tarifas podría confundirse con una oportunidad real trabajada por un humano. Mitigación: el badge "AI" (ya existente para Lead, se extiende a Opportunity) deja esto visualmente inequívoco en toda la UI.
5. **Mismos riesgos legales de F2** (alucinación, CAN-SPAM/TCPA en el contenido del borrador, discriminación algorítmica) — sin cambios, las mismas mitigaciones de F2 §17 siguen vigentes porque el paso que produce contenido externo (`draftOutreach`) es literalmente el mismo código.

---

## 16. Definition of Done

Se puede demostrar en navegador real que:

- [ ] Importa empresas desde un archivo (CSV o Excel) con preview y mapeo de columnas
- [ ] Al importar, cada empresa queda disponible para ser procesada (automáticamente por el scheduler, o manualmente con "Analizar ahora")
- [ ] El pipeline analiza automáticamente una empresa: genera score (con rationale), crea `Company` (si vino de import), crea `Contact` (si el import trajo datos de contacto), crea `Lead`, crea `Opportunity`, genera `FollowUp`, prepara un borrador de correo
- [ ] El borrador de correo crea una `ApprovalRequest` — nunca se envía nada automáticamente
- [ ] Cada paso queda registrado como `AgentTask` (con `parentTaskId` encadenando la corrida completa) y `AuditLog`
- [ ] El scheduler corre una corrida completa sin intervención humana, respetando el tope de empresas por corrida y el presupuesto mensual
- [ ] Market Intelligence Agent produce un análisis real de industria (ya no es un stub) y lo persiste en `AgentMemory`
- [ ] La memoria evita reprocesar la misma empresa en corridas sucesivas del scheduler
- [ ] Dashboard Comercial IA muestra las 10 métricas con datos reales (no mockeados), incluyendo el ROI etiquetado explícitamente como estimado
- [ ] `pnpm typecheck` limpio en todo el monorepo
- [ ] `pnpm lint` limpio en todo el monorepo
- [ ] `pnpm test` — toda la suite (F0+F1+F2+F3) pasa
- [ ] Verificación en navegador real vía Playwright sin errores de consola/HTTP, cubriendo el flujo completo: importar → ver el pipeline correr → ver los registros creados → ver el borrador pendiente → aprobarlo → ver las métricas del dashboard reflejar lo anterior

---

## 17. F3b — Marketplace de Proyectos (propuesta separada, no incluida en el alcance de F3)

Resumen de alto nivel de la idea, para que quede documentada y lista para convertirse en su propio plan detallado una vez que F3 cierre:

- **Qué sería:** además de prospectar *empresas*, detectar *proyectos* concretos (una expansión de planta, un nuevo data center, una nueva fábrica) que impliquen una necesidad de staffing futura, asociarlos a la empresa responsable, y estimar trabajadores/ingresos potenciales para priorizarlos.
- **Por qué no entra en F3 tal cual:** "detectar" un proyecto real (una noticia de que se está construyendo un data center en Iowa) requeriría una fuente de datos externa — y la única forma de hacerlo sin scraping ni APIs nuevas sin aprobar sería, otra vez, carga estructurada manual (alguien pega la info del proyecto). Eso es viable, pero es una superficie nueva completa: un modelo de schema nuevo (el `Project` que ya existe en el schema es para proyectos **operativos** ya contratados — con `companyId` obligatorio y sin campos de estimación/prioridad — no sirve para "proyecto detectado, todavía prospecto"; haría falta algo como `MarketOpportunity` o `ProjectOpportunity`), lógica de priorización nueva, y UI nueva.
- **Cómo encajaría con lo que F3 ya deja construido:** reutilizaría el mismo Prospecting Agent, el mismo patrón híbrido determinista+LLM para estimar trabajadores/ingresos (nunca inventando el número final, igual que `scoreCompany`), la misma `ApprovalRequest` si en algún momento generara outreach, y el mismo Dashboard Comercial IA como lugar natural para mostrar los proyectos priorizados.
- **Siguiente paso real:** una vez aprobado F3, preparar `docs/F3B_PROJECT_MARKETPLACE_PLAN.md` con el mismo nivel de detalle que este documento (schema exacto, rutas, DoD) antes de tocar código.

---

**Siguiente paso:** espero tu aprobación de este plan (en particular la cadencia del scheduler de §6 y el tope de empresas por corrida) antes de tocar `schema.prisma` o escribir código.
