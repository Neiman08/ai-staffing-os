# MASTER PROJECT STATUS — AI Staffing OS

**Generado:** 2026-07-13, por auditoría completa del repositorio (toda la documentación en `docs/`, el monorepo completo, `git log` de los 102 commits, y verificación directa de código: routers, schema, seeds, permisos, tests).
**Naturaleza de este documento:** auditoría de solo lectura. No se modificó ningún archivo de código, no se ejecutó ninguna migración, no se tomó ninguna decisión de producto. Es un reconstructor de la verdad actual del proyecto, no un plan.
**Metodología:** cada afirmación de este documento está verificada contra al menos una de estas fuentes: (a) el contenido real de `docs/*.md`, (b) `git log --oneline` completo, (c) lectura directa de código (`router.ts`, `schema.prisma`, `seed.ts`, `permissions.ts`), (d) resultados reales de `pnpm typecheck`/`lint`/`test` corridos en la sesión anterior. Donde una afirmación de un documento de fase no pudo verificarse contra el código real, se marca explícitamente.

---

## 1. Roadmap completo

### 1.1 Roadmap original (aprobado en la fase de Diseño, julio 2026)

Documentado en `docs/01_ARQUITECTURA_v1.1.md` §8 y `docs/ROADMAP.md`. Este era el plan **antes** de escribir una sola línea de código:

| Fase | Nombre | Objetivo | Alcance planeado | Dependencias |
|---|---|---|---|---|
| Diseño | Arquitectura + schema + specs | Congelar la base técnica antes de codear | Documento de arquitectura, `schema.prisma` completo, prompt de ejecución F0 | Ninguna |
| **F0** | Fundaciones | Monorepo funcional de punta a punta, con datos reales del seed | Monorepo, Docker, Prisma schema, RBAC, tenancy, layout SaaS, 9 páginas de solo lectura, CI | Diseño aprobado |
| **F1** | Core Staffing | CRUD completo de la operación de staffing | Companies, Contacts, Job Orders, Candidates (con CV upload), Workers, Projects, Assignments; Clerk real | F0 |
| **F2** | Compliance + Time | Verificación real de compliance y horas | DocumentTypes, Documents, verificación manual, alertas de vencimiento, TimeEntries, aprobación de horas | F1 |
| **F3** | AI Agents v1 ★ | Primeros 3 agentes con comportamiento real | AgentRuntime + tools + memoria (pgvector), Recruiter/Compliance/Assistant Agents, AI Agents Center, ApprovalRequests | F2 |
| **F4** | Orquestación + Agents | Orquestación event-driven + agentes operativos | Orchestrator (Redis/BullMQ), Operations/Payroll/Pricing/CEO Agents, payroll runs, invoices PDF | F3 |
| **F5** | Ventas + Facturación pro | CRM comercial + facturación real | Sales Agent, pipeline CRM, tax engine externo (Check/Gusto), pagos Stripe | F4 |
| **F6** | Marketing + Integraciones | Canales externos de adquisición | Marketing Agent, Indeed/LinkedIn, Twilio SMS con TCPA | F5 |
| **F7** | SaaS multi-tenant | Producto vendible a múltiples agencias | Onboarding self-service, billing de plataforma, SOC 2 readiness, observabilidad | F6 |

**MVP vendible planeado = cierre de F3** (~3 meses).

### 1.2 Lo que realmente ocurrió: los nombres de fase se reutilizaron para un alcance completamente distinto

Este es el hallazgo más importante de esta sección. A partir de F1, el proyecto **abandonó el orden y el contenido del roadmap original** y ejecutó, bajo los mismos nombres de fase (F1, F2, F3, F4), un producto distinto: un motor comercial de prospección y outreach impulsado por IA, en vez de terminar primero el "Core Staffing" operativo (candidatos, compliance, payroll). Esta decisión está documentada y fue deliberada — cada plan de fase real (`F1_REVENUE_ENGINE_PLAN.md`, etc.) lo dice explícitamente — pero el efecto acumulado es que **el roadmap original de F1/F2/F4 (CRUD de candidatos, compliance, payroll runs) nunca se construyó**, mientras el proyecto avanzó hasta un F4.9 real siguiendo un plan casi enteramente distinto al original.

### 1.3 Roadmap real ejecutado (reconstruido de `docs/` + `git log`)

