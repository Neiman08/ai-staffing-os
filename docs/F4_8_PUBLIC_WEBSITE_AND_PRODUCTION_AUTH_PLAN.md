# F4.8 — Sitio Público (dreistaff.com) & Autenticación de Producción — Propuesta Técnica

**Estado:** documento de planificación. **No implementar todavía.** Ningún proveedor de auth se contrata, ningún dominio se conecta, y no se escribe código funcional de esta fase hasta que este documento reciba aprobación explícita — separada de la aprobación de branding (F4.7 Addendum 2).
**Precedente:** F0–F4.7 completos (F4.7 parcial, ver su documento). Branding decidido: marca `DreiStaff`, dominio `dreistaff.com`, portal privado `app.dreistaff.com`, entidad legal `Data More LLC` (`apps/api/src/core/branding.ts`, única fuente de verdad). Este plan **construye sobre** esa decisión — no la repite ni la vuelve a decidir.
**Naturaleza de esta fase:** es la primera vez que el software queda expuesto a alguien que no es un usuario interno de la agencia (visitantes del sitio público, empleadores/candidatos que llenan un formulario) y la primera vez que la autenticación deja de ser `AUTH_MODE=dev-bypass` (que hoy confía ciegamente en un header sin verificación criptográfica — ver `apps/api/src/modules/auth/dev-bypass.provider.ts`). El riesgo real: cualquier bug de autenticación acá compromete el CRM completo, no una sola función.

---

## 0. Revisión del estado real del repositorio (antes de proponer nada)

### 0.1 Qué ya existe y F4.8 reutiliza sin cambios

| Pieza | Dónde | Por qué aplica |
|---|---|---|
| `AuthProvider` (interfaz pluggable) | `apps/api/src/modules/auth/auth-provider.ts` | Ya diseñada desde F0 exactamente para este momento — el comentario en el código dice literalmente "Clerk se enchufa en F1 con un clerk.provider.ts que satisface la misma interfaz... sin tocar ningún módulo de negocio". F4.8 es esa fase, atrasada pero con la interfaz ya lista. |
| `AUTH_MODE` env var (`"dev-bypass" \| "clerk"`) | `apps/api/src/core/env.ts`, `apps/api/src/core/tenancy/middleware.ts` | El enum YA tiene `"clerk"` como valor válido — hoy tira `throw new Error("AUTH_MODE=clerk is not implemented until F1")`. F4.8 implementa ese branch, no inventa uno nuevo. |
| RBAC completo (`Role`/`Permission`/`RolePermission`, `requirePermission`) | `packages/shared/src/permissions.ts`, `apps/api/src/core/rbac/require-permission.ts` | Roles y permisos **ya existen y funcionan** desde F0 — "roles y permisos" del pedido del PO ya está resuelto, F4.8 solo necesita que la IDENTIDAD (quién sos) se resuelva de forma segura; una vez resuelta, el resto de RBAC no cambia una línea. |
| `User`/`Role` (schema) | `packages/db/prisma/schema.prisma` | `User.clerkId String? @unique` ya existe en el modelo — otra señal de que Clerk era el plan original, el campo está ahí sin usar. |
| Branding centralizado | `apps/api/src/core/branding.ts`, `GET /branding` | El sitio público y el portal privado consumen el mismo endpoint — nunca un nombre/dominio hardcodeado en ninguno de los dos. |
| Auditoría (`AuditLog`) | `schema.prisma` | Reutilizado para "auditoría" del pedido — cada login/logout/cambio de rol es una fila más, mismo mecanismo que ya registra `contact.email_found_by_agent` etc. |

### 0.2 Qué NO existe todavía (gaps reales)

