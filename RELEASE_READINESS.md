# RELEASE_READINESS.md — `fix/email-integration-hardening`

Auditoría final de release, corregida el 2026-07-26 tras una segunda pasada exigida
explícitamente por el usuario para eliminar imprecisiones de la versión anterior de este
documento. Ningún push, merge, ni apertura de Pull Request fue realizado.

## Recomendación objetiva: **GO**, con salvedades documentadas

Ninguna regresión real permanece sin corregir. Los 7 resultados que no fueron "pass" están
completamente explicados abajo, con evidencia directa y reproducible de que ninguno es
causado por esta rama (confirmado contra `main` real, en un worktree aislado, sin tocar la
rama actual). Se corrigió la afirmación anterior sobre SPF/DKIM, que estaba desactualizada
para SPF y no podía sostenerse como una certeza total para DKIM sin el encabezado real del
mensaje recibido — ver §2.

---

## 1. Los 7 resultados que no fueron "pass" — matemática completa

`1838 tests = 1831 pass + 2 fail + 5 skip`. Los 5 `skip` son un diseño deliberado
(gateados detrás de `RUN_REAL_PROVIDER_TESTS=1`, que nunca está activo en una corrida
normal para no gastar créditos reales de proveedores pagos) — no una omisión ni un hueco
de cobertura. Los 2 `fail` fueron investigados hasta la causa raíz y confirmados
**pre-existentes en `main`**, con evidencia directa (no solo argumentada) descrita abajo.

**Método de comparación contra `main`**: `git worktree add` en un directorio aislado
(`/private/tmp/.../main-worktree`), `pnpm install` + `prisma generate` propios de ese
worktree (confirmado que NO comparte `node_modules` con el repo real — verificado con
`readlink -f` en ambas rutas antes y después, y con el health-check del servidor de
desarrollo real, que siguió respondiendo 200 en todo momento). Los mismos 2 archivos de
test se corrieron ahí, contra la misma base de datos real de desarrollo. Worktree
eliminado (`git worktree remove --force`) al terminar — `git status` de la rama actual
confirmado sin cambios.

| # | Paquete | Archivo | Test | Estado exacto | Mensaje de error | ¿Archivo modificado por esta rama? | ¿Falla también en `main`? | Clasificación |
|---|---|---|---|---|---|---|---|---|
| 1 | `@ai-staffing-os/api` | `src/modules/agents/tools/contact-intelligence.test.ts` | `findContacts (llamada real al proveedor configurado o ausencia honesta): siempre termina DONE, nunca inventa datos` | `skipped` | `# SKIP llamada real a proveedor externo pago -- gateada detrás de RUN_REAL_PROVIDER_TESTS=1` | No | N/A (skip por diseño, no una falla) | Infraestructura (gate deliberado) |
| 2 | `@ai-staffing-os/api` | `src/modules/agents/tools/contact-intelligence.test.ts` | `findEmail (llamada real a Website Intelligence + Hunter.io o ausencia honesta): siempre termina DONE, nunca inventa un email` | `skipped` | `# SKIP llamada real a proveedor externo pago -- gateada detrás de RUN_REAL_PROVIDER_TESTS=1` | No | N/A | Infraestructura (gate deliberado) |
| 3 | `@ai-staffing-os/api` | `src/modules/discovery/discovery.test.ts` | `discoverCompanies (llamada real al proveedor configurado): siempre termina DONE, nunca inventa datos, provenance completa si crea algo` | `skipped` | `# SKIP llamada real a proveedor externo pago -- gateada detrás de RUN_REAL_PROVIDER_TESTS=1` | No | N/A | Infraestructura (gate deliberado) |
| 4 | `@ai-staffing-os/api` | `src/modules/discovery/discovery.test.ts` | `discoverCompanies con searchTerms: corre una búsqueda independiente por frase, nunca inventa datos` | `skipped` | `# SKIP llamada real a proveedor externo pago -- gateada detrás de RUN_REAL_PROVIDER_TESTS=1` | No | N/A | Infraestructura (gate deliberado) |
| 5 | `@ai-staffing-os/api` | `src/modules/missions/missions-dynamic-discovery.test.ts` | `una instrucción de descubrimiento externo (Manufacturing/IL, bucket real) ejecuta el nuevo ejecutor dinámico; respeta 'no crear campañas ni oportunidades' pero SÍ puede crear Leads de investigación (F14)` | `skipped` | `# SKIP llamada real a proveedor externo pago -- gateada detrás de RUN_REAL_PROVIDER_TESTS=1` | No | N/A | Infraestructura (gate deliberado) |
| 6 | `@ai-staffing-os/api` | `src/modules/agents/mission-discovery-fallback.test.ts` | `el fallback automático descubre empresas reales de Hospitality y las lleva a lead/oportunidad real (nunca Demo)` | `failed` | Corrida original: `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + 'PARTIAL' - 'COMPLETED'` en la línea 172 (`assert.equal(detail.missionState, "COMPLETED")`). **Corrida de comparación contra `main`**: falló con una señal de error DISTINTA (`industryNames` vacío en vez de `['Hospitality']`, línea 169) — confirma que el test es genuinamente no-determinista entre corridas, no solo "siempre falla igual" | No | **Sí — confirmado, reproducido en vivo en el worktree de `main`** (con una señal de fallo distinta, ver columna anterior) | Preexistente + no determinismo (depende de una llamada real a OpenAI/Google Places/PDL/Hunter, sin mock) |
| 7 | `@ai-staffing-os/api` | `src/modules/agents/mission-planning.test.ts` | `compatibilidad con misiones antiguas: una misión real ya existente (sin ceoIntent/missionPlan) se sigue leyendo sin romperse` | `failed` | `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal` — `detail.ceoIntent` esperado `null`, real: un objeto completo (`businessActivities`, `companyTypes`, `decisionRoles`...). El test asume que la fila `daily_revenue_mission` más antigua de `tenant-titan` predata F7.2 (sin `ceoIntent`); la base de desarrollo compartida ya no tiene ninguna fila así | No | **Sí — confirmado, reproducido en vivo en el worktree de `main`, con el mismo mensaje de error exacto** | Preexistente + infraestructura (test depende de la antigüedad acumulada de una base de datos compartida de desarrollo, no de un fixture propio) |