| Fase | Nombre real | Objetivo | Alcance ejecutado | Dependencias |
|---|---|---|---|---|
| **F0** | Fundaciones | Igual al plan original | Monorepo, schema (36→41 modelos), 8 módulos de solo lectura, 9 páginas, dev-bypass, tenancy, RBAC, seed | Diseño |
| **F1** | Revenue Engine (CRM comercial) | **Reemplaza** el "Core Staffing" original — pivote a conseguir clientes antes de perfeccionar operación | Leads, Opportunities, Pipeline Kanban, FollowUps, Activities, Revenue dashboard — CERO trabajo en Candidates/Workers/JobOrders/Compliance/Payroll más allá de F0 | F0 |
| **F2** | AI Sales Agent | Primer agente con LLM real | `LLMProvider`(OpenAI)/`AgentRuntime`/`CostTracker`/`ApprovalGate` reales, Sales Agent (7 tools), bandeja de Approvals | F1 |
| **F3** | Prospecting Engine | Motor de prospección automática | Prospecting Agent (orquestador), Market Intelligence Agent (deja de ser stub), import CSV/Excel, scheduler in-process, AI Dashboard, `AgentMemory` (sin pgvector) | F2 |
| **F3b** | Project Marketplace | **Propuesta, nunca implementada** | Solo documento (`F3B_PROJECT_MARKETPLACE_PROPOSAL.md`) — detección de proyectos de expansión, modelo `ProjectOpportunity` — cero código | F3 |
| **F3.5** | Rediseño visual (Mission Control) | Pulido visual del CRM interno, sin cambios de lógica | Design system, AgentsCenter/Dashboard/AIDashboard/Companies/Revenue rediseñados ("Mission Control") — commits `F3.5-1`…`F3.5-7`, **sin documento de plan propio** | F3 |
| **F4** | Autonomous Outreach Engine | SDR autónomo completo | `Campaign`/`CampaignCompany`, Outreach Agent, Conversation Agent, secuencias día 1/4/9/18, **Daily Revenue Mission** (CEO Agent orquestador), Business Objective, Executive Report | F3 |
| **F4.5** | External Discovery & Communications | Planeado como "descubrir empresas fuera del CRM + enviar correo real" | **Parcial:** F4.5A (piloto, OpenStreetMap Overpass) + Addendum 2 (Google Places como proveedor primario) implementados y verificados. Envío de correo/Gmail se **redirigió a F4.7** | F4 |
| **F4.6** | Contact Intelligence Agent | Enriquecimiento real de contactos | People Data Labs, `contact_intelligence` agent — **implementado, pero sin documento de plan propio** (solo referenciado retrospectivamente en el §0 de F4.7) | F4.5 |
| **F4.7** | Email Intelligence & Verified Outreach | Encontrar/verificar emails reales + enviarlos vía Gmail real | **Parcial:** Website Intelligence + Hunter.io (discovery/verification) implementados y verificados. Gmail OAuth, envío controlado, deliverability (SPF/DKIM/DMARC), lectura de inbox — **bloqueados (B3/B5/B6), nunca implementados** | F4.6 |
| **F4.7.5** | Production Cleanup | Auditoría de datos reales vs. demo, sin ejecutar nada | Clasificador de origen, plan de limpieza, detección de duplicados, plan de fusión, Data Quality Score — **100% de solo lectura, ninguna función de ejecución existe** | F4.7 |
| **F4.8** | Sitio público (`apps/marketing`) | Sitio de marketing de DreiStaff | 11 páginas públicas, 3 formularios → CRM (`/public/*`), branding centralizado | F4.7.5 |
| **F4.8A** | Premium Visual Redesign | Rediseño visual completo del sitio público | Paleta nueva, Hero/BenefitsStrip/CTABand/Footer rediseñados, fotografía real | F4.8 |
| **F4.8B** | Premium Visual Polish | Segunda pasada de pulido visual | **Pausado a mitad de camino** — hero photo mal etiquetada detectada y no reemplazada, CTA/spacing sin terminar; ningún cambio de código llegó a commitearse (working tree limpio) | F4.8A |
| **F4.9** | Production Authentication (Clerk) | Autenticación real de producción | `ClerkAuthProvider`, webhooks, MFA, invitaciones, guards de frontend, tests — **construido casi completo, pero pausado indefinidamente por decisión del PO antes del paso final de verificación real contra Clerk** | F4.8 |
| **F4.9-D** | Deployment readiness (sin Clerk) | Preparar despliegue a Render sin depender de Clerk | `render.yaml`, `start:deploy`/`migrate:deploy`, `VITE_API_URL`, usuario dev-bypass configurable, verificación de flujos — **completado**, pero el despliegue real a Render nunca se ejecutó (decisión pendiente: `NODE_ENV`) | F4.9 (pausado) |
| F5 | Ventas + Facturación pro (original) | Sin empezar | Sales Agent (ya existe, con otro alcance), pipeline CRM (ya existe), tax engine (Check/Gusto), Stripe | — |
| F6 | Marketing + Integraciones (original) | Sin empezar | Marketing Agent (sigue stub), Indeed/LinkedIn, Twilio SMS | — |
| F7 | SaaS multi-tenant (original) | Sin empezar | Onboarding self-service, billing de plataforma, SOC 2 | — |

---

## 2. Estado real

