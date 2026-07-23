# F24 Fase 9 — Preparación de arquitectura para agentes autónomos

Este documento **no cambia comportamiento**. Es un mapa de qué tan lista
está la arquitectura actual (después de F24 Fases 1-8) para que cada
etapa del pipeline comercial se convierta, en una fase futura aparte,
en un agente independiente — y qué faltaría para llegar ahí.

## Por qué esto ya es posible sin reescribir nada

Cada etapa del pipeline que F24 tocó quedó implementada como una
**función pura** (sin Prisma/fetch/LLM adentro, mismo criterio que ya
regía todo `ceo-intelligence/` desde F7): recibe datos ya reunidos,
devuelve una decisión + la razón. El código que SÍ hace I/O
(`apps/api/src/modules/agents/tools/*.impl.ts`) es hoy una fina capa
que junta datos, llama a la función pura, y actúa sobre el resultado.

Eso es, estructuralmente, lo mismo que necesitaría un futuro agente
independiente: reunir contexto → llamar a una decisión determinista →
actuar. La única diferencia real entre "una función que un tool llama
en el mismo proceso" y "un agente separado que la llama por su cuenta"
es el mecanismo de invocación (llamada directa vs. cola/mensaje/RPC) —
nunca la lógica de negocio, que ya vive aislada.

## Mapa: 7 etapas futuras → módulos puros que ya existen hoy

```
Discovery Agent
  ↓
Contact Intelligence Agent
  ↓
Outreach Agent
  ↓
Quality Agent
  ↓
Send Agent
  ↓
Reply Agent
  ↓
Meeting Agent
```

| Etapa futura | Función pura que ya encapsula su decisión central | Dónde vive hoy | Qué le falta para ser un agente independiente |
|---|---|---|---|
| **Discovery Agent** | `validateBusinessCandidate` (clasificación de negocio), `decideCompanyConversion` (Lead/Opportunity), `evaluateBusinessIdentityGate` (DEMO_SEED + clasificación) | `ceo-intelligence/business-validation.ts`, `conversion-policy.ts` | Nada estructural — hoy corre dentro de `mission-executor.ts`. Separarlo es mover el *caller*, no la lógica. |
| **Contact Intelligence Agent** | `resolveBestContactChannel` (scoring de canal) | `ceo-intelligence/contact-channel.ts` | Ídem — hoy lo llaman `outreach-tools.impl.ts`/`sales-tools.impl.ts`/`discovery-conversion.ts`. Un agente separado sería un 4to caller, no una reescritura. |
| **Outreach Agent** | `evaluateDraftCreationGate` (F24 Fase 1/2/6/7 — decide SI corresponde redactar) | `ceo-intelligence/draft-creation-gate.ts` | Ya es el chokepoint único de las 3 vías de creación de Draft — un futuro Outreach Agent ya llamaría exactamente a esta función antes de invocar al LLM. |
| **Quality Agent** | `evaluateApprovalQualityGate` (F24 Fase 8 — 8 checks antes de aprobar) | `ceo-intelligence/approval-quality-gate.ts` | Ya es la última línea de defensa antes de READY_TO_SEND, ya reporta TODOS los fallos (no solo el primero) — un futuro Quality Agent es literalmente esta función con una cola de trabajo encima. |
| **Send Agent** | `sendApproval` (idempotente, guardado por `updateMany` condicional + índice único parcial) | `approvals/service.ts` | Ya es una acción explícita, separada de la decisión (F21 Fase 4) — nunca se dispara sola. |
| **Reply Agent** | `classifyConversation` (clasificación de intención de respuesta) | `agents/tools/campaign-tools.impl.ts` (ver `suggestNextStep`) | Existe la clasificación; falta el trigger real (hoy es manual vía UI, no un listener de respuestas entrantes). |
| **Meeting Agent** | — (no existe todavía ninguna pieza determinista de esto) | — | Es la única etapa sin ningún componente puro hoy. Quedaría 100% por diseñar en una fase futura aparte. |

## Qué SÍ falta (fuera de alcance de F24, documentado para una fase futura)

1. **Vocabulario compartido de etapa**: hoy no existe un tipo/enum que
   etiquete "a qué etapa del pipeline pertenece este AgentTask/
   AuditLog". Sería aditivo (un campo más, sin tocar el enum de
   `AgentTaskType` existente) — útil para trazabilidad cuando cada
   etapa sea realmente un proceso separado.
2. **Mecanismo de invocación desacoplado**: hoy todo corre en el mismo
   proceso Node (`task-executor.ts`). Separar en agentes reales
   requeriría una cola/mensaje real (Redis/BullMQ u otro) — explícitamente
   fuera de alcance hasta que el volumen lo justifique (mismo criterio
   ya documentado en `scheduler.ts`: "aceptable al volumen actual de un
   solo proceso").
3. **Reply Agent / Meeting Agent**: como se ve en la tabla, son las dos
   etapas menos maduras. Ninguna decisión determinista existe todavía
   para "cuándo agendar una reunión" — sería la primera pieza a diseñar
   si se prioriza esa etapa.

## Regla explícita seguida en F24 para no romper esto

Cada función nueva de F24 (`evaluateDraftCreationGate`,
`evaluateApprovalQualityGate`) se escribió **pura desde el día uno** —
nunca como un `if` suelto dentro de un `.impl.ts` — precisamente para
que este documento pudiera escribirse sin pedir ningún cambio de código
adicional. Cualquier fase futura que agregue lógica de decisión debería
seguir el mismo patrón: la decisión vive en `ceo-intelligence/` (pura,
testeable sin DB), el I/O vive en el `.impl.ts` que la llama.
