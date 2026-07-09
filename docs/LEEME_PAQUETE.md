# Paquete de Documentación Fuente — AI Staffing OS

## Qué contiene este paquete

| Archivo | Descripción |
|---|---|
| 00_KICKOFF.md | Rol, filosofía y protocolo de trabajo para Claude Code (con precedencia de documentos) |
| 01_ARQUITECTURA_v1.1.md | Arquitectura oficial aprobada (sistema, datos, agentes, APIs, roadmap, riesgos) |
| 02_F0_PROMPT.md | Prompt de ejecución de Fase 0 con spec de seed y Definition of Done |
| schema.prisma | Schema completo v1.0 (36 modelos, 30 enums) — fuente oficial de la base de datos |
| ROADMAP.md | Roadmap por fases con estado actual |
| DECISION_LOG.md | 18 decisiones de diseño registradas + 4 pendientes |

## Qué NO contiene (y dónde está)

El **código** vive en el repositorio local generado por Claude Code:
migraciones de Prisma, seed.ts, package.json, pnpm-lock.yaml,
docker-compose.yml, .env.example, README.md de instalación,
PROPUESTAS.md, versiones exactas instaladas y estado real de F0.

No existe aún: repositorio Git remoto, deploy en Render, Supabase,
Clerk ni ningún servicio externo. Ninguna credencial ha sido creada.

## Versiones prescritas por el spec (las instaladas las reporta el repo)

Node 20+ · pnpm workspaces · TypeScript 5 estricto · Express 4 ·
Prisma (última estable) · PostgreSQL 16 · React 18 · Vite 5 ·
Tailwind + shadcn/ui · TanStack Query · Zod