1. **Ningún provider de Clerk implementado** — solo la interfaz y el `throw`. Cero código de integración real.
2. **Ninguna verificación criptográfica de sesión** — `dev-bypass` confía en un header de texto plano, sin firma, sin expiración, sin nada. No hay cookies de sesión, no hay JWT, no hay CSRF.
3. **Sin MFA, sin recuperación de contraseña, sin invitaciones, sin bloqueo por intentos fallidos** — ninguno de estos conceptos existe en el código hoy, en ninguna forma.
4. **Sin sitio público.** `apps/web` es 100% la SPA privada (React Router, todo detrás del Sidebar) — no hay ni una página pública, ni un formulario externo, ni una ruta que no requiera estar "autenticado" (hoy, con dev-bypass, todo es implícitamente público en la práctica).
5. **Sin infraestructura de despliegue de dos dominios.** Hoy todo corre en `localhost` (API en 4000, web en 5173) — no hay configuración de DNS, hosting, ni build separado para `dreistaff.com` vs `app.dreistaff.com`.
6. **Sin conexión formulario → CRM.** No existe ningún endpoint público (sin auth) que pueda recibir un "Request Staff" o "Apply for Jobs" y crear algo en el CRM — todos los endpoints de escritura hoy exigen `requirePermission(...)`, correcto para uso interno, pero ninguno está diseñado para aceptar tráfico anónimo de internet.

---

## 1. Sitio público — dreistaff.com

### 1.1 Alcance de páginas (pedido explícito del PO)

| Página | Contenido | Conecta al CRM? |
|---|---|---|
| Home | Propuesta de valor, CTA a "Request Staff"/"Apply for Jobs" | No |
| For Employers | Qué resuelve DreiStaff para empresas que necesitan personal, CTA "Request Staff" | No |
| For Candidates | Qué ofrece DreiStaff a quien busca trabajo, CTA "Apply for Jobs" | No |
| Industries | Sectores atendidos (Manufacturing, Construction, Warehouse/Logistics, General Labor — los mismos 4 `Industry` ya reales del CRM, nunca inventar categorías nuevas acá) | No (lectura, sin exponer datos internos) |
| About Us | Historia/misión de DreiStaff — texto editorial, sin datos del CRM | No |
| Contact | Formulario de contacto general | Sí — §4 |
| Request Staff | Formulario de empleador | Sí — §4 |
| Apply for Jobs | Formulario de candidato | Sí — §4 |
| Privacy Policy | Legal — requiere texto real, no genérico (ver Bloqueantes) | No |
| Terms | Legal — mismo caso | No |
| Equal Opportunity / Non-Discrimination | Aviso legal EEO — texto estándar de la industria de staffing en EE.UU., pero el PO debe confirmarlo antes de publicar (jurisdicción-específico) | No |
| Login | Sin formulario propio — botón/link que redirige directo a `https://app.dreistaff.com` (login real vive en el portal privado, no en el sitio público) | No |

### 1.2 Qué el sitio público NUNCA expone

Regla explícita del pedido, aplicada literalmente: **cero superficie del CRM interno** — no hay ninguna página, endpoint, ni fragmento de HTML del sitio público que permita ver `Company`/`Contact`/`Lead`/`Opportunity`/`Candidate` reales. El único punto de contacto entre el sitio público y el backend son los 3 formularios (Contact/Request Staff/Apply for Jobs), y esos solo **escriben** (crean un registro), nunca **leen** nada existente — un visitante anónimo no puede consultar ni un solo dato ya guardado.

### 1.3 Arquitectura técnica del sitio público

**Decisión propuesta (a confirmar con el PO): sitio estático separado, NO parte de la SPA de `apps/web`.**

Motivo: `apps/web` es una SPA privada completa (React Router + TanStack Query + toda la lógica de negocio) — montar páginas públicas ahí significaría enviarle al visitante anónimo el bundle entero de la aplicación privada (código de Companies/Leads/Missions/etc. que nunca va a usar), y complicaría la separación de qué es público vs. qué requiere sesión. Un sitio estático aparte (`apps/marketing` o similar, Vite/Astro/Next.js estático — a decidir en la implementación, no en este plan) es más liviano, más rápido de cargar (importa para SEO/conversión de un sitio de marketing), y mantiene el bundle de `app.dreistaff.com` sin código de marketing.

