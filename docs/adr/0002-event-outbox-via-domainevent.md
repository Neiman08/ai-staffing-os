# ADR-0002: Outbox de eventos extendiendo `DomainEvent`, no una tabla nueva

- Estado: Aceptado
- Fecha: 2026-07-23
- Fase: F25

## Contexto

`schema.prisma` ya tiene un modelo `DomainEvent` (`id, tenantId, type,
payload, processedAt, createdAt`) desde F0. La auditoría F25 Fase A
confirmó que es un **stub muerto**: nunca se le escribe ni se le lee en
ningún módulo de negocio — solo existe la definición y su inclusión en
el allowlist de tenancy. `F2_AI_SALES_AGENT_PLAN.md` ya lo listaba como
"orquestación event-driven — fuera de alcance" desde el principio.

F25 necesita un catálogo de eventos versionados
(`company.discovered.v1`, `outreach.draft_created.v1`, etc.) publicados
de forma transaccional junto con el cambio de estado que los origina
(patrón outbox: nunca se pierde un evento por un crash entre "guardar
el cambio" y "publicar el evento", porque son la misma transacción de
base de datos), y consumidos por un dispatcher que los entrega a los
agentes suscritos.

## Decisión

Extender `DomainEvent` (aditivo, nunca reemplazar) en vez de crear un
modelo `AgentEvent` paralelo:

```prisma
model DomainEvent {
  id             String    @id @default(cuid())
  tenantId       String
  type           String    // "company.discovered.v1" -- eventType versionado, ver ADR-0005
  payload        Json
  processedAt    DateTime?
  createdAt      DateTime  @default(now())
  // F25 -- aditivo:
  correlationId  String?   // ver ADR de trazabilidad en el master doc
  causationId    String?
  actorType      String?   // "AGENT" | "HUMAN" | "SYSTEM"
  actorId        String?
  entityType     String?
  entityId       String?
  idempotencyKey String?   @unique
  attempt        Int       @default(0)
  lastErrorAt    DateTime?
  lastErrorCode  String?
}
```

Por qué extender en vez de crear `AgentEvent` nuevo: el propósito
declarado de `DomainEvent` desde F0 ("jobOrder.created",
"document.expired") es exactamente "algo pasó, tenant X, tipo Y,
payload Z" — el mismo concepto que necesita F25. Crear un segundo
modelo paralelo duplicaría el concepto (violación explícita de la
regla "evita duplicar conceptos existentes" de esta fase) y dejaría dos
tablas de eventos sin relación entre sí.

El **outbox real** (escribir el evento en la MISMA transacción Prisma
que el cambio de estado) es responsabilidad de cada `service.ts` que
publique — no de `DomainEvent` en sí. F25.3 es la fase que instrumenta
los primeros publishers reales.

## Alternativas consideradas

1. **Modelo `AgentEvent` nuevo, dejar `DomainEvent` como está.**
   Rechazado — duplica el concepto, dos tablas de "algo pasó" sin
   relación es peor que extender la que ya existe con ese propósito
   declarado.
2. **Broker de eventos externo (Redis Streams, Kafka) en vez de
   outbox en Postgres.** Rechazado por el mismo razonamiento que
   ADR-0001 — ninguna infraestructura nueva hasta que el volumen lo
   justifique.
3. **Renombrar `DomainEvent` a `AgentEvent`.** Rechazado — un rename
   de modelo Prisma es una migración destructiva en la práctica (dropea
   y recrea la tabla salvo que se maneje con cuidado extra), y esta
   sesión tiene prohibido tocar producción; extender es puramente
   aditivo y cero riesgo.

## Consecuencias

- `DomainEvent` pasa de stub a infraestructura real recién en F25.3 —
  esta sesión NO migra el schema todavía (ver Fase G del reporte:
  decisión explícita de no aplicar ninguna migración hoy, solo dejar
  el schema propuesto documentado aquí y en el roadmap).
- El dispatcher de F25.3 puede reusar el mismo índice
  `[tenantId, type]`/`[processedAt]` que ya existe.
- `idempotencyKey` único a nivel de tabla es la garantía real de
  "nunca se publica el mismo evento dos veces", no una convención de
  aplicación.
