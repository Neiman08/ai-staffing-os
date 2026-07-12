# F4.9 — Production Authentication (DreiStaff / app.dreistaff.com)

**Estado:** documento de planificación. **No implementar todavía.** Ningún código funcional de esta fase se escribe hasta aprobación explícita del PO sobre este documento — separada de la aprobación de F4.8.

**Alcance confirmado por el PO:** exclusivamente autenticación de producción para el portal privado (`apps/web` / `app.dreistaff.com`). No se toca `apps/marketing` salvo el destino del botón Login. No se despliega a producción. No se crean cuentas de usuarios reales sin aprobación separada.

---

## 1. Auditoría del estado actual

### 1.1 Auth

| Pieza | Ubicación | Estado |
|---|---|---|
| `AuthProvider` (interfaz pluggable) | `apps/api/src/modules/auth/auth-provider.ts` | Ya existe desde F0: `resolveIdentity(req) → { tenantId, userId, permissions }`. Diseñada explícitamente para que Clerk se enchufe sin tocar módulos de negocio. |
| `DevBypassAuthProvider` | `apps/api/src/modules/auth/dev-bypass.provider.ts` | Confía ciegamente en el header `x-dev-user` (o usa `admin@titan.dev` por defecto). Cero verificación criptográfica. Debe quedar **inalcanzable** fuera de desarrollo local. |
| `AUTH_MODE` | `apps/api/src/core/env.ts` | `z.enum(["dev-bypass", "clerk"])`, default `dev-bypass`. La rama `"clerk"` ya existe en `tenancyMiddleware` pero hace `throw new Error("AUTH_MODE=clerk is not implemented until F1")`. |
| `authRouter` | `apps/api/src/modules/auth/router.ts` | 3 rutas ya montadas: `GET /me`, `GET /users` (`requirePermission("users.manage")`), `GET /roles` (`requirePermission("settings.manage")`) — todas de solo lectura hoy. |
| Frontend (`apps/web`) | — | **No existe absolutamente nada de auth.** No hay pantalla de login, no hay `AuthContext`, no hay guard de rutas. `apps/web/src/lib/api.ts` nunca envía `x-dev-user` — depende 100% del fallback `admin@titan.dev` de `DevBypassAuthProvider`. Confirmado leyendo el archivo completo (38 líneas, sin ninguna referencia a auth). |

### 1.2 Tenancy

- `AsyncLocalStorage` (`apps/api/src/core/tenancy/context.ts`) — `runWithTenancyContext`/`getTenancyContext`/`requireTenancyContext`. Sin cambios necesarios.
- `tenancyMiddleware` (`apps/api/src/core/tenancy/middleware.ts`) — instancia el `AuthProvider` según `AUTH_MODE` **una sola vez** al cargar el módulo (`resolveAuthProvider()` se ejecuta a nivel de módulo, no por-request). Esto es correcto y se mantiene igual con Clerk.
- Prisma Client Extension (`apps/api/src/core/tenancy/prisma-extension.ts`) — filtra automáticamente por `tenantId` en 26 modelos "estrictos" + 4 "híbridos" (globales/seed). Sin cambios necesarios: sigue leyendo `tenantId` del mismo `TenancyContext`, sin importar qué `AuthProvider` lo pobló.
- **Ningún endpoint interno lee `tenantId` de un header.** Ya cumple el requisito del PO ("el tenantId no debe venir de un header manipulable") — el único lugar que hoy acepta algo parecido a un header controlado por el cliente es `x-dev-user`, que es justamente lo que esta fase reemplaza.

### 1.3 RBAC

- `packages/shared/src/permissions.ts` — vocabulario cerrado de permisos: 13 recursos × 4 acciones CRUD + 9 permisos especiales (`payroll.approve`, `compliance.verify`, `compliance.block`, `agents.view/configure/execute`, `approvals.decide`, `settings.manage`, `users.manage`).
- `requirePermission(key)` (`apps/api/src/core/rbac/require-permission.ts`) — middleware simple: 401 si no hay contexto, 403 si falta el permiso. **Se mantiene sin cambios** — el contrato (`ctx.permissions: string[]`) no depende de cómo se resolvió la identidad.
- Roles seed (`packages/db/prisma/seed.ts`): CEO, Admin, Recruiter, Sales, Payroll, Compliance, Operations, Marketing, HR, Accounting, Manager — 11 roles reales, tenant `titan`.

### 1.4 Schema (`packages/db/prisma/schema.prisma`)

