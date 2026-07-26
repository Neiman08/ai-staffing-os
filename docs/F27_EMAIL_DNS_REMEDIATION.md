# F27 Fase 8 — Estado real de SPF/DKIM/DMARC (dreistaff.com) y remediación exacta

Verificado por `dig` real (read-only, sin modificar ningún registro). Primera versión:
2026-07-25 (SPF y DKIM rotos). **Actualizado 2026-07-26**: SPF fue corregido por alguien
con acceso a GoDaddy entre esa fecha y hoy — confirmado con 3 resolutores DNS
independientes (local, 8.8.8.8, 1.1.1.1). DKIM sigue exactamente igual que el
2026-07-25 — el CNAME publicado sigue sin resolver, confirmado con los mismos 3
resolutores. Mientras DKIM no pase de forma verificable en el encabezado real de un
mensaje recibido, la entregabilidad de DreiStaff se mantiene **parcialmente degradada**
(mejor que antes, dado que SPF ya autoriza a M365 como emisor real, pero sin DKIM la
alineación DMARC completa sigue sin poder confirmarse de forma pública).

## Estado actual (re-verificado 2026-07-26, read-only, 3 resolutores independientes)

| Registro | Valor actual | Estado |
|---|---|---|
| SPF (`TXT` en `dreistaff.com`) | `v=spf1 include:secureserver.net include:spf.protection.outlook.com -all` | ✅ **Corregido** — ya incluye `spf.protection.outlook.com`, M365 queda autorizado como emisor real |
| DKIM (`CNAME` en `selector1._domainkey.dreistaff.com`) | → `selector1-dreistaff-com._domainkey.netorgft20948324.a-v1.dkim.mail.microsoft.` | ⚠️ **Sigue roto, sin cambios** — ese destino sigue sin resolver ningún registro (confirmado hoy con `dig`, `dig @8.8.8.8`, `dig @1.1.1.1`) — falta `.com` al final |
| DKIM (`CNAME` en `selector2._domainkey.dreistaff.com`) | → `selector2-dreistaff-com._domainkey.netorgft20948324.a-v1.dkim.mail.microsoft.` | ⚠️ **Sigue roto, sin cambios** — mismo problema exacto que selector1 |
| DMARC (`TXT` en `_dmarc.dreistaff.com`) | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` | Correcto tal cual está — NO tocar esto hasta que DKIM también pase de forma sostenida |
| MX | `dreistaff-com.mail.protection.outlook.com` | Correcto — confirma que M365/Exchange Online es el receptor real del dominio |

**Nota importante sobre evidencia externa reportada**: se recibió evidencia de que
Microsoft Defender muestra DKIM "habilitado y aplicando firmas" para `dreistaff.com`, y
que Mail Tester reportó 10/10. Esto describe el lado de ENVÍO (M365 firmando outbound) y
no es necesariamente contradictorio con que el registro DNS público (lo que un RECEPTOR
usa para validar esa firma) siga sin resolver — pero mientras el CNAME público no
resuelva, ningún receptor real puede validar esa firma con certeza. La verificación
definitiva requiere el encabezado `Authentication-Results` del mensaje realmente
recibido, no disponible en este entorno (ver `RELEASE_READINESS.md` §2 para el detalle
completo de este razonamiento).

## Remediación exacta (ninguna acción fue ejecutada — instrucciones para un admin con acceso a GoDaddy y M365 Admin Center)

### 1. SPF — ✅ YA CORREGIDO (verificado 2026-07-26)

Registro real actual: `v=spf1 include:secureserver.net include:spf.protection.outlook.com -all`.
Ya incluye Microsoft 365 como emisor autorizado. Sin acción pendiente. **Criterio de
éxito restante**: confirmar `spf=pass` en el encabezado `Authentication-Results` de un
mensaje real recibido (no verificado todavía por falta de acceso al buzón receptor —
ver `RELEASE_READINESS.md` §2).

### 2. DKIM — corregir el CNAME roto y habilitar la firma en M365

- **Registro actual (selector1)**: `selector1._domainkey.dreistaff.com` → `selector1-dreistaff-com._domainkey.netorgft20948324.a-v1.dkim.mail.microsoft.` (sin resolver)
- **Registro recomendado (selector1)**: `selector1._domainkey.dreistaff.com` → `selector1-dreistaff-com._domainkey.netorgft20948324.a-v1.dkim.mail.microsoft.com`
- **Registro actual (selector2)**: `selector2._domainkey.dreistaff.com` → `selector2-dreistaff-com._domainkey.netorgft20948324.a-v1.dkim.mail.microsoft.` (sin resolver)
- **Registro recomendado (selector2)**: `selector2._domainkey.dreistaff.com` → `selector2-dreistaff-com._domainkey.netorgft20948324.a-v1.dkim.mail.microsoft.com`
- **Host/Name**: `selector1._domainkey` y `selector2._domainkey` respectivamente
- **Tipo**: `CNAME`
- **TTL recomendado**: 3600
- **Riesgo de configurarlo mal**: bajo — un CNAME de DKIM roto simplemente no firma (el estado actual), nunca bloquea el envío en sí.
- **Pasos para habilitar la firma DKIM en M365** (Microsoft 365 Defender / Exchange Admin Center, `security.microsoft.com` → Email & collaboration → Policies & rules → Threat policies → Email authentication settings → DKIM, o vía Exchange Online PowerShell):
  1. Corregir los 2 registros CNAME arriba en el DNS real (GoDaddy).
  2. Esperar la propagación real (`dig` debe mostrar que ambos CNAME ahora resuelven a un host real).
  3. En el panel de DKIM de Microsoft 365 para `dreistaff.com`, activar ("Enable") la firma DKIM — hoy estará en estado "not configured" o con error, porque el CNAME nunca resolvió.
  4. Alternativa por PowerShell: `Rotate-DkimSigningConfig -Identity dreistaff.com -KeySize 2048` seguido de `Set-DkimSigningConfig -Identity dreistaff.com -Enabled $true` una vez el CNAME resuelve.
- **Verificación después del cambio**: `dig +short CNAME selector1._domainkey.dreistaff.com` debe resolver hasta un host real (no vacío); un correo real enviado debe mostrar `dkim=pass` en "Authentication-Results" del destinatario.
- **Criterio de éxito**: DKIM "Enabled" en el panel de M365 Y un envío real firma con `dkim=pass`.

### 3. DMARC — no tocar todavía

- **Registro actual**: `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;`
- **Recomendación**: dejarlo en `p=quarantine` hasta confirmar SPF+DKIM en `pass` de forma sostenida (varios días de correo real limpio) — subir a `p=reject` antes de eso arriesga rebotar duro correo legítimo que todavía no pasa alineación. Revisar los reportes agregados reales que ya llegan a `dmarc_rua@onsecureserver.net` para confirmar antes de subir la política.

## Por qué esto no se marca "resuelto" en su totalidad

SPF ya se verificó corregido con evidencia reproducible (§ arriba). DKIM sigue roto en el
DNS público — ningún cambio de código de esta misión puede corregir el CNAME (vive en
GoDaddy) ni activar la firma en M365 Admin Center, panel al que este entorno no tiene
acceso. Mientras DKIM no resuelva Y se confirme `dkim=pass` en un encabezado real
recibido, la entregabilidad de DreiStaff se declara **parcialmente degradada** (mejor que
antes de la corrección de SPF, no completamente resuelta todavía).