| Fase | Estado | Por qué |
|---|---|---|
| Diseño | ✅ Completa | Arquitectura aprobada, schema congelado, nunca se revirtió. |
| F0 | ✅ Completa | DoD verificado en navegador real, 9/9 páginas, tests de tenancy+RBAC pasando. Reporte de cierre firmado por el PO. |
| F1 | ✅ Completa (con alcance redefinido) | DoD verificado con datos reales, 22 commits, ningún test de F0 roto. **Pero no es lo que "F1" significaba en el roadmap original** — el CRUD de Candidates/Workers/JobOrders sigue exactamente como F0 lo dejó. |
| F2 | ✅ Completa | Primer agente con LLM real, verificado con llamadas reales a OpenAI, 21/21 tests. |
| F3 | ✅ Completa | Scheduler in-process funcional, verificado con corridas reales, 28/28 tests. |
| F3b | ⏳ Pendiente (nunca aprobada) | Es una propuesta documentada, el propio documento dice "no se implementa nada de esto durante F3" — sigue sin plan detallado ni código. |
| F3.5 | ✅ Completa (inferido de `git log`, sin DoD documentado) | 7 commits (`F3.5-1`…`F3.5-7`) cubren rediseño visual de Mission Control. Sin documento de plan ni reporte de cierre — no se pudo verificar un DoD formal, pero no hay señales de trabajo a medias en el código actual. |
| F4 | ✅ Completa | Daily Revenue Mission incluida, 39/39 tests, verificación de punta a punta con aprobación real desde `/approvals`. |
| F4.5 | 🟡 Parcial | F4.5A (Overpass) y el addendum de Google Places están implementados y verificados con datos reales. La mitad "Communications" del plan original (Gmail, envío, calendario, SPF/DKIM/DMARC) se **redirigió explícitamente a F4.7** — nunca se implementó bajo el nombre F4.5. |
| F4.6 | ✅ Completa (funcionalmente), 🟡 en documentación | El código (People Data Labs, Contact Intelligence Agent) está implementado y, según F4.7 §0, verificado. **No existe un documento de plan propio** (`F4_6_...md`) — es la única fase completada sin su propio plan técnico aprobado por separado, ruptura del patrón que todas las demás fases siguieron. |
| F4.7 | 🟡 Parcial, explícitamente no cerrable todavía | Confirmado por el propio documento: "F4.7 sigue sin poder marcarse completada" hasta resolver Gmail OAuth, deliverability y envío controlado. Lo implementado (Website Intelligence, email discovery, email verification) está verificado con datos reales (Hunter.io real, 0 mocks). Lo pendiente (Gmail/envío/inbox) está bloqueado por decisiones de negocio del PO (cuenta de Workspace, dirección postal, DNS), no por trabajo de ingeniería pendiente. |
| F4.7.5 | ✅ Completa (dentro de su propio alcance limitado) | Explícitamente diseñada para ser 100% auditoría/planes, "nada ejecutado" — cumple ese objetivo acotado. No resuelve limpieza real de datos ni fusiones (por diseño, no por estar incompleta). |
| F4.8 | ✅ Completa | Sitio público con 11 páginas + 3 formularios conectados al CRM, verificado. |
| F4.8A | ✅ Completa | Commit `626c0b3`, verificación final con Playwright/capturas documentada. |
| F4.8B | 🟡 Parcial, pausada explícitamente | Solo llegó a la fase de investigación (búsqueda de foto de hero correcta); el usuario detuvo el proceso y luego redirigió el trabajo a F4.9-D. Ningún archivo de `apps/marketing` tiene cambios sin commitear — el working tree está limpio, confirmando que ningún cambio de F4.8B quedó a medias en el código. |
| F4.9 | 🟡 Parcial, pausada indefinidamente por decisión explícita del PO | Código construido casi en su totalidad (`ClerkAuthProvider`, webhooks, MFA, invitaciones, frontend, tests) — 11 de 12 pasos completados. El paso 12 (verificación real contra una cuenta de Clerk real) está marcado como diferido indefinidamente. `AUTH_MODE=dev-bypass` sigue siendo el único mecanismo activo. |
| F4.9-D | ✅ Completa (dentro de su alcance: preparación, no despliegue real) | Los 6 pasos (D1–D6) verificados: typecheck/lint/tests/build limpios, flujos principales navegables sin bloqueo de auth. **El despliegue real a Render nunca ocurrió** — sigue pendiente una decisión del PO sobre `NODE_ENV` en producción con `AUTH_MODE=dev-bypass`. |
| F5 (original) | ⬜ No iniciada | Nunca se abrió un documento de plan bajo este alcance (tax engine externo, Stripe). |
| F6 (original) | ⬜ No iniciada | Marketing Agent sigue como stub desde F0 (`tools: []`), sin plan documentado. |
| F7 (original) | ⬜ No iniciada | Ningún trabajo de multi-tenancy real (hoy 1 solo tenant, `titan`), sin onboarding self-service. |

---

## 3. Funcionalidades implementadas (lista completa, no resumida)

### 3.1 Infraestructura y plataforma