**Alternativa más simple (a evaluar si el PO prefiere menos infraestructura nueva): un tercer paquete liviano dentro del mismo monorepo pnpm** (`apps/marketing`), reutilizando `packages/shared` solo para los tipos de los formularios (nunca para lógica de negocio) — sigue siendo un build/deploy separado de `apps/web`, pero vive en el mismo repo, mismo `pnpm-workspace.yaml`, sin repositorio nuevo que mantener.

---

## 2. Portal privado — app.dreistaff.com

### 2.1 Qué cambia respecto a hoy

Nada de la lógica de negocio — `apps/web` sigue siendo exactamente el mismo código. Lo que cambia es (a) el dominio donde se sirve (`app.dreistaff.com` en vez de `localhost:5173`), y (b) que `AUTH_MODE` deja de ser `dev-bypass` en ese entorno de producción — todo lo demás (Sidebar, rutas, RBAC, cada página ya construida en F0–F4.7) sigue funcionando igual, porque nunca dependió de los detalles de cómo se resuelve la identidad, solo de que `getTenancyContext()` devuelva `{ tenantId, userId, permissions }` — el mismo contrato que ya cumple `dev-bypass` hoy.

### 2.2 Alcance de infraestructura (a decidir con el PO, no en este documento)

- Hosting del backend (`apps/api`) — hoy corre local con `tsx watch`, producción necesita un proceso persistente real (Railway/Render/Fly.io/un VPS propio — ninguno evaluado todavía, fuera de alcance de este plan a menos que el PO pida evaluarlos acá).
- Hosting del frontend (`apps/web`, build estático de Vite) — cualquier CDN estático (Vercel/Netlify/Cloudflare Pages/S3+CloudFront).
- Base de datos Postgres en producción — hoy es local (`localhost:5433` según `.env`), producción necesita una instancia real gestionada.
- DNS de `dreistaff.com`/`app.dreistaff.com` — el PO controla el dominio, hace falta que apunte los registros correspondientes.

Ninguna de estas decisiones de infraestructura se toma en este documento — se documentan como bloqueantes (§6).

---

## 3. Autenticación de producción

### 3.1 Alcance exacto pedido por el PO

Usuario y contraseña · recuperación de contraseña · MFA · invitaciones · roles y permisos (**ya resuelto**, §0.1) · sesiones seguras · logout · auditoría · bloqueo por intentos fallidos.

### 3.2 Dos caminos posibles — evaluados, ninguno contratado/implementado

| Opción | Qué resuelve de fábrica | Qué falta construir | Costo aprox. |
|---|---|---|---|
| **Clerk** (recomendado, ya anticipado por el código desde F0) | Contraseña + hash seguro, recuperación de contraseña, MFA (TOTP/SMS), invitaciones de usuario, sesiones firmadas + rotación, logout, bloqueo por intentos fallidos — **todo esto de fábrica, sin código propio** | Un `clerk.provider.ts` que implemente `AuthProvider` (llamar al SDK de Clerk para verificar la sesión de la request, mapear el usuario de Clerk a un `User` de nuestro `schema.prisma` vía `clerkId`, ya modelado) + UI de login/signup (Clerk provee componentes React prearmados) + sincronizar invitaciones de Clerk con la creación de `User`/asignación de `Role` en nuestra base | Free tier hasta 10,000 usuarios activos/mes (más que suficiente para una agencia chica) — plan pago solo si se necesitan features enterprise (SSO/dominios custom de email), no previsto para este alcance |
| **Autenticación propia** (bcrypt/argon2 + sesiones propias + TOTP propio) | Nada de fábrica — todo se construye | Hash de contraseña, flujo de recuperación (tokens de un solo uso + email real, que requiere Gmail/SES ya resuelto), MFA TOTP (librería `otplib` o similar), invitaciones (tokens + email), gestión de sesión (cookies firmadas, rotación, expiración), rate limiting de intentos fallidos — superficie de seguridad mucho mayor para mantener correcta | $0 en licencia, pero costo real en tiempo de desarrollo y en riesgo (autenticación propia es la categoría de código con más consecuencias si tiene un bug) |