**Ninguno de los 7 archivos que contienen estos resultados fue modificado por esta
rama** (verificado con `git diff main...fix/email-integration-hardening --name-only`).
**Ninguno de los 7 es una regresión.** Los 5 `skipped` son diseño intencional (no forman
parte de la resta 1838-1831 como "fallos" en ningún sentido — están correctamente
contados aparte). Los 2 `failed` están confirmados idénticos en `main`, con evidencia
directa de ejecución, no solo de lectura de código.

## 2. SPF y DKIM — corrección con evidencia actual, no un diagnóstico antiguo

**Se retira la afirmación "SPF/DKIM rotos" tal como estaba escrita — estaba desactualizada
para SPF y era una generalización excesiva para DKIM.** Verificación real, ahora mismo
(2026-07-26), con 3 resolutores DNS independientes (local, Google 8.8.8.8, Cloudflare
1.1.1.1 — mismo resultado en los 3, descartando caché/propagación como explicación):

| Registro | Estado verificado ahora | Evidencia |
|---|---|---|
| **SPF** | ✅ **Corregido, confirmado.** `v=spf1 include:secureserver.net include:spf.protection.outlook.com -all` — ya incluye Microsoft 365. Esto es un cambio real desde la última verificación de esta rama (2026-07-25); alguien corrigió el registro en GoDaddy entre esa fecha y hoy. | `dig +short TXT dreistaff.com`, repetido contra 3 resolutores |
| **DKIM (CNAME)** | ⚠️ **Discrepancia real, sin resolver.** El CNAME publicado (`selector1._domainkey.dreistaff.com` / `selector2._domainkey.dreistaff.com`) sigue apuntando a `...dkim.mail.microsoft.` (sin `.com`) y ese destino **no resuelve ningún registro** (ni A ni CNAME) contra ninguno de los 3 resolutores. Esto contradice, en el nivel de DNS público, la evidencia citada (Microsoft Defender mostrando DKIM habilitado, Mail Tester 10/10). | `dig`, `dig @8.8.8.8`, `dig @1.1.1.1`, los 3 con el mismo resultado, ahora mismo |
| **DMARC** | Sin cambios, `p=quarantine` — correcto, no se toca hasta confirmar SPF+DKIM en `pass` sostenido. | `dig +short TXT _dmarc.dreistaff.com` |