- Monorepo pnpm (`apps/api`, `apps/web`, `apps/marketing`, `packages/db`, `packages/shared`, `packages/agents`), TypeScript estricto en las 6 unidades.
- Prisma: **41 modelos, 44 enums, 9 migraciones** (`init` → `f4_9_production_auth`), todas aplicadas limpias, ninguna con pérdida de datos.
- Multi-tenancy: `AsyncLocalStorage` + Prisma Client Extension, filtro automático de `tenantId` en modelos estrictos + modelos híbridos globales (Industry, JobCategory, DocumentType, RateBenchmark).
- RBAC: 13 recursos × 4 acciones CRUD + 9 permisos especiales = permisos reales sembrados (`payroll.approve`, `compliance.verify`, `compliance.block`, `agents.view/configure/execute`, `approvals.decide`, `settings.manage`, `users.manage`). 11 roles reales (CEO, Admin, Recruiter, Sales, Payroll, Compliance, Operations, Marketing, HR, Accounting, Manager).
- Auth: interfaz `AuthProvider` pluggable; `DevBypassAuthProvider` activo (header `x-dev-user` o `DEV_DEFAULT_USER_EMAIL` configurable por env); `ClerkAuthProvider` construido pero dormido (ver §F4.9).
- Auditoría: `AuditLog` (modelo inmutable, actor HUMAN/AGENT/SYSTEM) usado activamente por agentes, aprobaciones y (código listo, sin verificar en vivo) eventos de auth.
- 22 módulos backend reales (`activities, agents, ai-dashboard, approvals, auth, branding, campaigns, compliance, crm, dashboard, discovery, followups, jobs, leads, missions, opportunities, payroll, pricing, production-readiness, prospecting, public, revenue, talent`).
- 25 páginas frontend en `apps/web` + 12 páginas públicas en `apps/marketing`.
- 68+ endpoints HTTP documentados acumulados a través de las fases (verificado: 22 módulos de router reales al día de hoy).
- Suite de tests backend: **138/139 pasando** (el único fallo es un test dependiente de red externa — Hunter.io/Website Intelligence — que siempre termina `DONE` de forma honesta, nunca inventa un email; falla intermitente, no un bug del código).
- `pnpm typecheck` y `pnpm lint` limpios en todo el monorepo (2 warnings preexistentes de `react-refresh/only-export-components`, sin errores).
- `pnpm build` exitoso en `apps/web` y `apps/marketing` (Vite).

### 3.2 CRM comercial (F1)

- Companies (CRUD completo, campos extendidos: `city`/`state`/`estimatedSize`/`possibleCategories`/`commercialScore`), Contacts (CRUD completo, `decisionRole`, `linkedinUrl`), Leads (CRUD + `convert-to-opportunity`), Opportunities (CRUD), Pipeline Kanban de 8 columnas con drag-and-drop, FollowUps (bandeja Hoy/Vencidos/Próximos), Activities (timeline polimórfico universal), Revenue dashboard (Sales Dashboard + Revenue Intelligence, calculado desde la DB en cada request).

### 3.3 Agentes de IA con comportamiento real (LLM real, no stub)

- **Sales Agent** (`sales`): `searchCompanies`, `detectHiringSignals`, `identifyContacts`, `createLead`, `scoreCompany`, `suggestFollowUp`, `draftOutreach`, `createOpportunity`, `createFollowUp`.
- **Market Intelligence Agent** (`market_intelligence`): `analyzeIndustry` (agregados + LLM, memoria de industria).
- **Prospecting Agent** (`prospecting`): `processCompanyPipeline` (orquestador de la cadena scoreCompany→createLead→createOpportunity→suggestFollowUp→draftOutreach).
- **Campaign Agent** (`campaign`): `createCampaign`, `selectTargetCompanies`, `measureCampaign`, `optimizeCampaign`.
- **Outreach Agent** (`outreach`): `planSequence`, `personalizeMessage` (redacción just-in-time, nunca los 4 pasos por adelantado), `suggestNextStep`.
- **Conversation Agent** (`conversation`): `classifyConversation` (10 categorías de intención tras la ampliación de F4.7, vocabulario cerrado con Zod).
- **CEO Agent** (`ceo`): `interpretDailyDirective` (Daily Revenue Mission, único LLM del agente, vocabulario cerrado a industrias/categorías reales del tenant), `closeDailyMission` (Executive Report).
- **Discovery Agent** (`discovery`): `discoverCompaniesTool` — descubrimiento real vía OpenStreetMap Overpass (respaldo gratuito) y Google Places API (proveedor primario, aprobado y con gasto real verificado).
- **Contact Intelligence Agent** (`contact_intelligence`): enriquecimiento real vía People Data Labs (F4.6) + `findEmail` (Website Intelligence propio con `cheerio`/`robots-parser`, + Hunter.io como respaldo, F4.7).

Todos comparten: `LLMProvider` (OpenAI, `gpt-4o-mini`), `AgentRuntime`, `CostTracker`, `ApprovalGate`, guardia de presupuesto mensual (`aiMonthlyBudgetUsd`) + guardia de presupuesto de proveedores de datos (`dataProviderBudgetUsd`) + guardia de presupuesto diario de misión (`dailyMissionBudgetUsd`). Ningún agente envía nada a un tercero sin pasar por `ApprovalRequest` — frontera mantenida intacta a través de F2→F4.7.