- `Tenant` — `id, name, slug, plan, settings (Json), isActive, createdAt, updatedAt`. `isActive` ya existe → el chequeo "tenant inactivo bloquea acceso" no requiere schema nuevo.
- `User` — `id, tenantId, clerkId (String? @unique, ya existe sin usar), email, firstName, lastName, roleId, isActive, createdAt, updatedAt`. **`clerkId` ya está modelado desde F0** — señal de que Clerk era el plan original (confirmado también en `docs/01_ARQUITECTURA_v1.1.md` §1.5: *"Auth | Clerk | ahorra semanas vs JWT propio; soporta orgs (multi-tenant) nativo"*).
- `Role` / `Permission` / `RolePermission` — sin cambios necesarios.
- `AuditLog` — **ya existe y ya se usa activamente** (`scopedDb.auditLog.create(...)` en 6 lugares: agent tools + `approvals/service.ts`). Campos: `tenantId, actorType (HUMAN|AGENT|SYSTEM), actorId, action, entityType, entityId, before?, after?, ip?, createdAt`. Es exactamente el modelo que pide la sección 12 del alcance — **no hace falta un modelo nuevo**, solo nuevos valores de `action` (`auth.login`, `auth.logout`, etc.) y un helper para no repetir el `create()` a mano.
- `Activity` — modelo distinto (feed de actividad de negocio, ej. "Lead contactado"). No se usa para eventos de auth; se mantiene así.

### 1.5 Infraestructura transversal relevante para seguridad

- `app.ts`: `app.use(cors())` — **CORS completamente abierto, sin restricción de origin.** Debe cerrarse en esta fase.
- Sin `helmet`, sin `cookie-parser`, sin CSRF, sin rate limiting en ninguna ruta de auth (el `express-rate-limit` que existe hoy es exclusivo de `modules/public` — F4.8).
- `env.ts` no valida `NODE_ENV` en absoluto hoy — es un campo que no existe en el schema de env.

**Conclusión de la auditoría:** la arquitectura de F0 anticipó correctamente este momento. La interfaz `AuthProvider`, el campo `clerkId`, el enum `AUTH_MODE`, el modelo `AuditLog` y el filtro de tenancy por Prisma Extension ya están listos para recibir Clerk sin refactor. El trabajo real de F4.9 es: (a) implementar `ClerkAuthProvider`, (b) construir toda la superficie de frontend que hoy no existe, (c) cerrar los huecos de seguridad transversal (CORS, guardas de producción, rate limiting en auth), (d) un puñado de columnas nuevas y aditivas en `User`.

---

## 2. Proveedor: Clerk (confirmado)

Ya decidido en la arquitectura original y ratificado por el PO en este mensaje. Ventajas concretas para este alcance (sin construir nada a mano):

- Email+password, magic link, Google OAuth — soportados nativamente, se activan/desactivan desde el dashboard de Clerk, no hay código propio de credenciales.
- MFA (TOTP + SMS) — de fábrica.
- Recuperación de contraseña, verificación de email — de fábrica.
- Invitaciones de usuario — de fábrica (`clerkClient.invitations.createInvitation`).
- Sesiones firmadas (JWT), rotación, revocación — de fábrica.
- Bloqueo por intentos anómalos — configurable en el dashboard de Clerk (no se reconstruye a mano).
- **Organizations** — mapeo 1:1 propuesto con `Tenant` (ver §4.3). Es la pieza central de "tenantId debe resolverse desde la organización de Clerk".

---

## 3. Cambios de schema propuestos (ADITIVOS — requieren tu aprobación antes de migrar)

Todos son columnas nuevas con `default`/nullable, o un enum nuevo. **Cero cambios destructivos, cero renombres, cero columnas eliminadas.** Ningún modelo existente pierde datos ni cambia de significado.

```prisma
enum InvitationStatus {
  PENDING
  ACCEPTED
  EXPIRED
  REVOKED
}

model User {
  // ...campos existentes sin cambios...
  lastLoginAt      DateTime?
  mfaEnabled       Boolean            @default(false)
  invitationStatus InvitationStatus?  // null = usuario preexistente (seed), fuera del flujo de invitación
}
```

Justificación de cada campo:

| Campo | Para qué | Por qué no reusar algo existente |
|---|---|---|
| `lastLoginAt` | "ver último acceso" (§3 del alcance) | No existe ningún timestamp de esto hoy; `updatedAt` cambia por cualquier edición, no sirve como proxy. |
| `mfaEnabled` | Mostrar estado de MFA en la página Users & Roles sin llamar a Clerk en cada render; se sincroniza vía webhook `user.updated` | Clerk es la fuente de verdad real (se puede re-verificar en vivo si hace falta), esto es solo caché de lectura para la UI. |
| `invitationStatus` | Distinguir "invitado, no aceptó todavía" de "activo" y de "desactivado" — son 3 estados distintos, `isActive` (booleano) solo cubre 2 | Reusar `isActive` para esto rompería toda la lógica existente que ya filtra por `isActive: true` (dev-bypass, listados, etc.) — más riesgoso que agregar una columna nueva. |

**Explícitamente descartado — no propongo:**
- Un modelo `Session` propio: las sesiones viven y se listan/revocan en Clerk (`clerkClient.sessions.*`); duplicarlas en nuestra DB es estado redundante que se desincroniza. Se consultan en vivo cuando el Admin abre el detalle de un usuario.
- Un modelo `Invitation` separado: Clerk ya tiene su propio objeto `Invitation`; nuestro `User.invitationStatus` es el espejo mínimo necesario para filtrar/mostrar en nuestra UI sin una llamada extra a Clerk en cada listado.
- Tocar `Tenant`: el mapeo a Clerk Organization no necesita una columna nueva — se resuelve por `Tenant.slug ↔ Organization.slug` (ver §4.3), reutilizando el campo `slug` que ya es `@unique`.

**Pido tu aprobación explícita sobre esta migración antes de correrla** — es la única parte de este plan que toca schema.

---

## 4. Arquitectura de la solución

### 4.1 `ClerkAuthProvider` (backend)

Nuevo archivo `apps/api/src/modules/auth/clerk.provider.ts`, implementa la misma interfaz `AuthProvider` que `DevBypassAuthProvider`:

```ts
export class ClerkAuthProvider implements AuthProvider {
  async resolveIdentity(req: Request): Promise<ResolvedIdentity> { ... }
}
```

Usa `@clerk/express` (`clerkMiddleware()` + `getAuth(req)`), el SDK oficial de Clerk para Express — verifica el JWT (issuer/audience validados por el SDK, cero código criptográfico propio), soporta tanto cookie de sesión como `Authorization: Bearer <token>`.

**Decisión: autenticar por Bearer token, no por cookie cross-domain.** `app.dreistaff.com` y `api.dreistaff.com` son subdominios distintos; una cookie de sesión compartida entre ellos exige configurar un dominio padre (`.dreistaff.com`) correctamente tanto en Clerk como en el navegador, y en `localhost` (puertos 5173/4000) las cookies cross-port ya son frágiles con `SameSite=Lax/Strict`. El SDK de Clerk en React expone `getToken()`; `apps/web/src/lib/api.ts` lo usa para adjuntar `Authorization: Bearer <token>` en cada request. Funciona idéntico en dev y en producción, sin depender de configuración de dominio compartido. CORS igual queda restringido a un allowlist de orígenes (no cookies, pero tampoco `origin: "*"`).

Flujo de `resolveIdentity`:

1. `getAuth(req)` → si no hay sesión válida, `AppError.unauthorized()`.
2. Resolver `orgId` de Clerk (organización activa de la sesión) → buscar `Tenant` por el mapeo de §4.3. Si no existe o `Tenant.isActive === false` → `AppError.unauthorized("tenant inactive")`.
3. Buscar `User` por `clerkId` (el `userId` de Clerk) dentro de ese tenant. Si no existe → `AppError.unauthorized("user not provisioned")` (nunca se crea un `User` al vuelo desde una request — solo el webhook `user.created` lo hace, ver §4.2).
4. Si `User.isActive === false` → `AppError.forbidden("user disabled")`.
5. Si el rol es "sensible" (ver §4.5) y la política de MFA está activa y la sesión no tiene un factor de verificación reciente → `AppError.forbidden("mfa required")` con un código específico que el frontend traduce a la pantalla de MFA setup.
6. Cargar `role.permissions`, actualizar `User.lastLoginAt` (fire-and-forget, no bloquea la respuesta), devolver `{ tenantId, userId, permissions }`.

Ningún módulo de negocio cambia — siguen recibiendo el mismo contrato `{ tenantId, userId, permissions }` que ya reciben de `DevBypassAuthProvider` hoy.

### 4.2 Webhook Clerk → DB (idempotente)