**Por qué no declaro "DKIM: pass" ni "DKIM: fail" de forma definitiva:** Microsoft 365
puede estar firmando DKIM del lado de envío (lo que Defender reportaría como "habilitado,
aplicando firmas") incluso si el registro CNAME público está roto — pero un receptor real
(Gmail) solo puede VALIDAR esa firma si logra resolver la clave pública publicada en DNS,
que es exactamente lo que acabo de confirmar que no resuelve. Esto significa que "Defender
dice que está firmando" y "el DNS público no permite validar la firma" pueden ser
simultáneamente ciertos y no son contradictorios entre sí — pero si son ciertos a la vez,
el resultado real en la bandeja del destinatario sería `DKIM: fail` o `DKIM: none` (sin
clave), no `pass`, salvo que el mensaje se autentique por otro mecanismo. **No tengo acceso
al buzón de `neimangroupllc@gmail.com`** (es una cuenta externa, fuera del tenant de M365
al que las credenciales de Graph de este proyecto dan acceso), así que no puedo leer el
encabezado `Authentication-Results` del mensaje real recibido para resolver esta
discrepancia con certeza.

**Conclusión corregida, tal como se pidió**: *SPF ya pasa, verificado de forma
reproducible hoy. DKIM no presenta un bloqueo observado del lado de envío según la
evidencia externa citada (Defender, Mail Tester), pero el registro DNS público que
permitiría a un receptor real validar esa firma sigue sin resolver, verificado de forma
reproducible hoy con 3 resolutores independientes — la validación definitiva del
encabezado del mensaje realmente recibido queda pendiente.* Si puedes compartir el
encabezado completo ("Mostrar original" en Gmail) o el enlace/fecha exacta del reporte de
Mail Tester, puedo cerrar esta discrepancia con evidencia directa en vez de inferencia.

`docs/F27_EMAIL_DNS_REMEDIATION.md` queda desactualizado en cuanto a SPF (decía roto, ya
no lo está) — se corrige por separado, ver §7 de la lista de archivos a tocar.

## 3. Estado real del envío — aclaración de a qué corrida pertenece cada evidencia

Dos eventos reales y **distintos** ocurrieron en esta rama, y no deben mezclarse:

**A) El envío real que SÍ llegó a la bandeja de `neimangroupllc@gmail.com`** — corresponde
a la prueba de aceptación **anterior**, vía `/emails/send-manual` (Fase 11 de la misión
original), **no** al nuevo Internal Acceptance Test:
- `EmailMessage` ID: `cms15as4a0000a6yi51vke82s`
- Remitente: `DreiStaff Sales <sales@dreistaff.com>`
- Destinatario: `neimangroupllc@gmail.com`
- Asunto: "DreiStaff — Verificación controlada de trazabilidad"
- `providerMessageId`: `AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AX-VE3mlabEuId_WNY-gIcAAAAuxPDgAA`
- `internetMessageId`: `<PH7PR02MB890509FBB1F350BE9B5AE560A1CD2@PH7PR02MB8905.namprd02.prod.outlook.com>`
- Estado final registrado por DreiStaff: `SENT_CONFIRMED` (confirmado en Sent Items real por el reconciliador)
- Evidencia externa que aportaste (entrega real en Gmail, remitente/Reply-To correctos, TLS, sin NDR, fecha visible 25 de julio de 2026 8:54 p.m.) corresponde a **este mismo mensaje** — es consistente con el `internetMessageId`/`providerMessageId` de arriba, no con ningún ID del punto B.

**B) El Internal Acceptance Test nuevo** — llegó hasta el guardia de anti-duplicado y fue
bloqueado ahí, **nunca generó un EmailMessage ni tocó Microsoft Graph**:
- `ApprovalRequest` ID: `cms1972jb000c9bt0kq2zfvxw`, estado final `FAILED`
- `AuditLog` `approval.send_blocked_by_limit`: *"Ya se envió un email real a
  'neimangroupllc@gmail.com' anteriormente (EmailMessage `cms15as4a0000a6yi51vke82s`...)
  -- nunca se envía dos veces al mismo destinatario."*
- Ningún `providerMessageId`/`internetMessageId` existe para esta corrida — nunca se
  generaron, porque el bloqueo ocurre antes de `sendEmail()`.

**No se atribuye el mensaje recibido en Gmail al nuevo flujo de Internal Acceptance
Test** — los IDs demuestran, sin ambigüedad, que pertenece al envío manual anterior. El
dedup guard no fue modificado, ni se realizó ningún envío real adicional durante esta
auditoría ni durante esta corrección del informe.

## 4. GO / NO-GO — recalculado