### 3.4 Agentes definidos pero sin comportamiento real (siguen siendo stubs desde F0/F1)

`recruiter`, `compliance`, `assistant`, `pricing`, `operations`, `payroll`, `marketing`, `admin` — **8 de 17 `AgentDefinition` sembradas nunca recibieron un tool real ni un `systemPromptTemplate` funcional.** Existen en el AI Agents Center como tarjetas, pero invocarlas no ejecuta ningún comportamiento de negocio.

### 3.5 Sitio público (`apps/marketing`, F4.8/F4.8A)

- 12 páginas: Home, Employers, Candidates, Industries, About, Careers, Contact, RequestTalent, Privacy, Terms, Login, NotFound.
- 3 formularios reales conectados al CRM vía `/public/*` (Contact, Request Staff → Lead, Apply for Jobs → Candidate), con rate limiting (10/15min en escritura, 60/min en lectura) y validación Zod.
- Branding centralizado (`GET /api/v1/branding`), nunca hardcodeado — marca DreiStaff, dominio `dreistaff.com`, entidad legal Data More LLC.
- Rediseño visual premium (paleta `#2563EB`/`#0A1220`, fotografía real con licencia, componente `Photo` con fallback seguro).

### 3.6 Producción y despliegue (F4.9-D)

- `render.yaml` (Blueprint de Render: base de datos + servicio web para `apps/api`), `start:deploy`/`migrate:deploy` (sin wrapper `dotenv-cli`, compatibles con env vars nativas de Render), `VITE_API_URL` configurable en el frontend para apuntar a un origen distinto.
- CORS ya restringido por allowlist desde F4.9-2 (`APP_ORIGIN`/`MARKETING_ORIGIN`), listo para Render sin cambios de código.
- **Nada de esto se desplegó realmente** — es preparación de código, verificada localmente.

### 3.7 Auditoría y limpieza de datos (F4.7.5, solo lectura)

- Clasificador de origen (`DEMO/SEED/MANUAL/GOOGLE_PLACES/PEOPLE_DATA_LABS/WEBSITE/HUNTER/API_PROVIDER/IMPORT/USER_CREATED/UNKNOWN`) sobre datos reales, sin columnas nuevas.
- `GET /production-readiness/{audit,cleanup-plan,duplicates,merge-plan,summary}` — todos de solo lectura, ninguna función de ejecución implementada.
- `Production Mode` (`PRODUCTION_MODE=false` por defecto, nunca activado) que ocultaría datos demo si se activara.

---

## 4. Funcionalidades pendientes (lista completa, agrupada por prioridad)

### 4.1 Prioridad alta — núcleo operativo de staffing (nunca construido más allá de F0)

Esto es, textualmente, lo que el producto necesitaría para que una agencia real *opere* con él en vez de solo mirar datos de seed:

- **Candidates:** creación/edición real, upload de CV (hoy `resumeUrl` es un string simulado), conversión candidate→worker (`POST /candidates/:id/convert-to-worker`, mencionado en la Arquitectura original, nunca implementado).
- **Workers:** **cero API** — el modelo existe en el schema desde F0 con datos de seed, pero no hay `router.ts` de workers en absoluto (confirmado: `apps/api/src/app.ts` no monta ningún router de workers).
- **Job Orders:** solo `GET` — no hay creación, edición, ni el endpoint de matching (`POST /job-orders/:id/match`) previsto en la Arquitectura original.
- **Projects / Assignments:** **cero API** — mismo caso que Workers, modelos con datos de seed sin ninguna ruta HTTP.
- **Compliance:** solo `GET` de `documents`/`compliance/alerts`/`document-types` — no existe `POST /documents/:id/verify`, ni un flujo de resolución de alertas, ni upload real de documentos.
- **Payroll:** solo `GET /time-entries` — no hay aprobación de horas (`POST /time-entries/bulk-approve`), no hay `PayrollRun` (creación/aprobación/export), pese a que el modelo completo existe en el schema desde F0.
- **Billing/Invoices:** el modelo `Invoice`/`Contract` existe en el schema, **cero API, cero UI** en cualquier fase hasta hoy.
- **Pricing:** solo `GET /pricing/scenarios` — no hay creación de nuevos escenarios vía UI/API, y el "Pricing Intelligence Agent" descrito en la Arquitectura (§6.5) sigue siendo un stub sin tools.

### 4.2 Prioridad media — fases con trabajo iniciado, bloqueadas por decisiones de negocio (no de ingeniería)