Nuevo `apps/api/src/modules/auth/webhook.router.ts`, montado **antes** de `express.json()` global (necesita el body crudo para verificar la firma con `svix`):

```ts
app.post(
  "/api/v1/auth/webhook",
  express.raw({ type: "application/json" }),
  webhookHandler,
);
// ...luego, más abajo:
app.use(express.json());
```

Eventos manejados (todos idempotentes — cada handler hace `upsert`, nunca `create` a ciegas, usando el `svix-id` del header como clave de deduplicación contra una tabla de eventos procesados, o `clerkId` como clave natural de upsert):

| Evento Clerk | Efecto en DB |
|---|---|
| `user.created` | `upsert User` por `clerkId`: si el email coincide con una invitación `PENDING` de ese tenant, la vincula (`invitationStatus: ACCEPTED`); si no hay invitación previa, **no crea nada** — un usuario no puede auto-provisionarse sin invitación (evita que cualquiera con cuenta de Clerk obtenga acceso). |
| `user.updated` | Sincroniza `email`, `firstName`, `lastName`, `mfaEnabled` (de `two_factor_enabled`/`totp_enabled` en el payload). |
| `user.deleted` | Marca `isActive: false` (nunca borra el `User` — preserva integridad referencial con `Lead`, `Activity`, etc. que referencian `performedById`). |
| `organizationMembership.*` | Si se usa Organizations (§4.3): sincroniza qué `Tenant` corresponde a qué usuario cuando cambia de organización. |
| `session.revoked` | Registra `AuditLog` (`action: "auth.session_revoked"`) — no hay estado de sesión propio que invalidar (ver §3, sesiones viven en Clerk). |

Idempotencia: Clerk reintenta webhooks que fallan; cada handler debe poder recibir el mismo evento 2+ veces sin duplicar efectos (`upsert` por `clerkId`, nunca `create` puro).

### 4.3 Tenancy: Clerk Organization ↔ `Tenant`

Mapeo propuesto: **`Organization.slug` de Clerk ↔ `Tenant.slug`** (columna que ya es `@unique`, cero schema nuevo). Cuando se crea la organización de Clerk para `titan`, su slug se configura como `"titan"` — igual al `Tenant.slug` real ya sembrado.

`resolveIdentity` nunca confía en nada que el cliente pueda enviar como texto libre (headers, body) — el `orgId`/`org slug` viene firmado dentro del JWT de sesión que Clerk ya verificó.

**Pregunta abierta para vos (§10):** ¿se habilita la feature "Organizations" en el dashboard de Clerk (gratis, pero hay que activarla), o preferís mapear tenant por dominio de email mientras el proyecto siga siendo de un solo tenant real? Con un solo tenant activo hoy (`titan`), ambos caminos funcionan igual de bien a corto plazo; Organizations es la opción que escala sin refactor cuando haya un segundo tenant.

### 4.4 RBAC

Sin cambios de diseño. `requirePermission` sigue leyendo `ctx.permissions` del mismo `TenancyContext`. Tests nuevos a agregar (§8):

- Usuario sin permiso → 403 (ya cubierto por tests existentes con dev-bypass; se agregan equivalentes con `ClerkAuthProvider` mockeado).
- Usuario inactivo → 401/403 (nuevo: hoy `DevBypassAuthProvider` ya filtra `isActive: true` en el `findFirst`, así que un usuario inactivo simplemente "no existe" para dev-bypass; con Clerk el chequeo es explícito en el paso 4 de §4.1).
- Rol cambiado a mitad de sesión → el siguiente request ya refleja el nuevo rol (no hay caché de permisos fuera del JWT de Clerk, que solo lleva identidad, no permisos — los permisos siempre se leen fresco de la DB en cada request).
- Invitación no aceptada → el usuario no tiene `User` en DB todavía (o `invitationStatus: PENDING`) → 401 con código `user not provisioned`.
- Sesión revocada → Clerk invalida el JWT del lado del proveedor; el siguiente request con ese token falla la verificación en `getAuth(req)` → 401.

### 4.5 MFA

**Definición de "rol sensible"** (basada en permisos, no en nombre de rol — más robusta y cubre "usuarios con permisos sensibles" tal como pide el alcance): cualquier rol que tenga **al menos uno** de estos permisos:

```
users.manage, settings.manage, payroll.approve,
compliance.block, agents.configure
```

