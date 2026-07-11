# email-verification-providers/

Un archivo por proveedor de verificación, todas detrás del mismo contrato (`types.ts`). El Contact Intelligence Agent llama a una función que devuelve `Promise<EmailVerificationResult>` sin saber cuál proveedor está detrás.

## Proveedor activo

- **`hunter.ts`** — Hunter.io Email Verifier, mismo vendor/API key que `email-providers/hunter.ts` (F4.7 Bloqueante B2, aprobado por el Product Owner para el free tier). Requiere `HUNTER_API_KEY`.

## Vocabulario cerrado (F4.7 §3.1)

| Estado | ¿Disponible para outreach? |
|---|---|
| `VERIFIED` | Sí, único estado habilitado |
| `RISKY` | No — revisión humana |
| `INVALID` | No, nunca — se agrega a la suppression list |
| `UNKNOWN` | No — revisión humana |
| `NOT_VERIFIED` | No — estado inicial antes de llamar a un proveedor (no lo devuelve ningún proveedor, es el default de `Contact.emailVerificationStatus`) |

## Cómo agregar un proveedor nuevo (NeverBounce, ZeroBounce, ...)

1. Crear `<proveedor>.ts` exportando una función `verify(params: EmailVerificationParams, apiKey: string): Promise<EmailVerificationResult>`.
2. Mapear el resultado crudo del proveedor a uno de los 4 valores de `EmailVerificationOutcome` — si el proveedor devuelve algo ambiguo o la llamada falla, `UNKNOWN` (nunca `VERIFIED` por defecto).
3. Timeout + reintentos con backoff, igual que `hunter.ts`.
4. Logs estructurados, prefijo `[email:<proveedor>-verify]`.
5. Agregar la variable de entorno en `apps/api/src/core/env.ts`.
6. Registrar el proveedor en `contact-intelligence-tools.impl.ts`.