- **F4.7 (Gmail/envío real):** Gmail OAuth, cifrado de tokens, envío controlado con doble gate, deliverability (SPF/DKIM/DMARC), lectura de inbox — todo el diseño está documentado en detalle (`GmailConnection`/`EmailMessage`, `MailProvider`), bloqueado por B3 (crear proyecto de Google Cloud/OAuth Client), B5 (dirección postal comercial real, correo de envío), B6 (subdominio de envío, SPF/DKIM/DMARC).
- **F4.9-12 (verificación real con Clerk):** diferida indefinidamente por decisión explícita del PO (uso interno, ≤5 personas, sin necesidad de auth de producción por ahora). El código ya construido (`ClerkAuthProvider`, webhooks, MFA, invitaciones, tests) queda intacto y sin activar.
- **Despliegue real a Render:** `render.yaml` listo, pero nunca ejecutado. Bloqueado por: (a) decisión pendiente sobre `NODE_ENV` en convivencia con el guard `AUTH_MODE=dev-bypass` prohibido en producción, (b) el PO nunca conectó su cuenta real de Render.
- **F4.8B (pulido visual del sitio público):** pausado a mitad de la búsqueda de la foto correcta del hero; CTA gradient/spacing/consistencia de tarjetas sin terminar.
- **F3b (Project Marketplace):** propuesta de alto nivel documentada, sin plan técnico detallado ni aprobación — requiere decidir primero la fuente de datos de "proyectos anunciados" (carga manual vs. scraping de permisos/noticias, ambos con trade-offs ya documentados).

### 4.3 Prioridad baja — roadmap original de fases futuras (sin empezar)

- **F5 (original):** tax engine externo (Check/Gusto Embedded), pagos Stripe de invoices.
- **F6 (original):** Marketing Agent real, publicación en Indeed/LinkedIn, Twilio SMS con opt-in TCPA.
- **F7 (original):** onboarding self-service multi-agencia, billing de plataforma, SOC 2 readiness, observabilidad.
- **Principio de autonomía progresiva, niveles 3/4:** documentado como principio permanente (`01_ARQUITECTURA_v1.1.md` §3.5), pero `ApprovalGate.ts` todavía no lee `AgentInstance.autonomyLevel` en runtime — sigue siendo la tabla estática de la matriz original.
- **`AgentMemory` con pgvector:** diferido desde F0, sigue sin columna de embedding; los usos actuales son estructurados (dedup, memoria de industria), no semánticos.
- **Redis/BullMQ:** el scheduler in-process (sin colas reales) sigue siendo de una sola instancia — limitación conocida y documentada en cada fase que lo toca, aceptable al volumen actual.

---

## 5. Módulos existentes — % real de implementación

| Módulo | % implementado | Evidencia |
|---|---|---|
| **CRM** (Companies/Contacts/Leads/Opportunities/Pipeline/FollowUps/Activities/Revenue) | **~90%** | CRUD completo y verificado desde F1; falta compliance a nivel de Company (`Document.companyId`, P0-2 de `PROPUESTAS.md`, sin resolver desde CHECKPOINT 0 de F0) y la ambigüedad `Company.status=LEAD` vs. modelo `Lead` (P0-4, tampoco resuelta). |
| **ATS / Talent** (Candidates, Workers) | **~15%** | Candidates: solo lectura + creación anónima vía formulario público (`/public/apply`), sin edición ni CV upload real, sin conversión a Worker. Workers: 0% — cero endpoint HTTP en cualquier fase. |
| **Job Orders** | **~10%** | Solo `GET /job-orders`, sin creación/edición/matching. |
| **Compliance** | **~10%** | Solo `GET` de documents/alerts/document-types, sin flujo de verificación ni upload. |
| **Payroll** | **~5%** | Solo `GET /time-entries`. `PayrollRun`/aprobación/export: 0% pese a existir en el schema desde F0. |
| **Pricing** | **~10%** | Solo `GET /pricing/scenarios`, sin creación vía UI/API. El "Pricing Agent" de la Arquitectura sigue siendo stub. |
| **Projects / Assignments** | **0%** | Modelos con datos de seed, cero rutas HTTP en cualquier fase. |
| **Campaigns / Outreach / Missions** (motor de ventas con IA) | **~90% de su propio alcance documentado** | Segmentación, secuencias, personalización just-in-time, clasificación de intención, Daily Revenue Mission — todo real y verificado. El 10% restante es envío real (Gmail, F4.7 pendiente). |
| **Discovery / Contact / Email Intelligence** | **~85%** | Descubrimiento externo (Google Places + Overpass), enriquecimiento de contactos (PDL), email discovery/verification (Website Intelligence + Hunter.io) — todo real, con costos reales verificados. Falta el envío controlado de correo (Gmail) y su dashboard agregado propio. |
| **Agent System (general)** | **~53%** (9 de 17 `AgentDefinition` con comportamiento real) | Recruiter/Compliance/Assistant/Pricing/Operations/Payroll/Marketing/Admin siguen siendo stubs puros desde F0. |
| **Executive Dashboard / Mission Control** | **~90%** | Dashboard operativo (F0), Revenue (F1), AI Dashboard (F3/F3.5/F4), Mission Control card, Missions.tsx — todos con datos reales, sin mocks. |
| **Sitio público (marketing)** | **~90%** | F4.8A cerrado y verificado; F4.8B (pulido visual de segunda pasada) pausado a mitad de camino. |
| **Autenticación de producción (Clerk)** | **~90% construido, 0% activo/verificado en vivo** | Código completo (provider, webhooks, MFA, invitaciones, frontend, tests con mocks) pero nunca ejercitado contra una cuenta de Clerk real — decisión explícita de pausa, no una limitación técnica. |
| **Preparación de despliegue (Render)** | **~60%** | Blueprint y scripts listos y verificados localmente; cero despliegue real ejecutado; una decisión de producto (`NODE_ENV`) sigue abierta. |
| **Auditoría de datos / limpieza (Production Readiness)** | **100% de su alcance deliberadamente acotado** | Diseñado para ser solo auditoría — no pretende más que eso. |