Esto cubre automáticamente CEO, Admin y Payroll (los 3 roles nombrados explícitamente) más cualquier otro rol futuro que reciba uno de esos permisos, sin mantener una lista de nombres de rol en paralelo al RBAC real.

**Activación de la política** (no se activa "a ciegas" el día 1): `Tenant.settings.security.mfaEnforced: boolean` (mismo patrón que `Tenant.settings.branding` — Json existente, cero schema nuevo), default `false` hasta que decidas activarla explícitamente para el tenant real. Con la política activa, `resolveIdentity` (paso 5, §4.1) bloquea el acceso de un rol sensible sin MFA verificado y el frontend redirige a la pantalla "MFA Setup" (usa el componente `<UserProfile/>` de Clerk, que ya incluye enrollment de TOTP/SMS — cero UI propia de MFA).

### 4.6 Sesiones

- **Login/logout:** componentes prearmados de Clerk (`<SignIn/>` para login; `useClerk().signOut()` para logout).
- **Sesión expirada:** Clerk refresca el JWT automáticamente mientras la sesión sea válida; cuando expira de verdad, `getAuth(req)` deja de validar → 401 → frontend redirige a `/sign-in` conservando la URL de retorno (`redirect_url`).
- **Revocación:** acción del Admin en Users & Roles → llama `clerkClient.sessions.revokeSession()` (o `revokeAllSessionsForUser` si Clerk lo expone) vía un endpoint nuevo `POST /auth/users/:id/revoke-sessions` (`requirePermission("users.manage")`) → registra `AuditLog`.
- **Redirección segura:** solo se acepta `redirect_url` si es una ruta relativa dentro de `apps/web` (nunca una URL externa arbitraria — evita open-redirect).

### 4.7 Usuarios (invitaciones y gestión)

Nuevos endpoints en `authRouter` (todos `requirePermission("users.manage")` salvo donde se indique):

| Endpoint | Acción |
|---|---|
| `POST /auth/users/invite` | `{ email, roleId }` → `clerkClient.invitations.createInvitation({ emailAddress, ... })` + crea `User` local con `invitationStatus: PENDING`, `isActive: true`, sin `clerkId` todavía (se completa cuando `user.created` llega vía webhook y encuentra la invitación pendiente). |
| `PATCH /auth/users/:id/status` | Activar/desactivar (`isActive`). Si se desactiva, revoca sesiones activas en Clerk también. |
| `PATCH /auth/users/:id/role` | Cambiar `roleId`. Registra `AuditLog` con `before`/`after`. |
| `POST /auth/users/:id/revoke-sessions` | Ver §4.6. |
| `GET /auth/users/:id` | Detalle: incluye `lastLoginAt`, `mfaEnabled`, `invitationStatus`, y sesiones activas (consultadas en vivo a Clerk). |

`GET /auth/users` (ya existe) se extiende para incluir `lastLoginAt`, `invitationStatus`, `mfaEnabled` en el listado.

### 4.8 Frontend privado (`apps/web`)

Nuevas dependencias: `@clerk/clerk-react`. `main.tsx` envuelve el router en `<ClerkProvider publishableKey={...}>`.

Pantallas/estados nuevos:

- `SignIn` — componente `<SignIn/>` de Clerk (cubre email+password, magic link si está habilitado, Google si está habilitado — todo configurable desde el dashboard de Clerk sin código adicional).
- `SessionLoading` — mientras Clerk resuelve el estado inicial (`useAuth().isLoaded === false`).
- `Unauthorized` (401) — "no autenticado", CTA a login.
- `Forbidden` (403) — "sin permiso", distingue el caso `mfa required` (CTA a MFA setup) del caso genérico.
- `AccountDisabled` — cuando el backend devuelve `user disabled`.
- `InvitationPending` — cuando el backend devuelve `user not provisioned` pero existe una invitación `PENDING` con ese email.
- `UserMenu` — avatar + dropdown: Profile (`<UserProfile/>` de Clerk), Security/MFA setup, Logout.
- `Settings → Users & Roles` — se **actualiza** (no se crea desde cero: `Settings.tsx` ya lista usuarios/roles de solo lectura) para agregar: invitar usuario, activar/desactivar, cambiar rol, revocar sesiones, columna de último acceso y estado de invitación. Visible solo para CEO/Admin (`users.manage`).
- **Banner de dev-bypass** (§4.10): componente que se muestra cuando `AUTH_MODE=dev-bypass`, visible en todas las páginas.

