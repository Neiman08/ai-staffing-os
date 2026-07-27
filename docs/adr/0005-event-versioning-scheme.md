# ADR-0005: Versionado de eventos embebido en `eventType` (`.vN` suffix)

- Estado: Aceptado
- Fecha: 2026-07-23
- Fase: F25

## Contexto

El catálogo de eventos pedido por la instrucción maestra usa nombres
como `company.discovered.v1`, `outreach.approved.v1`. Se necesita una
regla explícita de qué significa "romper" un evento y cómo evolucionar
su payload sin romper consumidores existentes.

## Decisión

- El número de versión vive **en el string de `eventType`**
  (`"company.discovered.v1"`), no en una columna `version` separada —
  simplifica el filtro/suscripción (`WHERE type = 'company.discovered.v1'`
  selecciona exactamente una forma de payload, sin JOIN adicional).
- **Cambios aditivos de payload** (agregar un campo opcional nuevo)
  **NO** requieren bump de versión — todo consumidor que ya ignora
  campos desconocidos sigue funcionando (regla de parseo: los
  validadores Zod de cada evento usan `.passthrough()` nunca
  `.strict()` en el payload, para que un publisher más nuevo no rompa
  un consumidor más viejo).
- **Cualquier cambio no aditivo** (renombrar/eliminar un campo, cambiar
  el tipo de un campo existente, cambiar el significado semántico) exige
  publicar `eventType.v(N+1)` como un evento DISTINTO, nunca mutar
  `v1` in place. El publisher puede emitir ambas versiones en paralelo
  durante una ventana de migración de consumidores.
- Un evento nunca se borra ni se reescribe — es un registro histórico
  inmutable (igual criterio que `AuditLog`, que tampoco se edita).

## Alternativas consideradas

1. **Columna `version: Int` separada del `type`.** Rechazado por
   friction operativa mínima pero real: cada query de suscripción
   necesitaría dos condiciones (`type = X AND version = Y`) en vez de
   una; el string embebido es igual de explícito y más simple de
   filtrar/loggear/debuggear a simple vista.
2. **Sin versionado, folder-verdad-única en el payload.** Rechazado —
   viola el principio de auditabilidad: un consumidor no podría saber
   si un payload histórico corresponde a la forma vieja o nueva sin
   inspeccionar heurísticamente el contenido.

## Consecuencias

- El catálogo completo (docs/F25_AGENT_EVENTS_AND_CONTRACTS.md) declara
  cada evento con su `v1` explícito desde el primer día — nunca un
  evento sin versión.
- Los schemas Zod de cada evento (packages/agents o packages/shared)
  se nombran `companyDiscoveredV1Schema`, nunca `companyDiscoveredSchema`
  — el nombre del tipo refleja la versión igual que el string.
