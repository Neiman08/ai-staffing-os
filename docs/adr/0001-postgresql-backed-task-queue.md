# ADR-0001: Cola de tareas respaldada por PostgreSQL, no un broker externo

- Estado: Aceptado
- Fecha: 2026-07-23
- Fase: F25

## Contexto

Hoy `AgentTask` no tiene cola real: `task-executor.ts` ejecuta cada tarea
directamente en el mismo proceso Express, con `await` síncrono, sin
lease, sin reintento, sin heartbeat (confirmado por auditoría F25 Fase
A — cero resultados para `SKIP LOCKED`, `lockedAt`, `leaseUntil`,
`bullmq`, `node-cron`, etc. en todo el repo). `scheduler.ts` es un
`setInterval` de 15 min que corre en el mismo proceso, con concurrencia
"aceptable al volumen actual de un solo proceso Node" (comentario
explícito del código, sin cambios). El plan F2 ya documentó esta
limitación como consciente ("sin Redis/BullMQ... el runner se resetea
si el proceso reinicia").

F25 necesita que múltiples agentes reclamen trabajo de forma
concurrente, con reintentos, sin procesar la misma tarea dos veces, y
sin depender de que un humano dispare cada paso. Eso exige una cola
real.

## Decisión

La primera cola durable (F25.4) se construye **sobre PostgreSQL**,
usando `SELECT ... FOR UPDATE SKIP LOCKED` para el claim atómico de
tareas, no un broker externo (Redis/BullMQ/SQS/Kafka).

Esto significa:
- Nuevas columnas aditivas en `AgentTask` (F25.2): `claimedAt`,
  `claimedBy`, `leaseExpiresAt`, `attempt`, `maxAttempts`,
  `nextAttemptAt`, `lastErrorCode`.
- Un claim es un `UPDATE ... WHERE id IN (SELECT id FROM "AgentTask"
  WHERE status='QUEUED' AND (nextAttemptAt IS NULL OR nextAttemptAt <=
  now()) ORDER BY createdAt LIMIT N FOR UPDATE SKIP LOCKED) RETURNING
  *` — mismo motor de base de datos que ya se usa para todo lo demás,
  ninguna infraestructura nueva que operar/monitorear/pagar.
- Un worker perdido se detecta por `leaseExpiresAt` vencido (heartbeat
  periódico que lo extiende), no por un mecanismo de broker.

## Alternativas consideradas

1. **Redis + BullMQ.** Rechazado por ahora: agrega un servicio nuevo a
   operar, un costo nuevo en Render, y un punto de fallo nuevo, para un
   volumen que hoy corre en un solo tick de `setInterval` sin quejas.
   El propio `01_ARQUITECTURA_v1.1.md` ya declara esto como "el norte",
   no el punto de partida.
2. **SQS/Kafka.** Rechazado por sobredimensionado — multi-tenant de
   bajo volumen (un tenant real hoy), sin necesidad de fan-out
   cross-servicio ni de retención de eventos a largo plazo todavía.
3. **Mantener `setInterval` sin cola real.** Rechazado — no resuelve el
   problema real (reclamos concurrentes, reintentos, recuperación de
   tareas huérfanas) que F25 necesita para escalar de "un tick de
   scheduler" a "23 agentes potenciales operando en paralelo".

## Consecuencias

- Un solo motor de base de datos que operar (ya se opera hoy).
- Límite conocido de PostgreSQL como cola: no es apto para
  altísimo throughput (>>miles de mensajes/segundo) — aceptable, el
  volumen actual es de decenas de tareas por sweep.
- Deja una ruta de escape explícita: si el volumen lo justifica en el
  futuro, el `TaskClaimer` (interfaz) se puede reimplementar contra
  Redis/BullMQ sin cambiar los contratos de `AgentTask`/`AgentEvent`
  que consumen los agentes — el contrato es "reclamar N tareas
  QUEUED", no "cómo".