Route guard: un `<RequireAuth>` que envuelve `<AppShell/>` — si Clerk no tiene sesión, redirige a `/sign-in`; si la tiene, llama `GET /auth/me` para resolver permisos reales y decide entre `AppShell`/`AccountDisabled`/`Forbidden`/`InvitationPending` según el código de error.

### 4.9 Frontend público (`apps/marketing`)

**Único cambio permitido en esta fase:** el destino del botón Login. Hoy `Header.tsx`/`Login.tsx` ya redirigen a `https://${branding.appDomain}` (resuelto en runtime desde `GET /api/v1/public/branding`, nunca hardcodeado) — ya apunta a `app.dreistaff.com` en producción y, si se corre localmente con `APP_DOMAIN=localhost:5173` (ver `.env`), apuntaría a `http://localhost:5173`. **Falta un ajuste**: el código actual construye siempre `https://${appDomain}`, lo que rompe en localhost (`https://localhost:5173` no existe). Se corrige para que use `http://` cuando `appDomain` empieza con `localhost`, o se agrega un `APP_URL` completo (con protocolo) a `BrandingConfig` en vez de derivarlo. Ningún otro archivo de `apps/marketing` cambia. Cero Clerk, cero lógica de auth dentro de `apps/marketing`.

### 4.10 Dev mode

- `env.ts`: se agrega `NODE_ENV: z.enum(["development", "test", "production"]).default("development")`.
- `loadEnv()`: si `NODE_ENV === "production" && AUTH_MODE === "dev-bypass"` → `console.error(...)` + `process.exit(1)` **antes** de que el servidor levante (falla rápido y ruidoso, nunca un bug silencioso).
- `DevBypassAuthProvider` deja de leer `x-dev-user` si por algún error `AUTH_MODE !== "dev-bypass"` en runtime (defensa en profundidad — aunque `resolveAuthProvider()` ya nunca instancia `DevBypassAuthProvider` fuera de ese modo).
- Banner visible: `GET /api/v1/health` (ya público, sin auth) se extiende con `authMode: env.AUTH_MODE` — la única forma de que el frontend sepa mostrar el banner sin necesitar ya estar autenticado.

### 4.11 Seguridad transversal

| Ítem | Implementación |
|---|---|
| Cookies seguras | No aplica directamente (auth por Bearer token, ver §4.1) — pero se agrega `cookie-parser` + flags `Secure/HttpOnly/SameSite=Strict` si en el futuro se usa algún cookie propio (ninguno planeado en F4.9). |
| CORS restringido | `cors({ origin: [APP_DOMAIN con protocolo], credentials: false })` — reemplaza `cors()` abierto. El origin permitido se arma desde `env.APP_DOMAIN`/config, nunca hardcodeado. |
| CSRF | No aplica al modelo Bearer-token (CSRF ataca cookies enviadas automáticamente por el navegador; un Bearer token en un header `Authorization` no se adjunta automáticamente por el browser a requests de terceros). Se documenta esta decisión explícitamente para no dejar la pregunta abierta. |
| Rate limiting en auth | `express-rate-limit` (ya es dependencia desde F4.8) aplicado a `/auth/webhook` y a cualquier endpoint de auth propio nuevo (invite, revoke-sessions). El login en sí lo protege Clerk (rate limit + bloqueo por intentos, de fábrica). |
| No exponer tokens | El JWT de Clerk nunca se loguea (`console.log`, `logActivity`, `AuditLog.after`); se agrega una regla de code review / grep de CI opcional. |
| No guardar passwords | Nunca — Clerk es el único que los toca. |
| No imprimir claims sensibles | Los logs de error nunca incluyen el payload completo del JWT, solo `userId`/`tenantId` ya resueltos. |
| Validación issuer/audience | La hace el SDK de Clerk internamente (`@clerk/express`), verificando contra `CLERK_SECRET_KEY`. |
| Rotación/revocación de sesión | De fábrica (Clerk) + endpoint propio de revocación manual (§4.6). |
| Bloqueo por intentos anómalos | De fábrica (Clerk, configurable en dashboard). |
| Headers de seguridad | Se agrega `helmet()` (nueva dependencia) con defaults + `Content-Security-Policy` mínima ajustada para no romper el frontend. |

### 4.12 Auditoría

Nuevo helper `apps/api/src/core/audit-log.ts` (mismo patrón que `activity-log.ts`, evita repetir el `scopedDb.auditLog.create` a mano en cada call site):

