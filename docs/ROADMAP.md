# ROADMAP — AI Staffing OS

## Estado actual (8 julio 2026)

**Fase de diseño: COMPLETADA.** Entregados: arquitectura v1.1 aprobada, schema Prisma completo, prompt de ejecución F0, kickoff con protocolo de trabajo.

**F0: EN EJECUCIÓN (Claude Code, entorno local).** El estado real de los pasos, commits, migraciones y DoD vive en el repositorio local — este documento no lo refleja automáticamente. Actualizar la tabla de abajo al cerrar cada fase.

| Fase | Nombre | Contenido resumido | Estado |
|---|---|---|---|
| Diseño | Arquitectura + schema + specs | Docs 00–02 + schema.prisma | ✅ Completada |
| **F0** | Fundaciones | Monorepo, schema, seed, Express, React+Vite, Tailwind/shadcn, layout SaaS, RBAC, tenancy, dashboard con datos reales | 🔄 En ejecución |
| F1 | Core Staffing | CRUD completo: Companies, Contacts, Job Orders, Candidates (CV upload), Workers, Projects, Assignments; Clerk real | ⬜ |
| F2 | Compliance + Time | Verificación de documentos, alertas de vencimiento, TimeEntries con aprobación | ⬜ |
| F3 | AI Agents v1 ★ | AgentRuntime + tools + memoria (pgvector), Recruiter/Compliance/Assistant Agents, AI Agents Center funcional, ApprovalRequests, chat | ⬜ |
| F4 | Orquestación + Agents | Orchestrator event-driven (Redis/BullMQ), Operations/Payroll/Pricing/CEO Agents, payroll runs, invoices PDF | ⬜ |
| F5 | Ventas + Facturación pro | Sales Agent, pipeline CRM, tax engine externo (Check/Gusto), pagos Stripe | ⬜ |
| F6 | Marketing + Integraciones | Marketing Agent, Indeed/LinkedIn, Twilio SMS con TCPA | ⬜ |
| F7 | SaaS multi-tenant | Onboarding self-service, billing de plataforma, SOC 2 readiness, observabilidad | ⬜ |

**MVP vendible = cierre de F3** (~3 meses desde inicio de F0 a ritmo sostenido).

Detalle completo de cada fase: 01_ARQUITECTURA_v1.1.md §8.
