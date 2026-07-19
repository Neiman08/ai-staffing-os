# Clerk — preparación de producción

F14 (2026-07-19). Consolida lo ya auditado en F12.1/F12.3 (`docs/F12_PRODUCTION_READINESS_BASELINE.md` §3.5, `docs/F12_FINAL_REPORT.md` §4) en un solo lugar accionable: qué existe, qué falta, y los pasos exactos para activar `AUTH_MODE=clerk` cuando el PO tenga credenciales reales. **No se toca ni se elimina `dev-bypass` en este documento ni en el código** — ambos proveedores coexisten en el repo, seleccionados exclusivamente por `AUTH_MODE`.

## 1. Qué ya existe (código real, no un plan)

| Pieza | Archivo | Estado |
|---|---|---|
| Provider de auth | `apps/api/src/modules/auth/clerk.provider.ts` (`ClerkAuthProvider`) | Implementado, testeado (`clerk.provider.test.ts`) |
| Mapeo de identidad | `apps/api/src/modules/auth/clerk-identity.ts` | Implementado, testeado (`clerk-identity.test.ts`) |
| Sync vía webhooks | `apps/api/src/modules/auth/webhook.router.ts` + `webhook-handlers.ts` | Implementado, testeado (`webhook-handlers.test.ts`, `webhook.router.test.ts`) — verifica firma svix real vía `verifyWebhook` de `@clerk/express/webhooks`, nunca procesa un evento sin firma válida |
| Middleware de sesión | `apps/api/src/app.ts` (`clerkMiddleware()`, montado solo si `AUTH_MODE=clerk`) | Implementado |
| Selector de provider | `apps/api/src/core/tenancy/middleware.ts` (`resolveAuthProvider()`) | Implementado — `switch (env.AUTH_MODE)`, exclusivo, nunca ambos a la vez |
| Guard de arranque | `apps/api/src/core/env.ts` | `AUTH_MODE=clerk` sin `CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY` → `process.exit(1)` al arrancar, nunca falla en el primer request |
| Guard producción real | `apps/api/src/core/env.ts` | `NODE_ENV=production` + `AUTH_MODE=dev-bypass` → `process.exit(1)` al arrancar — dev-bypass es **físicamente imposible** en un deploy real de producción |
| Frontend condicional | `apps/web/src/main.tsx`, `apps/web/src/lib/auth-config.ts` | `<ClerkProvider>` solo se monta si `VITE_CLERK_PUBLISHABLE_KEY` está presente; `RequireAuth.tsx` ya elige la variante que no depende de sus hooks en dev-bypass |
| Tests reales | 6 archivos (`clerk.provider.test.ts`, `clerk-identity.test.ts`, `webhook-handlers.test.ts`, `webhook.router.test.ts`, `user-management.test.ts`, `portal-identity.test.ts`) | Verificados en F12.3 — 100% de lo verificable sin una cuenta Clerk real ya está cubierto |

## 2. Cómo resuelve tenant/usuario (para diseñar la migración de datos real)

- **Tenant**: `resolveIdentityFromClerkSession` busca `Tenant` por `clerkOrganizationId` — **nunca** por dato enviado por el cliente. Esto significa: antes de activar Clerk en un tenant real, hace falta (a) crear una Organization real en el dashboard de Clerk, (b) escribir su `orgId` en `Tenant.clerkOrganizationId` de la fila correspondiente (migración de datos puntual, una sola vez por tenant).
- **Usuario**: nunca se auto-crea al vuelo. El único camino real es el webhook `user.created` encontrando una invitación `PENDING` ya existente en la DB (`UsersPanel.tsx` → `auth/router.ts` invite, ya construido y verificado en F12.9) — es decir, el flujo operativo real es: invitar desde la UI (funciona igual en dev-bypass y clerk) → la persona acepta la invitación de Clerk → el webhook completa el `User` real.
- **MFA**: `deriveMfaVerified` lee `sessionClaims.fva` (verificación real de la sesión actual, nunca solo el enrollment) — la política de si MFA es obligatorio vive en `Tenant.settings` (`isMfaEnforced`), no en Clerk.

## 3. Bug de seguridad ya encontrado y corregido (F12.3)