---

## 6. Riesgos

### 6.1 Deuda técnica

- **`docs/ROADMAP.md` está completamente desactualizado.** Sigue mostrando la tabla original de F0–F7 con el contenido de la Arquitectura v1.1, sin reflejar que F1–F4.9 se ejecutaron con un alcance totalmente distinto. Cualquiera que lea solo ese archivo hoy se forma un modelo mental incorrecto del proyecto.
- **F4.6 (Contact Intelligence) y F3.5 (rediseño visual) no tienen documento de plan propio** — rompen el patrón que todas las demás fases siguieron (plan → aprobación → implementación → reporte de cierre). Su estado real solo se puede reconstruir leyendo `git log` y el §0 de `F4_7_EMAIL_INTELLIGENCE_PLAN.md`.
- **`ApprovalGate.ts` sigue siendo una tabla estática**, no lee `AgentInstance.autonomyLevel` en runtime pese a que el campo existe y el "Principio de autonomía progresiva" está documentado como permanente desde F4 — brecha documentada, no oculta, pero sigue abierta.
- **Scheduler in-process de una sola instancia** (sin Redis/BullMQ) — aceptable al volumen actual (confirmado en cada fase que lo toca), pero es una limitación real que se volvería un problema real con más de una instancia del proceso Node corriendo a la vez.
- **Conflicto sin resolver `NODE_ENV` vs. `AUTH_MODE=dev-bypass`** en `render.yaml` — el propio archivo lo documenta como "decisión pendiente del PO"; deployar hoy a Render tal cual está requeriría resolver esta tensión primero.
- **`salesAgent.tools` (definición declarativa en `packages/agents`) no se usa en runtime** — hallazgo #7 de F2, nunca limpiado; metadata descriptiva que podría confundir a alguien que lea el código esperando que sea la fuente real de tools ejecutadas.

### 6.2 Módulos duplicados / riesgo de solapamiento

- **Cinco superficies de "dashboard" distintas** (`Dashboard.tsx`, `Revenue.tsx`, `AIDashboard.tsx`, `Missions.tsx`, `ProductionReadiness.tsx`) — cada una justificada individualmente en su momento ("se extiende, no se duplica"), pero acumulativamente son 5 lugares distintos donde un usuario podría buscar "cómo va el negocio hoy". No hay evidencia de que esto sea un problema real todavía, pero es la clase de fragmentación que conviene revisar antes de agregar un sexto dashboard.
- **`Company.status = LEAD` vs. modelo `Lead` independiente** — ambigüedad conceptual señalada desde el CHECKPOINT 0 de F0 (`PROPUESTAS.md` P0-4), nunca resuelta con un ADR ni una regla de negocio explícita, pese a que el pipeline comercial completo (F1–F4) se construyó encima de ambos conceptos.

### 6.3 Código muerto

- 8 de 17 `AgentDefinition` (`recruiter`, `compliance`, `assistant`, `pricing`, `operations`, `payroll`, `marketing`, `admin`) son tarjetas visibles en el AI Agents Center que no ejecutan ningún comportamiento real si se invocan — no es código roto, pero es superficie de producto que promete algo que no existe.
- Grep de `TODO`/`FIXME`/`HACK` en todo el código fuente (excluyendo tests): **1 ocurrencia** — señal de higiene alta, consistente con la disciplina de "sin TODOs críticos" exigida en cada DoD de fase.

### 6.4 Documentos desactualizados

- `docs/ROADMAP.md` (ver 6.1).
- Ausencia de plan propio para F3.5 y F4.6 (ver 6.1).
- `docs/PROPUESTAS.md` registra 9 hallazgos de CHECKPOINT 0 (previo a F0); al menos P0-1 (RBAC de 5 roles), P0-8 (CI diferido) y P0-9 (build de producción) están resueltos por trabajo posterior, pero el archivo no se actualizó para marcarlos como cerrados.

### 6.5 Funcionalidades parcialmente construidas

- F4.5 (mitad "Communications" nunca implementada bajo ese nombre, redirigida a F4.7).
- F4.7 (Gmail/envío/deliverability/inbox, bloqueado por decisiones de negocio del PO, no por trabajo de ingeniería).
- F4.9 (Clerk construido casi al 100%, pausado indefinidamente antes de la verificación real).
- F4.8B (pulido visual, pausado a mitad de la búsqueda de una foto correcta).

