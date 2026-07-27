# F27 Fase 5 — Riesgo real de las credenciales de envío (Microsoft Graph)

Este documento es la contraparte de código de la Fase 5: qué se endureció en el repo,
qué riesgo real **no puede cerrarse solo con código**, y las acciones externas exactas
recomendadas. Ninguna de las acciones de este documento fue ejecutada — requieren
acceso a paneles (Azure AD / Exchange Admin Center) que este entorno no tiene.

## Qué se corrigió en el código (ya aplicado, ver commits de esta rama)

`sendGraphMail` (el único punto que realmente llama a Microsoft Graph) ahora exige un
`SendAuthorization` real: `emailMessageId` + `tenantId` + `correlationId` de una fila
`EmailMessage` que ya existe en estado `PENDING`. Sin esa fila real, la función se
niega a pedir siquiera un token — nunca toca la red. `email-service.ts` (el único
llamador de producción) siempre crea esa fila ANTES de llamar a `sendGraphMail`, así
que el flujo oficial nunca se ve afectado. Un script ad-hoc que importe `sendGraphMail`
directamente (como parece haber ocurrido con los 5 correos investigados en esta misión)
ya no puede enviar nada sin antes crear esa misma fila real — en cuyo caso deja de ser
un envío "fuera del flujo", porque el rastro que se buscaba garantizar ya existe.

## Lo que el código NUNCA puede cerrar por sí solo

`AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` en `.env` son credenciales de una **aplicación
Azure AD con permiso de aplicación `Mail.Send`** (Client Credentials, app-only). Ese
permiso, tal como está configurado hoy, autoriza a cualquiera que posea el
`client_secret` a enviar correo **como cualquier buzón del tenant de Microsoft 365**
(no solo `sales@dreistaff.com`) — la restricción a un buzón específico que ve este
repo (`sender-profiles.ts`, `/users/{mailbox}/...`) es una decisión de la aplicación,
**no una restricción impuesta por Azure/Exchange**. Cualquier proceso, script o persona
que tenga ese secreto — dentro o fuera de este repo — puede enviar correo real sin
pasar por ningún código de DreiStaff, y ningún cambio en este código puede impedirlo.

## Acciones externas recomendadas (no ejecutadas — requieren acceso admin)

1. **Exchange Online Application Access Policy** (la mitigación real de raíz): crear
   una política que restrinja esta aplicación (por su Client ID) a enviar
   *únicamente* como `sales@dreistaff.com`, para que Azure AD/Exchange rechacen
   cualquier intento de esta app de enviar como otro buzón — incluso si alguien usa
   el secreto fuera de este código. Comando de referencia (Exchange Online
   PowerShell, ejecutar como admin):
   ```powershell
   New-ApplicationAccessPolicy -AppId "<AZURE_CLIENT_ID>" `
     -PolicyScopeGroupId "sales@dreistaff.com" `
     -AccessRight RestrictAccess `
     -Description "Restrict DreiStaff app to sales@dreistaff.com only"
   ```
   Verificar después con `Test-ApplicationAccessPolicy -AppId "<AZURE_CLIENT_ID>" -Identity "sales@dreistaff.com"` (debe dar `AccessCheckResult: Granted`) y contra
   cualquier otro buzón del tenant (debe dar `Denied`).

2. **Revisar si esta política ya existe.** No fue posible verificar esto desde el
   entorno actual — este repo no tiene ni las credenciales de Exchange Online
   PowerShell ni un permiso Graph que exponga `applicationAccessPolicy` (el app
   registration solo tiene `Mail.Send`). Requiere que un admin corra
   `Get-ApplicationAccessPolicy` en Exchange Online PowerShell.

3. **Rotar `AZURE_CLIENT_SECRET`** una vez terminadas las pruebas de esta misión
   (incluyendo el envío controlado de la Fase 11) — un secreto que existió sin la
   política de acceso de arriba debe tratarse como potencialmente sobre-expuesto
   incluso si no hay evidencia concreta de mal uso. Rotar en Azure AD > App
   registrations > (esta app) > Certificates & secrets, y actualizar `.env` /
   el secret manager real que use el entorno de producción.

4. **Revisar logs reales de Azure AD/Exchange** para el Client ID de esta app:
   Azure AD sign-in logs (sign-ins de tipo "service principal" para este App ID) y
   el message trace / audit log de Exchange Online para `sales@dreistaff.com` en la
   ventana de tiempo de los 5 correos ya identificados (2026-07-24T19:58–20:01 UTC),
   buscando cualquier IP/hora que no corresponda a este entorno de desarrollo.

Ninguna de estas 4 acciones se ejecutó ni se simuló — quedan como instrucciones
exactas para que un administrador con acceso a Azure AD/Exchange Admin Center las
realice. Mientras la Application Access Policy (#1) no exista, el riesgo real de uso
de las credenciales fuera de este código permanece abierto — el endurecimiento de
`sendGraphMail` en este repo reduce la superficie de error/ad-hoc *dentro* del
código, pero no reemplaza esta mitigación externa.
