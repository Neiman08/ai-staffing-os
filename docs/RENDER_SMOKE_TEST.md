# Render Smoke Test Checklist

F12.11 (actualizado en F14, 2026-07-19: cobertura de `apps/marketing`). Checklist manual para correr contra un entorno real (Render u otro) después de cada deploy. No es un reemplazo de la suite automatizada (`.github/workflows/ci.yml`) — es la verificación de que el entorno desplegado específico, con sus credenciales y URLs reales, funciona de punta a punta. Ninguno de estos pasos fue ejecutado contra Render real (no hay un entorno de Render real conectado todavía — ver `docs/RENDER_DEPLOYMENT.md` §4).

Marcar cada ítem con el resultado real observado, nunca asumir.

## 1. Smoke mínimo (correr en TODO deploy, sin excepción)

- [ ] `GET /api/v1/health` responde `200 {"status":"ok","db":true}`.
- [ ] `GET /api/v1/health/ready` responde `200` (DB real + migraciones aplicadas + `AUTH_MODE` bien configurado).
- [ ] `GET /api/v1/health/live` responde `200` sin tocar la DB.
- [ ] El frontend (`ai-staffing-os-web`) carga en el navegador sin pantalla en blanco.
- [ ] Login real (o dev-bypass, según el entorno) funciona y llega al Dashboard.
- [ ] La consola del navegador no muestra errores no esperados en el Dashboard (ver F12.10, `NotFound.tsx`/`ErrorBoundary.tsx` — un error real ahora se ve, nunca una pantalla muerta silenciosa).
- [ ] Los headers de seguridad están presentes (`curl -I` contra la API real): `Content-Security-Policy` ausente pero `X-Content-Type-Options`, `X-Frame-Options`/equivalente de helmet presentes (ver F12.4).
- [ ] La landing (`ai-staffing-os-marketing`) carga en el navegador sin pantalla en blanco, y `robots.txt`/`sitemap.xml` responden con el dominio real (no `dreistaff.com` por default si el dominio real es otro — confirma que `BUSINESS_DOMAIN` se completó antes del build).
- [ ] Al menos un formulario/CTA de la landing que llama a `/api/v1/public/*` (ej. "Request Talent") completa exitosamente contra el API real — confirma que `VITE_API_URL` de `ai-staffing-os-marketing` apunta al servicio correcto (F14: antes de esto, un path relativo sin esta variable habría fallado silenciosamente contra el propio dominio estático).

## 2. Autenticación y sesión

- [ ] Con `AUTH_MODE=dev-bypass` (mientras Clerk siga diferido): confirmar que este modo **nunca** está activo si `NODE_ENV=production` — si el deploy tiene `NODE_ENV=production`, `GET /api/v1/health/ready` debe reportar `AUTH_MODE=clerk`, nunca `dev-bypass` (el arranque ya falla si no, pero verificar en el smoke igual).
- [ ] Con `AUTH_MODE=clerk` (cuando se active): login real, logout real, sesión expirada redirige a `/sign-in`, no a una pantalla rota.
- [ ] Un usuario sin sesión que pide una ruta protegida directamente (URL manual) es redirigido, nunca ve datos.

## 3. Tenancy y aislamiento (repetir contra el entorno real, no solo confiar en los tests)

- [ ] Un usuario del tenant A no puede ver datos del tenant B manipulando IDs en la URL (probar con un endpoint real, ej. `GET /api/v1/companies/<id-de-otro-tenant>` → 404, nunca los datos).
- [ ] Un identity de portal (cliente/candidato/trabajador) no puede alcanzar un endpoint interno (`GET /api/v1/revenue/summary` u otro de `requireInternalIdentity()`) → 403 real.
- [ ] CORS: un origen no listado en `APP_ORIGIN`/`MARKETING_ORIGIN`/`API_ORIGIN` reales es rechazado (probar con `curl -H "Origin: https://evil.example.com"`).