### 6.6 El riesgo más grande del proyecto, en mi lectura honesta

**El núcleo operativo de una agencia de staffing — la razón de ser original del producto ("sistema operativo... para agencias de staffing") — nunca avanzó más allá de la demo de solo lectura que F0 entregó en julio.** Hoy, si alguien intentara operar una agencia real con este software en vez de mirar datos de seed, no podría: no puede dar de alta un candidato de verdad con su CV, no puede verificar un documento de compliance, no puede aprobar una hoja de horas, no puede crear una nómina, no puede emitir una factura. Todo el trabajo de F1–F4.9 (extraordinariamente sólido en sí mismo) construyó un motor de adquisición de clientes con IA de clase enterprise **encima de una cáscara operativa que sigue siendo la de F0**. Esto no es necesariamente un error — el pivote a "Revenue Engine primero" fue una decisión explícita y bien razonada (documentada en la recomendación de cierre de F0: "lo que falta... es conseguir clientes, no perfeccionar la operación") — pero siete fases después, la brecha entre "vender el servicio" y "prestar el servicio" es hoy el desequilibrio más grande del proyecto.

---

## 7. Próximo roadmap recomendado

**No continúo automáticamente donde se quedó la conversación (F4.8B o F4.9).** Esta es mi lectura honesta del estado real, para que la decisión de qué sigue sea tuya.

### Diagnóstico que sostiene la recomendación

1. El motor comercial (CRM + 9 agentes de IA reales + sitio público + Mission Control) está, en términos relativos, **casi terminado dentro de su propio alcance** — lo único que le falta (envío real de Gmail) está bloqueado por decisiones tuyas de negocio (cuenta de Workspace, dirección postal, DNS), no por trabajo de ingeniería pendiente. Seguir puliendo esta área tiene rendimientos decrecientes hasta que esas decisiones se tomen.
2. F4.9 (Clerk) está pausado por una decisión tuya explícita y bien fundamentada (uso interno, ≤5 personas) — no hay razón técnica para retomarlo ahora.
3. F4.8B es pulido visual de un sitio que ya es funcional y presentable — valioso, pero no bloqueante para nada más.
4. **El núcleo operativo de staffing (candidatos, compliance, payroll, facturación, workers, job orders, assignments) lleva siete fases sin recibir ni una sola línea de CRUD nueva.** Es, literalmente, la mitad del producto descrita en el documento de arquitectura original, y hoy tiene menos funcionalidad real que el CRM comercial que se construyó "encima" de ella.

### Recomendación honesta

**La siguiente gran fase debería ser completar el núcleo operativo de staffing** — es decir, retomar (con el conocimiento y la disciplina ya demostrados en F1–F4.9) exactamente lo que el roadmap original asignaba a F1 "Core Staffing" y F2 "Compliance + Time", que nunca se construyó:

- CRUD real de Candidates (edición, upload de CV) y su conversión a Worker.
- CRUD real de Workers, Projects y Assignments (hoy sin ninguna ruta HTTP).
- CRUD real de Job Orders + el endpoint de matching que la Arquitectura original ya preveía.
- Flujo real de verificación de Compliance (upload de documentos, `POST /documents/:id/verify`, resolución de alertas).
- Aprobación real de horas (`TimeEntry`) y un primer `PayrollRun` (creación → aprobación → export), sin necesidad de tax engine todavía (eso sigue siendo F5, correctamente diferido).
- Al menos un flujo mínimo de `Invoice` (generación en PDF con líneas por trabajador/horas, sin pagos online) — para cerrar el loop "coloco un trabajador → le pago → le facturo al cliente" que el propio documento de arquitectura señaló desde el día 0 como el valor demostrable central del producto.

**Por qué esto y no otra cosa:** es la brecha más grande entre lo que el producto *dice ser* y lo que *hoy puede hacer* de verdad; reutiliza sin cambios el 90%+ de lo ya construido (RBAC, tenancy, patrones de módulo, componentes de formulario ya existentes desde F1); y — a diferencia de terminar Gmail/F4.7 o reactivar Clerk — no depende de ninguna decisión de negocio externa tuya para arrancar. Se puede empezar mañana con solo tu aprobación de alcance.

**Alternativa razonable si preferís no tocar esto todavía:** cerrar F4.7 (Gmail/envío real) es una fase más chica y ya está diseñada al detalle — solo requiere que resuelvas B3/B5/B6 (cuenta de Google Cloud, dirección postal, DNS). Tiene menos impacto en la brecha de producto de fondo, pero es más rápida de cerrar si tu prioridad de corto plazo es empezar a enviar outreach real en vez de solo generar borradores.

No recomiendo F5 (Ventas + Facturación pro con Stripe/tax engine externo) como siguiente paso: asume una base operativa (payroll runs, invoices reales) que hoy no existe — construir integración de pagos sobre una facturación que ni siquiera se genera todavía sería anteponer la fase 5 a la fase 1.
