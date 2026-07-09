# DECISION_LOG — AI Staffing OS

Registro de decisiones de arquitectura y producto tomadas durante la fase de diseño (julio 2026). Cada entrada: decisión, razón, dónde está documentada.

| # | Decisión | Razón | Referencia |
|---|---|---|---|
| D1 | **Corte del MVP:** F0–F3, una sola agencia, 2 industrias, 3 agentes (Recruiter, Compliance, Assistant) | El loop candidato→compliance→asignación→margen es vendible por sí solo; evita construir 8 agentes sin validación | Arquitectura §0 |
| D2 | **Monolito modular** con fronteras estrictas de módulo, no microservicios | Un solo deploy, extraíble a microservicios después sin reescribir | Arquitectura §1.1 |
| D3 | **Multi-tenant desde el día 1 a nivel de schema** (`tenantId` en todo), operación single-tenant | Barato ahora, carísimo retrofitear después | Arquitectura §1.4 |
| D4 | **Coordinación entre agentes = event-driven determinista** (Orchestrator en código), no chat libre entre LLMs | Flujos de negocio auditables y confiables; la IA razona dentro de cada paso, no entre pasos | Arquitectura §3.1 |
| D5 | **Redis + BullMQ se agregan al stack** original | Imprescindible para colas de tareas de agentes y outbox worker (desde F3/F4) | Arquitectura §1.3 |
| D6 | **La IA nunca rechaza candidatos, nunca aprueba payroll, nunca fija tarifas finales** | Riesgo legal EEOC / IL AIVIA / NYC LL144; separación de funciones | Arquitectura §3.4, §6.4 |
| D7 | **Payroll MVP sin impuestos ni tax filing**; tax engine delegado a proveedor (Check/Gusto Embedded) en F5 | Responsabilidad legal directa; no es el core del producto | Arquitectura §0, §9.6 |
| D8 | **Pricing Agent: números por código determinista, LLM solo interpreta y explica** dentro de los rangos calculados | Los cálculos de dinero deben ser testeables; el LLM nunca inventa márgenes | Arquitectura §6.5 |
| D9 | **Cold start de pricing con benchmarks BLS OES + carga manual**; el historial interno gana peso con cada colocación; confianza declarada por recomendación | Sin historial interno al lanzar | Arquitectura §9.13 |
| D10 | **`tenantId` como String indexado SIN relation a Tenant**; aislamiento vía Prisma Client Extension + middleware | Modelo Tenant limpio, evita ~30 back-relations; enforcement centralizado e imposible de olvidar por query | schema.prisma header #1 |
| D11 | **Referencias de actor (ownerId, approvedById, decidedById...) como String? sin relation** | Evita explosión de relations nombradas en User; validación en capa de servicios | schema.prisma header #2 |
| D12 | **Dinero siempre Decimal, nunca Float** | Precisión financiera | schema.prisma header #3 |
| D13 | **Todo lo configurable es data, no código** (Industry, JobCategory, DocumentType, Role, Permission) | Agregar industrias/categorías sin tocar arquitectura (requisito del producto) | schema.prisma header #4 |
| D14 | **pgvector diferido a F3** (columna embedding se agrega en esa migración) | F0 no tiene agentes reales; Postgres local no requiere la extensión para migrar limpio | schema.prisma header #5 |
| D15 | **Auth en F0 = dev-bypass** con interfaz AuthProvider lista para Clerk en F1 | Clerk requiere cuenta/keys y rompe el "corre en localhost desde cero"; marcado con comentario SECURITY | F0 Prompt paso 9 |
| D16 | **DoD ampliado:** seed idempotente + test de fuga de tenancy (query sin contexto debe fallar) | Los dos bugs más caros de descubrir tarde en un multi-tenant | F0 Prompt DoD |
| D17 | **TCPA desde F0:** campo `smsOptIn` en Candidate aunque el SMS llegue en F6 | El opt-in debe existir en los datos antes de cualquier outreach automatizado | schema.prisma, Arquitectura §9.8 |
| D18 | **Protocolo de desacuerdo con Checkpoint 0 y PROPUESTAS.md** + orden de precedencia de documentos | Rol crítico de Claude Code sin parálisis ni deriva de scope | 00_KICKOFF |

## Pendientes de decisión (no bloquean F0)

- P1: Proveedor definitivo de tax engine para F5 (Check vs Gusto Embedded) — evaluar al inicio de F5.
- P2: S3 vs Cloudflare R2 para storage — decidir en F1 cuando lleguen uploads reales.
- P3: Tasas reales de workers' comp por class code — **pedir al broker de seguros con anticipación**; sin esto el margen neto del Pricing Agent es estimado.
- P4: Estrategia de datos BLS OES (import manual inicial vs job programado) — F4.