**Recomendación de este documento:** Clerk — el código YA está preparado para esto desde F0 (`AuthProvider`, `User.clerkId`, `AUTH_MODE=clerk`), reduce drásticamente la superficie de código de seguridad propio a mantener, y cubre el 100% del alcance pedido por el PO (contraseña/recuperación/MFA/invitaciones/sesiones/logout/bloqueo) sin construir nada de eso a mano. Requiere aprobación explícita del PO antes de crear la cuenta — igual que Hunter.io/Google Places/People Data Labs en fases anteriores.

### 3.3 Qué se construye de cualquier forma (independiente de cuál opción se elija)

- `clerk.provider.ts` (o `custom-auth.provider.ts`) implementando `AuthProvider` — reemplaza `dev-bypass.provider.ts` en producción, sin tocar ningún otro módulo (mismo principio que ya documenta el comentario del código).
- **Auditoría de sesión**: cada login/logout exitoso y cada intento fallido se registra en `AuditLog` (`actorType: "HUMAN"`, `action: "auth.login"` / `"auth.login_failed"` / `"auth.logout"`) — reutiliza el modelo existente, cero schema nuevo.
- **Bloqueo por intentos fallidos**: si se usa Clerk, esto ya viene de fábrica (configurable en su dashboard); si es auth propia, se implementa como un contador con ventana de tiempo, mismo patrón que los guardias de presupuesto ya existentes (`getMissionBudgetStatus`, etc.) — un `Tenant.settings.maxFailedLoginAttempts` configurable, nunca hardcodeado.
- **Invitaciones → creación de `User`**: un flujo nuevo (`POST /users/invite`, `requirePermission("users.manage")`) que crea la invitación (vía Clerk o token propio) y, al aceptarse, crea el `User`/asigna `Role` — reutiliza el modelo `User`/`Role` ya existente, sin cambios de schema.
- **`AUTH_MODE=dev-bypass` nunca puede quedar activo en producción** — se agrega una validación explícita en `env.ts` o en el arranque del server: si `NODE_ENV=production` y `AUTH_MODE=dev-bypass`, el proceso se niega a arrancar (falla rápido y ruidoso, no un bug silencioso de seguridad).

---

## 4. Formularios de empleadores y candidatos → conexión al CRM

### 4.1 Endpoints nuevos (públicos, sin auth — primera vez en el proyecto)

| Formulario | Endpoint propuesto | Qué crea |
|---|---|---|
| Contact | `POST /public/contact` | Un `Activity` genérico o un `Lead` mínimo (a decidir con el PO — probablemente un `Lead` con `source: "website-contact-form"`, igual que el importador de F3 ya distingue `source`) |
| Request Staff | `POST /public/request-staff` | Un `Lead` real (`source: "website-request-staff"`) — mismo modelo que ya usa Discovery/Prospecting, nunca un modelo nuevo |
| Apply for Jobs | `POST /public/apply` | Un `Candidate` real (`Candidate` ya existe desde F0) |

### 4.2 Reglas de seguridad para un endpoint público (superficie nueva, primera vez en el proyecto)

- **Rate limiting obligatorio** por IP — nunca implementado hasta ahora porque ningún endpoint era público; acá es no-negociable (evita spam/abuso trivial).
- **CAPTCHA o equivalente** (ej. Cloudflare Turnstile, gratis) — a evaluar, mismo criterio de "no contratar sin aprobación" si implica una cuenta/proveedor nuevo.
- **Validación estricta con Zod** (mismo patrón que todo el resto del proyecto) — nunca insertar un campo de texto libre sin sanitizar en una columna que después se muestra en la UI interna sin escapar.
- **Nunca el mismo pipeline que un Lead creado por un agente de IA** — un Lead que viene de un formulario público es `triggeredBy` un actor externo anónimo, no `"AGENT"` ni `"USER"` interno; puede necesitar un `TaskTrigger`/`source` distinguible para que un humano lo revise antes de que cualquier agente le escriba (mismo principio de aprobación humana ya aplicado en outreach).
- **Nunca dispara un agente de IA automáticamente** — un formulario público crea el registro (Lead/Candidate), pero no debe encadenar automáticamente `scoreCompany`/`draftOutreach`/etc. sin que quede claro que el dato de origen es no confiable (a diferencia de una importación CSV hecha por un humano interno) — a definir el criterio exacto con el PO antes de implementar.

