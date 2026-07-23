# ADR-0006: Memoria de agentes por `scope` tipado sobre `AgentMemory` existente, sin pgvector

- Estado: Aceptado
- Fecha: 2026-07-23
- Fase: F25

## Contexto

`F3_PROSPECTING_ENGINE_PLAN.md` ya introdujo `AgentMemory` sin
embeddings/pgvector, consultada por `entityType`/`entityId`/`scope`
estructurados (ej. `getUnprocessedCompanyIds` en `memory.ts` la usa
para saber qué Company ya fue "procesada"). La instrucción maestra pide
5 categorías de memoria (operational, entity, strategic, episodic,
learning) y advierte explícitamente "no crees un almacén de texto
indiscriminado".

## Decisión

Las 5 categorías **no son 5 tablas nuevas** — son 5 valores de un campo
`scope` (o un prefijo de `entityType`) sobre el `AgentMemory` que ya
existe, cada una con su propia regla de caducidad/actualización:

| Categoría | `entityType` / uso | Fuente de verdad real | Caducidad |
|---|---|---|---|
| Operational | `agentTask` (estado de ejecución, checkpoints) | `AgentTask` en sí (columnas de ADR-0004) — `AgentMemory` solo cachea un resumen de progreso legible | Vive lo que vive la tarea |
| Entity | `company`, `contact`, `campaign`, `conversation` | Las tablas de dominio (`Company`, `Contact`...) — `AgentMemory` NUNCA es la fuente de verdad de estos, solo un marcador de "ya visto/ya procesado" (patrón ya en uso hoy) | Re-evaluable (ej. `getStaleProcessedCompanyIds`, ya implementado, >14 días) |
| Strategic | `tenant` (objetivos, restricciones, decisiones) | `Tenant.settings` (ya existe) — `AgentMemory` cachea la interpretación del CEO Agent, no la fuente | Hasta el próximo `StrategicMission` |
| Episodic | `mission` o `campaign` (qué pasó en una corrida) | El propio árbol de `AgentTask`/`AuditLog`/eventos de esa misión — `AgentMemory` es un resumen navegable, nunca reemplaza la reconstrucción real vía `correlationId` | Retención larga (analítica histórica) |
| Learning | `experiment` o `pattern` | `LearningProposal` (nueva entidad, ver master doc) en estado `PROPOSED→REVIEWED→APPROVED→ACTIVATED` — `AgentMemory` nunca activa un cambio de producción por sí sola | No caduca, se supersede |

Ninguna categoría usa embeddings/similitud semántica — la recuperación
sigue siendo consulta estructurada (`WHERE entityType=... AND
entityId=... AND scope=...`), exactamente como ya funciona
`getUnprocessedCompanyIds` hoy. Esto NO cambia con F25.

## Alternativas consideradas

1. **pgvector + embeddings para memoria semántica.** Rechazado
   explícitamente por la instrucción maestra ("determinismo antes que
   inteligencia generativa") y ya diferido dos veces en el historial
   del proyecto (F2, F3). Puede reconsiderarse en una fase de
   optimización real (F25.19 Learning Agent) si aparece un caso de uso
   que la búsqueda estructurada no resuelve — no antes.
2. **5 tablas nuevas, una por categoría.** Rechazado — viola "evita
   duplicar conceptos existentes"; `AgentMemory` ya resuelve
   estructuralmente las 5 necesidades con un campo de categorización.
3. **Sin categorización, un solo `scope` libre de texto.** Rechazado —
   pierde la garantía de "cada categoría tiene su propia regla de
   caducidad/actualización" que pide la instrucción maestra.

## Confirmación post-auditoría

`AgentMemory` (schema.prisma:2141-2159) ya existe con exactamente el
shape esperado (`tenantId, agentInstanceId, scope, entityType?,
entityId?, content, importance, lastAccessedAt, createdAt`,
índices `[tenantId,agentInstanceId]` y `[tenantId,entityType,entityId]`)
— confirma que no hace falta ninguna tabla nueva. Lo único que falta es
el vocabulario: `enum MemoryScope` (schema.prisma:327-330) hoy solo
tiene `GLOBAL | ENTITY` (dos valores, usados sin distinguir las 5
categorías). F25.2 debe extender el enum de forma aditiva:

```prisma
enum MemoryScope {
  GLOBAL      // reservado, no usado activamente hoy
  ENTITY      // ya en uso (F3) -- pasa a ser la categoría "Entity memory"
  OPERATIONAL // nuevo
  STRATEGIC   // nuevo
  EPISODIC    // nuevo
  LEARNING    // nuevo
}
```

Agregar valores a un enum de Postgres/Prisma es una migración aditiva
segura (no reordena ni elimina valores existentes, ninguna fila
existente cambia de significado).

## Consecuencias

- Ninguna tabla nueva. Una única migración aditiva futura (extender
  `MemoryScope`, F25.2) es todo lo que se necesita a nivel de schema.
- Esta sesión (F25 inicial) no aplica esa migración — queda
  documentada aquí y en el roadmap (F25.2), consistente con la decisión
  general de no tocar el schema todavía (ver Fase G del reporte final).