| Condición exigida | Cumple |
|---|---|
| Ninguna regresión introducida por la rama | ✅ — la única regresión real encontrada (test de `public/stats`) fue corregida y verificada en la auditoría anterior; los 2 fallos restantes están confirmados pre-existentes en `main` con evidencia de ejecución directa (§1) |
| Los 7 resultados no-pass explicados | ✅ — tabla completa en §1, con clasificación y evidencia contra `main` |
| typecheck/lint/build limpios | ✅ — sin cambios desde la última verificación (esta corrección no tocó código de producto, solo documentación) |
| Migraciones aditivas | ✅ — sin cambios desde la última verificación, las 3 migraciones siguen siendo solo `ADD VALUE`/`ADD COLUMN` (nullable)/`CREATE TABLE` |
| Informe sin afirmaciones falsas/desactualizadas | ✅ — corregido SPF (ya no se afirma "roto"), corregido DKIM (ya no se afirma sin matices), corregida la atribución del envío real (§3) |
| El PR describe con precisión qué se envió y qué se validó | ✅ — ver borrador abajo, explícito sobre qué es evidencia directa vs. evidencia externa citada pendiente de verificación |

**Recomendación: GO.** Ningún hallazgo de esta corrección cambia la conclusión de que el
código es seguro de mergear — los ajustes fueron todos de precisión documental
(reflejar el estado real de SPF/DKIM y aclarar a qué corrida pertenece cada evidencia),
no de código. El único punto genuinamente abierto (validación definitiva de DKIM en el
encabezado real recibido) es un dato externo pendiente, no un bloqueador de este PR.

## Riesgos residuales (actualizados)

1. **DKIM**: registro DNS público roto (confirmado hoy, 3 resolutores) — pendiente de
   corrección en GoDaddy (agregar `.com` al final de ambos CNAME) sin importar lo que
   Defender/Mail Tester hayan reportado del lado de envío. Ver
   `docs/F27_EMAIL_DNS_REMEDIATION.md` (sección DKIM, SPF ya corregida ahí también).
2. **Validación definitiva del encabezado DKIM del mensaje real recibido** — pendiente,
   requiere que el usuario comparta el encabezado completo o el reporte de Mail Tester.
3. **Application Access Policy de Exchange** — sigue sin confirmarse desde este entorno.
4. **Orden de proveedores Hunter/PDL** (Hunter no es hoy el proveedor principal, PDL sí
   está limitado por presupuesto) — decisión de negocio pendiente, sin cambios desde la
   auditoría anterior.
5. **2 tests preexistentes en `main`**, confirmados no relacionados con esta rama —
   seguirán apareciendo en corridas futuras de la suite completa hasta que se revisen por
   separado (no están en el alcance de esta rama).
6. **Datos reales de prueba interna sin eliminar** (Company/Lead/Contact/ApprovalRequest
   `FAILED`, marcados `INTERNAL_TEST`) — sin cambios desde la auditoría anterior.

## Acciones manuales pendientes

1. Corregir el CNAME de DKIM en GoDaddy (agregar `.com` al final de ambos selectores) — SPF ya no requiere acción.
2. Habilitar/confirmar la firma DKIM en M365 Admin Center una vez el DNS resuelva.
3. Compartir el encabezado completo del mensaje real recibido, o el reporte de Mail Tester, para cerrar la validación de DKIM con evidencia directa.
4. Confirmar/crear la Application Access Policy de Exchange restringiendo la app a `sales@dreistaff.com`.
5. Rotar `AZURE_CLIENT_SECRET` después del período de pruebas activo.
6. Decidir si Hunter.io debe pasar a ser el proveedor primario de contactos.
7. Revisar/reconocer las 10 `EmailReconciliationAlert` históricas desde el panel de Settings.
8. Decidir si limpiar la Company/Lead/Contact/ApprovalRequest de prueba interna en la base.

## Checklist de producción

- [x] Build limpio desde cero
- [x] Typecheck limpio (7/7 workspaces)
- [x] Lint limpio (0 errores)
- [x] Suite completa corrida con el script oficial (`--test-concurrency=1`)
- [x] Los 7 resultados no-pass explicados con evidencia directa contra `main`
- [x] Migraciones verificadas aditivas
- [x] Sin secretos/credenciales expuestos, sin código temporal/de depuración
- [x] SPF confirmado corregido con evidencia reproducible de hoy
- [ ] DKIM confirmado con el encabezado real recibido (pendiente, dato externo)
- [ ] Application Access Policy de Exchange confirmada (pendiente, acción externa)
- [ ] Decisión de negocio sobre orden Hunter/PDL (pendiente, decisión del usuario)

## Pull Request preparado — ver `PULL_REQUEST_DRAFT.md`

No abierto, no pusheado, no marcado como listo para merge.
