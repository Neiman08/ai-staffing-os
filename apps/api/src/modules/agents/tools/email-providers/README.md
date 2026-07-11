# email-providers/

Un archivo por fuente de email discovery, todas detrás del mismo contrato (`types.ts`). El Contact Intelligence Agent (`../contact-intelligence-tools.impl.ts`) nunca sabe cuál está usando — solo llama a una función que devuelve `Promise<EmailProviderSearchResult>`.

## Orden de prioridad (F4.7 §2.1, determinista, nunca decidido por el LLM)

1. **`website-public-email.ts`** — email público del sitio oficial de la empresa (envuelve Website Intelligence, gratis, sin API key).
2. **`hunter.ts`** — Hunter.io Domain Search, solo si (1) no encontró nada Y el presupuesto de proveedores de datos no está agotado. Requiere `HUNTER_API_KEY`.
3. `NOT_FOUND` — si ninguna fuente devolvió un email verificable, el `Contact` queda sin email. **Nunca se genera un patrón inferido (`nombre.apellido@dominio.com`) como si fuera un dato confirmado** — ver F4.7 §2.2.

## Cómo agregar una fuente nueva (Apollo, Clearbit, Snov.io, ...)

1. Crear `<proveedor>.ts` exportando una función `search(params: EmailProviderSearchParams, apiKey?: string): Promise<EmailProviderSearchResult>`.
2. Mapear la respuesta cruda a `EmailCandidate[]` — `firstName`/`lastName`/`title` son `null` si la fuente no trae una persona asociada (email genérico de empresa), nunca se inventan.
3. Timeout + reintentos con backoff, igual que `hunter.ts`/`website-intelligence/crawler.ts` — nunca un `fetch()` sin `AbortSignal`.
4. Logs estructurados: `provider requested` / `provider response` / `records found`, prefijo `[email:<proveedor>]`.
5. Agregar la variable de entorno correspondiente en `apps/api/src/core/env.ts` (opcional, mismo patrón que `HUNTER_API_KEY`).
6. Registrar la fuente en `contact-intelligence-tools.impl.ts` — el orquestador decide el orden de prioridad, nunca la fuente misma.

## Reglas que toda fuente debe respetar

- Nunca inventar un email, ni por patrón (`nombre.apellido@dominio`) ni por inferencia — si la fuente no lo trae literal, `NOT_FOUND`.
- Nunca enviar nada — una fuente de email discovery solo lee/busca, nunca escribe hacia afuera.
- `costUsd` real, no estimado — si la fuente no cobra (free tier, error, respuesta vacía sin cargo), `costUsd: 0`.
- Todo email encontrado (de cualquier fuente) pasa por `email-verification-providers/` antes de quedar disponible para outreach — encontrar un email no lo hace utilizable, solo verificarlo lo hace.