```ts
export async function logAuditEvent(params: {
  action: string; entityType: string; entityId: string;
  before?: unknown; after?: unknown; ip?: string;
}): Promise<void>
```

Eventos registrados (todos con `actorType: "HUMAN"`, `actorId: userId` salvo login fallido donde puede no haber `userId` resuelto — se usa `"unknown"` + el email intentado en `after`):

`auth.login`, `auth.login_failed`, `auth.logout`, `auth.invitation_sent`, `auth.role_changed`, `auth.user_disabled`, `auth.user_enabled`, `auth.session_revoked`, `auth.mfa_enabled`.

**Nunca se guarda** el JWT, el password (Clerk nunca nos lo envía), ni ningún claim crudo de sesión — solo IDs y metadatos ya resueltos.

### 4.13 Production readiness (preparación, sin desplegar)

- `dreistaff.com` → `apps/marketing` (ya desplegable independientemente desde F4.8).
- `app.dreistaff.com` → `apps/web`, servido detrás de Clerk.
- `api.dreistaff.com` → `apps/api`, si se decide separar del mismo dominio de `app` (a definir con vos — no bloquea F4.9).
- CORS/cookies entre subdominios: dado el modelo Bearer-token (§4.1), **no hace falta** configuración especial de cookies cross-subdomain — simplifica el despliegue futuro. Solo el `origin` allowlist de CORS necesita los dominios reales una vez que existan.
- **Nada de esto se conecta en esta fase** — se deja preparado en config (nombres de variables), no en infraestructura real.

---

## 5. Variables de entorno nuevas (solo nombres, sin valores)

Backend (`apps/api/.env` / `.env.example`):

```
NODE_ENV=
CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
CLERK_WEBHOOK_SECRET=
CLERK_SIGN_IN_URL=
CLERK_SIGN_UP_URL=
CLERK_AFTER_SIGN_IN_URL=
CLERK_AFTER_SIGN_UP_URL=
```

Frontend (`apps/web/.env` — Vite requiere prefijo `VITE_` para exponerse al bundle):

```
VITE_CLERK_PUBLISHABLE_KEY=
```

(Es la misma clave pública que `CLERK_PUBLISHABLE_KEY` del backend — no es secreta, está diseñada para vivir en el bundle del navegador. `CLERK_SECRET_KEY` y `CLERK_WEBHOOK_SECRET` **nunca** van al frontend.)

Ninguna de estas variables se commitea con valor real — se agregan solo a `.env.example` con el nombre, igual que el resto de las claves de proveedor ya existentes (`OPENAI_API_KEY`, `HUNTER_API_KEY`, etc.).

---

## 6. Bloqueos identificados (necesito tu decisión/acción antes de poder probar contra Clerk real)

1. **Cuenta de Clerk real.** No puedo crearla — la creás vos (igual que OpenAI/Hunter/People Data Labs en fases anteriores). Una vez creada, necesito que me compartas (o cargues vos directo en `.env`, nunca en el chat) las 4 claves del backend + la pública del frontend.
2. **Decisión Organizations vs. mapeo simple** (§4.3) — con un solo tenant hoy, ambos caminos son viables; te pido que elijas.
3. **Qué métodos de login habilitar en el dashboard de Clerk** — email+password sí, magic link sí (Clerk lo soporta nativo), ¿Google sign-in confirmado o "opcional" significa que lo dejamos para después? El alcance lo marca como opcional; propongo dejarlo *feature-flag-able* (activable desde el dashboard de Clerk sin cambio de código nuestro) pero no forzarlo en el checklist de aprobación inicial.
4. **Migración de schema** (§3) — aditiva pero toca `User`; espero tu aprobación explícita antes de correrla.
5. **Redirect URLs de Clerk** — hay que registrar en el dashboard de Clerk las URLs válidas de redirect (`http://localhost:5173/*` en dev; `https://app.dreistaff.com/*` en producción, aunque no se conecte todavía).
6. **Ningún usuario real se invita/crea todavía** — una vez aprobado el plan e implementado el código, los 11 usuarios seed (`admin@titan.dev`, etc.) seguirán existiendo solo en modo dev-bypass local; no se les crea cuenta de Clerk sin tu aprobación separada, tal como pediste.

---

## 7. Testing