---

## 5. Seguridad (transversal a todo F4.8)

- No exponer API keys ni secretos de Clerk (o de la solución de auth elegida) — mismo estándar ya sostenido en F4.5–F4.7.
- Sesiones firmadas, con expiración, con rotación — nunca un token que no expira.
- CSRF: si se usan cookies de sesión (en vez de solo Bearer tokens), protección CSRF obligatoria en cualquier mutación.
- Rate limiting en endpoints de login (bloqueo por intentos fallidos, §3.3) y en los 3 endpoints públicos nuevos (§4.2).
- `AUTH_MODE=dev-bypass` bloqueado explícitamente fuera de desarrollo (§3.3).
- Todo el tráfico de producción sobre HTTPS — sin excepción, en ambos dominios.

---

## 6. Bloqueantes reales — a la espera de resolución antes de escribir código funcional

### B1 — Elección de proveedor de autenticación
**Decisión pedida al PO:** ¿Clerk (recomendado, §3.2) o autenticación propia? Si es Clerk, hace falta crear la cuenta y confirmar el plan (free tier alcanza para el volumen actual).

### B2 — Acceso a DNS de dreistaff.com
Hace falta que el PO controle o dé acceso a la zona DNS de `dreistaff.com` para poder apuntar `app.dreistaff.com` (y eventualmente `careers.`/`clients.`) al hosting real, una vez elegido.

### B3 — Elección de hosting (backend, frontend, base de datos)
No evaluado en este documento — requiere una decisión de producto/presupuesto del PO antes de que este plan pueda incluir pasos de despliegue concretos.

### B4 — Textos legales reales (Privacy Policy, Terms, EEO)
No se puede publicar un Privacy Policy/Terms genérico o inventado — requiere texto real, revisado (idealmente por alguien con conocimiento legal), específico a la jurisdicción donde opera la agencia. Mismo criterio que ya aplicó F4.7 a la dirección postal: no se inventa.

### B5 — Criterio de qué hacer con un Lead/Candidate creado por un formulario público
¿Requiere aprobación humana antes de que cualquier agente lo toque? ¿Entra directo al mismo pipeline que un Lead creado por Discovery? A definir con el PO (§4.2).

### B6 — CAPTCHA/anti-spam para los formularios públicos
¿Se aprueba un proveedor (ej. Cloudflare Turnstile, gratis) o se prefiere otra estrategia?

---

## 7. Definition of Done

- [ ] `dreistaff.com` público sirviendo las 11 páginas de §1.1, sin exponer ninguna ruta/dato del CRM interno
- [ ] Botón Login del sitio público redirige a `https://app.dreistaff.com`
- [ ] `app.dreistaff.com` sirviendo la SPA privada existente, sin cambios de lógica de negocio
- [ ] `AuthProvider` de producción implementado (Clerk u otro, según B1) — contraseña, recuperación, MFA, invitaciones, sesiones seguras, logout, bloqueo por intentos fallidos, todo funcionando con datos reales
- [ ] `AUTH_MODE=dev-bypass` verificado imposible de activar accidentalmente en producción
- [ ] Auditoría de login/logout/intentos fallidos visible en `AuditLog`
- [ ] 3 formularios públicos (Contact/Request Staff/Apply for Jobs) creando registros reales en el CRM, con rate limiting y validación
- [ ] Ningún dato inventado en ningún texto legal — todo revisado por el PO antes de publicar
- [ ] `pnpm typecheck`/`lint`/`test` limpios en todo el monorepo
- [ ] Verificación en navegador real (sitio público Y portal privado) sin errores de consola
- [ ] F0–F4.7 intactos
- [ ] Aprobación explícita del PO de cada bloqueante (B1–B6) antes de escribir el código correspondiente

---

**Este documento es de planificación. No se implementa F4.8 hasta recibir aprobación explícita, separada de la aprobación del branding ya decidido (F4.7 Addendum 2).**