`resolveIdentityFromClerkSession` no poblaba `companyId`/`workerId`/`candidateId` en el `ResolvedIdentity` — el path de dev-bypass sí lo hacía. Como el 100% de la suite corre sobre dev-bypass, esto nunca se detectó hasta la auditoría explícita de F12.3. En producción real con Clerk activo, esto habría roto por completo el aislamiento de los portales de cliente/candidato/trabajador. **Ya corregido**, con 2 tests de regresión (usuario interno resuelve los 3 campos `undefined`; usuario de portal real con `workerId` poblado en la DB resuelve el campo real).

## 4. Lo único que falta — bloqueador externo real

**No hay una aplicación Clerk real conectada a este proyecto.** Esto requiere, del lado del PO, fuera de lo que cualquier agente puede hacer:

1. Crear una cuenta/aplicación real en [clerk.com](https://clerk.com) (o el nombre de dominio que Clerk use al momento real).
2. Habilitar **Organizations** en la configuración de la aplicación Clerk (el modelo de tenancy de este proyecto depende de `orgId`, ver §2).
3. Obtener las 3 claves reales: `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` (esta última al configurar el endpoint de webhook, ver §5).
4. Decidir la política real de MFA/enrollment de Clerk (fuera del código de este repo, es config del dashboard de Clerk).

## 5. Pasos exactos para activar Clerk (cuando las credenciales existan)

1. Cargar `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` en el dashboard de Render, servicio `ai-staffing-os-api` (nunca en `render.yaml`, nunca en el repo).
2. Cargar `VITE_CLERK_PUBLISHABLE_KEY` (mismo valor público que `CLERK_PUBLISHABLE_KEY`) en el dashboard de Render, servicio `ai-staffing-os-web`.
3. En el dashboard de Clerk: configurar el endpoint de webhook apuntando a `https://<url-real-de-ai-staffing-os-api>/api/v1/auth/webhook`, suscrito a `user.created`, `user.updated`, `user.deleted`, `organization.created`, `organization.updated`, `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted` (los 8 eventos que `webhook-handlers.ts` ya maneja).
4. Crear una Organization real en Clerk por cada tenant real de la agencia, y escribir su `orgId` en `Tenant.clerkOrganizationId` (migración de datos puntual — nunca vía código genérico que la agencia no revisó).
5. Cambiar `AUTH_MODE=dev-bypass` → `AUTH_MODE=clerk` en el dashboard de Render (servicio `ai-staffing-os-api`).
6. Recién ahí, cambiar `NODE_ENV=development` → `NODE_ENV=production` en el mismo servicio — el guard de `env.ts` lo exige en ese orden (`AUTH_MODE=clerk` primero, o el arranque falla igual con `NODE_ENV=production` + `dev-bypass`).
7. Invitar al primer usuario real desde `UsersPanel.tsx` (o `POST /api/v1/auth/users/invite`), confirmar que acepta la invitación de Clerk y que el webhook completa el `User` interno correctamente.
8. Ejecutar `docs/RENDER_SMOKE_TEST.md` §2 (Autenticación y sesión) completo contra el entorno real.

## 6. Qué NO cambia (dev-bypass se queda)

- `apps/api/src/modules/auth/dev-bypass.provider.ts` — sin tocar. Sigue siendo el modo por default (`AUTH_MODE=dev-bypass`), útil para desarrollo local y para cualquier entorno de staging/demo que no necesite auth real.
- El guard de `env.ts` ya impide que `dev-bypass` llegue a `NODE_ENV=production` — la protección real no depende de que nadie recuerde desactivarlo a mano.
- El banner de "DEV-BYPASS auth is active" del frontend sigue funcionando igual, condicionado a que el modo esté realmente activo.

## 7. Nunca hacer

- Nunca eliminar ni deshabilitar `dev-bypass.provider.ts` — sigue siendo necesario para desarrollo/CI/staging sin credenciales reales.
- Nunca resolver un `Tenant`/`User` de Clerk por un dato que venga del cliente (header, body, query) — siempre por `orgId`/`userId` ya verificados por el SDK de Clerk.
- Nunca auto-crear un `User` fuera del flujo de invitación + webhook.
- Nunca cargar `CLERK_SECRET_KEY` con el prefijo `VITE_` ni en ningún archivo bajo `apps/web/src` — solo `CLERK_PUBLISHABLE_KEY` (pública por diseño) puede llegar al frontend.
