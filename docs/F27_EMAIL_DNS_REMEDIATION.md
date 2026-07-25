# F27 Fase 8 — Estado real de SPF/DKIM/DMARC (dreistaff.com) y remediación exacta

Verificado por `dig` real (read-only, sin modificar ningún registro) el 2026-07-25.
Mismo resultado que la investigación anterior de esta misión — **sigue roto**, no se
resolvió solo. Mientras SPF/DKIM no pasen, la entregabilidad real de DreiStaff queda
**degradada** (los correos que salen dependen de que DMARC esté en `quarantine` — no
`reject` — para no rebotar duro, pero terminan en spam/cuarentena en vez de bandeja de
entrada la mayoría de las veces).

## Estado actual (verificado hoy, read-only)

| Registro | Valor actual | Estado |
|---|---|---|
| SPF (`TXT` en `dreistaff.com`) | `v=spf1 include:secureserver.net -all` | **Roto** — falta `include:spf.protection.outlook.com`, así que M365 nunca queda autorizado como emisor real |
| DKIM (`CNAME` en `selector1._domainkey.dreistaff.com`) | → `selector1-dreistaff-com._domainkey.netorgft20948324.a-v1.dkim.mail.microsoft.` | **Roto** — ese destino NO resuelve (confirmado con `dig +trace`, cero registros para ese nombre) — falta `.com` al final |
| DKIM (`CNAME` en `selector2._domainkey.dreistaff.com`) | → `selector2-dreistaff-com._domainkey.netorgft20948324.a-v1.dkim.mail.microsoft.` | **Roto** — mismo problema exacto que selector1 |
| DMARC (`TXT` en `_dmarc.dreistaff.com`) | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` | Correcto tal cual está — `p=quarantine` (no `reject`) es la única razón por la que los correos reales no rebotan duro pese a que SPF/DKIM fallan; NO tocar esto hasta que SPF/DKIM pasen |
| MX | `dreistaff-com.mail.protection.outlook.com` | Correcto — confirma que M365/Exchange Online es el receptor real del dominio |

## Remediación exacta (ninguna acción fue ejecutada — instrucciones para un admin con acceso a GoDaddy y M365 Admin Center)

### 1. SPF — agregar Microsoft 365 como emisor autorizado

- **Registro actual**: `v=spf1 include:secureserver.net -all`
- **Registro recomendado**: `v=spf1 include:secureserver.net include:spf.protection.outlook.com -all`
- **Host/Name**: `@` (raíz de `dreistaff.com`)
- **Tipo**: `TXT`
- **TTL recomendado**: 3600 (1 hora) — permite verificar rápido y revertir si algo sale mal
- **Riesgo de configurarlo mal**: un `include` mal escrito no rompe nada por sí solo (SPF sigue siendo aditivo), pero **dos registros SPF distintos en la misma zona SÍ rompen todo** — confirmar que solo existe UN registro `TXT` que empiece con `v=spf1` antes de editar, nunca agregar un segundo.
- **Verificación después del cambio**: `dig +short TXT dreistaff.com` debe mostrar el `include:spf.protection.outlook.com` real; herramienta externa: [MXToolbox SPF Check](https://mxtoolbox.com/spf.aspx) contra `dreistaff.com`.
- **Criterio de éxito**: un correo real enviado desde `sales@dreistaff.com` vía Graph, inspeccionado en el destinatario (ver encabezados "Authentication-Results"), debe mostrar `spf=pass`.

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

## Por qué esto no se marca "resuelto"

Ningún cambio de código de esta misión puede corregir estos 3 registros — viven en GoDaddy
(SPF/DKIM CNAME) y en el M365 Admin Center (activar la firma DKIM), paneles a los que este
entorno no tiene acceso. Mientras sigan rotos, **la entregabilidad real de DreiStaff se
declara DEGRADADA** — el envío controlado de la Fase 11 puede completar el flujo interno
completo (EmailMessage → Graph → Sent Items) sin que eso signifique que el correo llegó
limpio a la bandeja de entrada del destinatario.
