# contact-providers/

Un archivo por proveedor de contactos, todos detrás del mismo contrato
(`types.ts`). El Contact Intelligence Agent (`../contact-intelligence-tools.impl.ts`)
nunca sabe cuál está usando — solo llama `search(params, apiKey): Promise<ContactProviderSearchResult>`.

## Proveedor activo

- **People Data Labs** (`people-data-labs.ts`) — primario, requiere `PEOPLEDATALABS_API_KEY`.

## Cómo agregar un proveedor nuevo (Apollo, Proxycurl, Clay, ...)

1. Crear `<proveedor>.ts` exportando `search(params: ContactProviderSearchParams, apiKey: string): Promise<ContactProviderSearchResult>`.
2. Mapear la respuesta cruda del proveedor a `ContactCandidate[]` — cada campo (`firstName`/`lastName`/`title`/`linkedinUrl`/`email`/`phone`) va como `{ status: "CONFIRMED" | "NOT_FOUND", value }`. Nunca `INFERRED` a menos que el proveedor documente explícitamente que ese dato es una inferencia suya (no un hecho verificado) — y en ese caso, decirlo en el nombre del campo, no en un `CONFIRMED` engañoso.
3. Timeout de 30s + máximo 3 reintentos con backoff, igual que `overpass.ts`/`google-places.ts`/`people-data-labs.ts` — nunca un `fetch()` sin `AbortSignal`.
4. Logs estructurados: `provider requested` / `provider response` / `records found`, prefijo `[contacts:<proveedor>]`.
5. Agregar la variable de entorno correspondiente en `apps/api/src/core/env.ts` (opcional, mismo patrón que `PEOPLEDATALABS_API_KEY`).
6. Registrar el proveedor en `contact-intelligence-tools.impl.ts` — el orquestador decide el orden (cuál es primario, cuál es respaldo), nunca el proveedor mismo.

## Reglas que todo proveedor debe respetar

- Nunca inventar un nombre, cargo, email, teléfono o LinkedIn — si la fuente no lo trae, `NOT_FOUND`.
- Nunca enviar nada (ni email, ni mensaje de LinkedIn, ni llamada) — un proveedor de contactos solo lee/busca, nunca escribe hacia afuera.
- `costUsd` real, no estimado por adivinanza — si el proveedor no cobra por ese request (error, respuesta vacía sin cargo), `costUsd: 0`.