- **Backend:** tests nuevos en `apps/api/src/modules/auth/*.test.ts` — mockean el SDK de Clerk (sin llamadas reales) para cubrir: usuario válido → 200; usuario inactivo → 403; tenant inactivo → 401; usuario no provisto (`invitationStatus: PENDING`, sin `clerkId`) → 401; rol sensible sin MFA con política activa → 403 código `mfa required`; webhook `user.created` idempotente (mismo evento 2 veces, un solo `User`); fuga entre tenants (usuario de tenant A nunca puede resolver `tenantId` de tenant B, sin importar qué envíe en el request).
- **Frontend:** se formaliza una suite mínima de Playwright real (`apps/web/e2e/`, hoy el proyecto no tiene ninguna — la verificación de F4.8 fue un script ad-hoc) cubriendo: redirect a `/sign-in` sin sesión, login exitoso (con un usuario de prueba de Clerk, no un usuario real del negocio), logout, 403 al intentar una ruta sin permiso, banner de dev-bypass visible en modo dev-bypass.
- Se re-corren `pnpm typecheck`/`pnpm lint`/`pnpm test` en todo el monorepo (F0–F4.8) para confirmar que nada se rompe — el contrato `AuthProvider` está diseñado exactamente para que esto no pase, pero se verifica igual.

---

## 8. Definition of Done (mapeado a verificación concreta)

| Ítem del PO | Cómo se demuestra |
|---|---|
| Login real | `<SignIn/>` de Clerk funcionando en `/sign-in`, sesión real creada |
| Logout | `useClerk().signOut()`, sesión invalidada, redirect a `/sign-in` |
| Password reset | Flujo nativo de Clerk, probado end-to-end con un usuario de prueba |
| Email verification | Flujo nativo de Clerk |
| Invitación de usuario | `POST /auth/users/invite` crea invitación real en Clerk + `User` local `PENDING` |
| Asignación de rol | `PATCH /auth/users/:id/role`, verificado en `AuditLog` |
| MFA para usuario sensible | Política activada en tenant de prueba, usuario CEO/Admin/Payroll bloqueado sin MFA, desbloqueado tras enrollment |
| RBAC real | Tests de 403/401 con `ClerkAuthProvider` real (no dev-bypass) |
| Tenancy real | Test de fuga entre tenants (§7) |
| Usuario desactivado bloqueado | Test + verificación manual |
| Sesión revocada | `POST /auth/users/:id/revoke-sessions`, siguiente request con el token viejo falla |
| dev-bypass bloqueado en production | Test: `NODE_ENV=production, AUTH_MODE=dev-bypass` → proceso no arranca |
| Cero secretos filtrados | Grep de `.env`/logs/AuditLog antes de cerrar la fase |
| Typecheck limpio | `pnpm typecheck` en todo el monorepo |
| Lint limpio | `pnpm lint` en todo el monorepo |
| Tests pasando | `pnpm test` |
| Playwright sin errores | Suite nueva (§7) |
| F0–F4.8 intactos | Re-verificación completa, incluyendo el sitio público (`apps/marketing`) sin regresiones |

---

## 9. Qué NO incluye esta fase

- No se despliega nada a producción (dominios, DNS, hosting).
- No se crean cuentas de usuarios reales del negocio en Clerk.
- No se toca `apps/marketing` más allá del ajuste puntual de §4.9.
- No se activa la política de MFA por default — queda `mfaEnforced: false` hasta que lo actives explícitamente.
- No se implementa Google sign-in como requisito duro (queda disponible/activable, no forzado).

---

## 10. Decisiones que necesito de vos antes de implementar

1. ¿Apruebas la migración de schema aditiva de §3 (`User.lastLoginAt`, `User.mfaEnabled`, `User.invitationStatus` + enum `InvitationStatus`)?
2. Clerk Organizations (§4.3) vs. mapeo simple por slug sin la feature de Organizations — ¿cuál preferís?
3. ¿Confirmás el modelo Bearer-token (§4.1) en vez de cookies cross-subdomain, o preferís que investigue la alternativa de cookie compartida antes de decidir?
4. ¿Creás vos la cuenta de Clerk (free tier) y me compartís las claves vía `.env` local, o preferís que te dé el checklist exacto de configuración del dashboard primero y lo hacemos juntos paso a paso?
5. ¿Confirmás el vocabulario de "rol sensible" de §4.5 (basado en permisos: `users.manage`, `settings.manage`, `payroll.approve`, `compliance.block`, `agents.configure`) o querés una lista explícita de nombres de rol en su lugar?

Quedo a la espera de tu aprobación sobre este documento — completo o con los ajustes que indiques — antes de escribir cualquier código de F4.9.
