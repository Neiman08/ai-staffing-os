# ADR-0004: Estrategia de lease de tareas (claim + heartbeat + expiración)

- Estado: Aceptado
- Fecha: 2026-07-23
- Fase: F25

## Contexto

Hoy, si el proceso Node muere a mitad de ejecutar una tarea `RUNNING`,
esa fila queda `RUNNING` para siempre — nada la recupera (confirmado en
auditoría: el único watchdog existente es específico de
`daily_revenue_mission` vía `output.progressUpdatedAt`, no general).
F25 necesita que CUALQUIER tarea reclamada por un worker que muere sea
recuperable por otro worker, sin intervención humana.

## Decisión

Cada claim otorga un **lease con expiración**, no una posesión
indefinida:

- `claimedAt`, `claimedBy` (identificador del worker/proceso),
  `leaseExpiresAt` (ahora + `LEASE_DURATION`, ej. 5 minutos).
- El worker que tiene la tarea debe renovar el lease (`heartbeat`)
  antes de que expire mientras sigue trabajando en ella (mismo patrón
  que `output.progressUpdatedAt` ya usa hoy para misiones, generalizado
  a toda tarea).
- Una tarea `RUNNING` con `leaseExpiresAt < now()` es candidata de
  reclamo por CUALQUIER worker (incluyendo el mismo que la tenía) — se
  vuelve a poner `QUEUED` (o se reclama directo) y su `attempt` se
  incrementa.
- `maxAttempts` limita los reintentos automáticos por lease vencido —
  al llegar al máximo, la tarea pasa a `FAILED_FINAL` (ver vocabulario
  de estados en el master doc), nunca reintenta indefinidamente
  (principio #13: "el sistema debe saber cuándo detenerse").

## Alternativas consideradas

1. **Lease sin expiración, liberado explícitamente al terminar.**
   Rechazado — no resuelve el caso real que motiva esto (worker que
   muere sin liberar nada).
2. **Timeout fijo sin heartbeat** (ej. "toda tarea expira a los 10
   min sin importar si sigue progresando"). Rechazado para tareas
   largas legítimas (ej. `process_company_pipeline` real ya toma >40s
   en producción, un pipeline con reintentos de proveedor puede tomar
   más) — un timeout fijo mataría trabajo real en curso. El heartbeat
   permite que una tarea larga pero viva siga extendiendo su lease.

## Consecuencias

- Mismas columnas aditivas que ADR-0001 (`claimedAt`, `claimedBy`,
  `leaseExpiresAt`, `attempt`, `maxAttempts`, `nextAttemptAt`,
  `lastErrorCode`) — ninguna tabla nueva.
- El heartbeat es responsabilidad del propio handler de la tarea (mismo
  criterio que `progressUpdatedAt` en `mission-orchestrator.ts` hoy),
  no del Orchestrator central.
- Backoff con jitter (ver clasificación de errores en el master doc)
  decide `nextAttemptAt` tras un fallo retryable — nunca reintento
  inmediato en loop.
