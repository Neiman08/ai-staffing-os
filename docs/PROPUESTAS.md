# PROPUESTAS — AI Staffing OS

Registro de mejoras no bloqueantes detectadas durante auditorías (CHECKPOINT 0 y revisiones de fase). Formato: problema, solución, impacto, prioridad. Se revisan al cerrar cada fase, no bloquean la ejecución.

---

## CHECKPOINT 0 (previo a F0)

### P0-1 — Matriz RBAC incompleta para 5 de los 11 roles

**Problema:** Arquitectura §4.1 define 11 roles (CEO, Admin, Recruiter, Sales, Payroll, Compliance, Operations, Marketing, HR, Accounting, Manager), pero la matriz §4.2 solo asigna permisos explícitos a 6 (CEO, Admin, Recruiter, Compliance, Payroll, Sales). Para los 5 restantes, el F0_PROMPT solo dice "reciben permisos de solo lectura de su dominio" sin definir qué es "su dominio" para cada uno.

**Solución:** Al implementar el seed, documentar explícitamente el criterio adoptado por rol, por ejemplo:
- Operations → view de jobOrders, workers, assignments (cuando exista esa entidad)
- Marketing → view de companies, contacts, candidates
- HR → view de candidates, workers, documents
- Accounting → view de payroll, invoices, companies
- Manager → view amplio (todo lo no-escritura), sin permisos de aprobación

**Impacto:** Bajo riesgo inmediato (ningún test del DoD depende de estos 5 roles), pero afecta la consistencia del producto de cara a F1 cuando estos roles empiecen a usarse en la UI real.

**Prioridad:** Media — resolver antes de cerrar F0, documentar la decisión en el propio seed.ts con comentario.

---

### P0-2 — `Document` no soporta dueño a nivel de `Company`

**Problema:** Arquitectura §2.5 describe el dueño de un `Document` como polimórfico: `candidateId? | workerId? | companyId?`. El `schema.prisma` final solo implementa `candidateId?` y `workerId?`, sin `companyId`. Esto deja sin modelar documentos de compliance a nivel de cliente (COI, W-9, business license, MSA firmado) que son comunes en staffing B2B.

**Solución:** Evaluar en F2 (fase de Compliance) si se agrega `companyId String?` + relación a `Document`, o si esos documentos se cubren suficientemente con el modelo `Contract` existente (que ya tiene `fileUrl`).

**Impacto:** Medio — funcionalidad de compliance a nivel de cliente es común en el dominio de staffing; omitirla podría requerir una migración no trivial más adelante si se pospone demasiado.

**Prioridad:** Media — decidir explícitamente en la planificación de F2, no en F0.

---

### P0-3 — Sin superficie de UI para `Project`/`Assignment` en F0

**Problema:** El seed de F0 crea 2 `Project` + 8 `Assignment` con rates snapshot, pero ninguna de las 9 páginas de F0 los muestra. Los datos existen en la DB pero son invisibles para un demo o QA manual salvo indirectamente vía agregados del Dashboard.

**Solución:** Considerar agregar una vista de solo lectura simple (tabla) de Assignments activas en F1, o al menos exponerlas como sub-sección dentro de una página existente (p.ej. tab en JobOrders) si no se justifica una página nueva todavía.

**Impacto:** Bajo — no bloquea el DoD de F0 (que no exige esta vista), pero reduce el valor demostrable del seed data ya generado.

**Prioridad:** Baja — evaluar en la planificación de F1 (Operations ya está en el roadmap de esa fase).

---

### P0-4 — Ambigüedad conceptual entre `Company.status=LEAD` y el modelo `Lead`

**Problema:** El modelo `Company` tiene un campo `status` con valor posible `LEAD`, y además existe un modelo `Lead` independiente con su propio `LeadStatus` (NEW/CONTACTED/QUALIFIED/UNQUALIFIED/CONVERTED). No hay documentación de cómo interactúan ambos conceptos (¿un `Lead.status=CONVERTED` debe actualizar `Company.status`? ¿Puede haber `Lead`s sin `Company` asociada?).

**Solución:** Documentar en la Arquitectura (o en un ADR corto) la relación exacta, similar al patrón Salesforce Lead-vs-Account: `Lead` = prospecto individual antes de calificar; `Company.status=LEAD` = cuenta ya creada pero aún no ganada.

**Impacto:** Bajo en F0 (el modelo `Lead` no se siembra ni se usa todavía), pero relevante cuando se construya el pipeline de CRM completo en F5.

**Prioridad:** Baja — documentar antes de F5 (Ventas + Facturación pro).

---

### P0-5 — Falta índice para búsqueda de candidatos por categoría a escala

**Problema:** La relación muchos-a-muchos `Candidate.categories ↔ JobCategory.candidates` es implícita (tabla de unión autogenerada por Prisma). Con miles de candidatos y decenas de categorías, filtrar candidatos por categoría + tenant podría beneficiarse de índices explícitos que una tabla de unión implícita no permite personalizar.