## 4. Rate limiting (verificar que está realmente activo en producción, no solo en tests)

- [ ] `POST /api/v1/missions` sin exceder el límite responde con headers `RateLimit-Limit`/`RateLimit-Remaining` reales.
- [ ] Nunca ejecutar el disparo real de 20+ misiones para "probar" el 429 en producción — eso gasta OpenAI real. Confirmar la config vía el header es suficiente.

## 5. CEO Agent / misiones (flujo comercial completo)

- [ ] Lanzar una misión real de bajo alcance ("Busca 1 empresa de manufactura en \<estado real\>").
- [ ] La misión transiciona QUEUED → RUNNING → un estado terminal real (nunca queda indefinidamente en RUNNING — ver el bug ya corregido y su test de regresión).
- [ ] El costo de IA reportado es > 0 y coherente con una sola misión pequeña.
- [ ] Si algo fue encontrado: Company/Contact/Lead/Opportunity reales visibles en la UI, sin duplicados.

## 6. Operaciones internas (backoffice)

- [ ] Crear/editar un Job Order real.
- [ ] Ejecutar matching real sobre un Job Order con candidatos existentes.
- [ ] Onboarding real de un Worker (checklist generado, al menos un item cambia de estado).
- [ ] Un Payroll Run real avanza al menos un estado de su máquina de estados.

## 7. Portales (cliente / candidato / trabajador)

- [ ] Un usuario de portal cliente ve solo sus propios Job Orders/Workers/Assignments.
- [ ] Un candidato puede ver su propio perfil/aplicaciones, nunca el ranking/score interno de otros candidatos.
- [ ] Un trabajador puede ver sus propios Assignments/Time Entries, nunca el bill rate interno.

## 8. Backups y recuperación (verificar la config real, no re-ejecutar el ciclo completo en producción)

- [ ] Confirmar en el dashboard de Render que el plan de la base de datos real incluye backups automáticos (plan `starter` o superior).
- [ ] `./scripts/db-backup.sh "postgresql://<URL real de producción>"` corre exitosamente al menos una vez desde que el entorno existe (backup manual de referencia).
- [ ] El procedimiento de restore (`docs/BACKUP_AND_RESTORE.md` §7) fue probado contra una copia real de producción en una base aislada, no solo contra datos de desarrollo — repetir esa prueba específica contra un dump real de producción antes de confiar en ella para un incidente real.

## 9. Observabilidad

- [ ] Los logs del servicio en el dashboard de Render muestran líneas JSON estructuradas (`http_request`, etc.), no texto libre sin estructura.
- [ ] Un deploy nuevo muestra `graceful_shutdown_started` y `graceful_shutdown_complete` en los logs del deploy anterior (shutdown limpio, no un kill forzado).
- [ ] `X-Request-Id` está presente en las respuestas de la API real (permite correlacionar un error reportado por un usuario con una línea de log específica).

## 10. Rendimiento (evidencia, no intuición)

- [ ] Las páginas con más datos (Dashboard, Analytics ejecutivo) cargan en un tiempo razonable contra datos reales de producción, no solo contra el seed pequeño de desarrollo.
- [ ] Si el volumen real de producción supera significativamente al de desarrollo, repetir el análisis `EXPLAIN ANALYZE` de F12.8 contra las tablas más grandes reales.

## 11. Después de un smoke test fallido

1. No ocultar el fallo — documentarlo (qué ítem, qué se observó, captura si aplica).
2. Si es un problema de config (env var faltante/incorrecta en el dashboard de Render): corregir en el dashboard, no en el código, si el código ya era correcto.
3. Si es un bug real de código: seguir el procedimiento normal (rollback si es urgente, ver `docs/ROLLBACK.md`; fix + test de regresión + nuevo deploy si no es urgente).
4. Repetir el checklist completo después de cualquier corrección antes de considerar el deploy sano.
