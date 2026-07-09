# AI Staffing OS

Sistema operativo SaaS multi-tenant para agencias de staffing, operado por un equipo híbrido de humanos y agentes IA. Este repositorio contiene la Fase 0 (Fundaciones): monorepo, schema de base de datos, API de solo lectura y frontend con datos reales del seed.

Documentación de referencia: `docs/00_KICKOFF.md`, `docs/01_ARQUITECTURA_v1.1.md`, `docs/02_F0_PROMPT.md`, `docs/PROPUESTAS.md`, `docs/DECISION_LOG.md`.

## Setup (5 comandos)

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Esto levanta:

- **API** en `http://localhost:4000` (`GET /api/v1/health` para verificar).
- **Web** en `http://localhost:5173`.

## Estructura

```
apps/
  api/      Express + TypeScript + Prisma (solo lectura en F0)
  web/      React + Vite + Tailwind + shadcn/ui
packages/
  db/       Prisma schema, cliente y seed
  shared/   Permission keys, constantes y Zod schemas compartidos
  agents/   Esqueleto del framework de agentes IA (sin implementación hasta F3)
```

## Auth en F0

`AUTH_MODE=dev-bypass`: cada request se autentica automáticamente como `admin@titan.dev`. Para probar otro rol, envía el header `x-dev-user: <email>` (ej. `recruiter@titan.dev`, `sales@titan.dev`). Ver comentario `SECURITY` en `apps/api/src/modules/auth/dev-bypass.provider.ts` — esto se reemplaza por Clerk en F1.

## Scripts útiles

| Comando | Descripción |
|---|---|
| `pnpm dev` | Levanta API + Web en paralelo |
| `pnpm db:migrate` | Aplica migraciones de Prisma |
| `pnpm db:seed` | Siembra datos de demo (idempotente) |
| `pnpm db:studio` | Abre Prisma Studio |
| `pnpm typecheck` | TypeScript estricto en todo el monorepo |
| `pnpm lint` | ESLint en todo el monorepo |

## Verificación rápida

```bash
curl -s http://localhost:4000/api/v1/health
curl -s http://localhost:4000/api/v1/candidates
curl -s -H "x-dev-user: sales@titan.dev" http://localhost:4000/api/v1/candidates   # → 403 esperado
```