**Solución:** Si en F1/F3 el patrón de consulta "candidatos por categoría" resulta frecuente (p.ej. `searchCandidates` del Recruiter Agent), migrar a una tabla de unión explícita (`CandidateCategory`) con índices propios (`@@index([tenantId, jobCategoryId])`).

**Impacto:** Bajo ahora (40 candidatos en seed), medio a mediano plazo si el volumen crece a miles.

**Prioridad:** Baja — revisar cuando el Recruiter Agent (F3) implemente `searchCandidates` con filtros reales.

---

### P0-6 — Tabla "Stack confirmado" no distingue estado final vs. alcance de F0

**Problema:** Arquitectura §1.5 presenta Redis/BullMQ, Socket.io y Clerk como parte del "stack confirmado" sin aclarar que es el estado final del roadmap completo (F0–F7), no lo requerido para F0. F0_PROMPT excluye explícitamente estos tres en su sección "Fuera de alcance", lo cual es correcto, pero genera una lectura contradictoria si se lee la Arquitectura de forma aislada.

**Solución:** Agregar una nota en Arquitectura §1.5 aclarando que la tabla describe el stack objetivo del roadmap completo, y remitir a §8 (Roadmap) para saber en qué fase se incorpora cada pieza.

**Impacto:** Bajo — es una aclaración de documentación, no afecta código.

**Prioridad:** Baja — corrección editorial, sin urgencia.

---

### P0-7 — Sin regla de sincronización entre `Candidate.status` y `Worker.status`/`Assignment`

**Problema:** El seed de F0 crea Workers a partir de candidatos tanto `PLACED` como `QUALIFIED` (7 + 3). No hay ninguna regla documentada sobre si `Candidate.status` debe pasar a `PLACED` automáticamente cuando su `Worker` asociado obtiene una `Assignment` activa, o si son estados independientes que se actualizan manualmente.

**Solución:** Definir en F1 (cuando se implemente `POST /candidates/:id/convert-to-worker` y el CRUD de Assignments) si existe sincronización automática o si es responsabilidad exclusiva del usuario/agente mantenerlos coherentes, y documentarlo como regla de negocio explícita.

**Impacto:** Medio — datos inconsistentes entre `Candidate.status` y `Worker.status` podrían confundir a los usuarios o a los agentes IA que consulten el estado del candidato en F3.

**Prioridad:** Media — resolver como parte del diseño de F1 (Core Staffing), antes de construir el flujo de conversión.

---

### P0-8 — CI/CD pipeline diferido fuera de F0

**Problema:** Arquitectura §8 (roadmap, fila F0) menciona "CI" como parte de los entregables de Fase 0, pero `02_F0_PROMPT.md` no especifica ningún pipeline de CI (GitHub Actions u otro) en su estructura del monorepo, pasos ni Definition of Done. Se planteó como bloqueante en CHECKPOINT 0 (B3).

**Decisión del Product Owner (2026-07-08):** CI queda explícitamente fuera de alcance en F0. `02_F0_PROMPT.md` es la fuente de mayor precedencia sobre la Arquitectura para el alcance de esta fase — no se implementa GitHub Actions ni ningún pipeline automatizado todavía.

**Solución:** Evaluar la incorporación de CI (lint + typecheck + tests en cada push/PR) en una fase posterior, cuando exista repositorio remoto (GitHub) y el equipo lo requiera para proteger `main`.

**Impacto:** Bajo en F0 (verificación manual sigue el DoD tal como está definido). Aumenta con el tiempo a medida que crece el equipo/colaboradores.

**Prioridad:** Baja — revisar al inicio de F1 o cuando se cree el repositorio remoto.

---

### P0-9 — Sin pipeline de build de producción para `apps/api`

**Problema:** F0 usa `tsx` (transpilación en caliente) tanto para `pnpm dev` como para `pnpm start`, sin un paso de `build` real (bundling con esbuild/tsup, o `tsc` emitiendo JS + resolución de módulos de workspace ya compilados). Esto es suficiente para desarrollo local y cumple el DoD de F0 (que solo exige `pnpm dev`), pero no es un artefacto desplegable a un entorno de producción real (Render, Docker) sin este paso.

**Solución:** Antes de cualquier deploy real (Render, F1+), agregar bundling con esbuild (`--bundle --platform=node --packages=external` para las deps de npm) y un paso de build propio para `packages/db` y `packages/shared` que emita JS a `dist/` en vez de apuntar `main`/`types` directamente a `src/index.ts`.

**Impacto:** Bajo en F0 (no se despliega nada todavía). Bloqueante real antes de cualquier despliegue a Render.

**Prioridad:** Media — resolver al inicio de F1 o cuando se prepare el primer deploy.

---

*Este archivo se actualiza durante la ejecución de cada fase. No se detiene el desarrollo por ninguno de estos puntos — se revisan al cerrar la fase correspondiente.*
