# F4.5 — External Discovery & Communications — Propuesta Técnica

**Estado:** documento de planificación anticipada. **No implementar todavía.** Se escribe ahora, en detalle, para poder arrancar inmediatamente después de que F4 cierre y se verifique — no para implementarse en paralelo ni antes.
**Precedente:** requiere F4 completo y verificado (Campaign, CampaignCompany, Outreach Agent, Conversation Agent, `ApprovalRequest` como frontera de todo lo externo). F4.5 **extiende** esas piezas — no las reemplaza.
**Naturaleza de esta fase:** a diferencia de F0–F4 (que nunca tocaron un sistema externo real más allá de OpenAI), F4.5 es la primera fase que necesariamente involucra: dinero recurrente (proveedores pagos), contratos/ToS de terceros, riesgo legal real (CAN-SPAM, reputación de dominio), y credenciales de acceso a la cuenta de correo real de la agencia. **Cada integración de esta fase requiere aprobación explícita del Product Owner sobre el producto — no solo aprobación de código — antes de contratarse o conectarse**, regla heredada sin cambios desde F2 §4.

---

## 1. Fuentes externas autorizadas para descubrir empresas

Ninguna se contrata ni se conecta con este documento — se documentan como candidatas, cada una con su costo y su encaje:

| Fuente | Qué da | Costo aproximado (2026) | Encaje |
|---|---|---|---|
| **Apollo.io** | Búsqueda de empresas + contactos por industria/tamaño/ubicación, API | Plan API desde ~$49–99/mes (créditos por búsqueda) | Mejor relación cobertura/precio para volumen de una agencia chica |
| **Clearbit (Breeze Intelligence, HubSpot)** | Enriquecimiento de empresa (tamaño, tecnología, industria) | Desde ~$99/mes | Mejor para enriquecer una empresa ya conocida que para descubrir nuevas |
| **ZoomInfo** | Cobertura más profunda, datos de intención de compra | Contratos anuales, $$$$ (miles USD/año) | Fuera de presupuesto razonable para esta etapa de la agencia — se documenta como opción futura, no candidata inicial |
| **Registros estatales de secretaría de estado (IL, IN, WI...)** | Registros de constitución de empresas, permisos de construcción — datos públicos | Gratis | Cobertura limitada e inconsistente por estado; requiere scraping o descarga manual de datasets — encaja mejor como fuente de "listas exportadas" (mismo conector estructurado de F3) que como API en vivo |
| **BLS/Census (ya mencionado en F2 §5)** | Series agregadas por industria/región, sin nivel de empresa individual | Gratis | Sirve para contexto de Market Intelligence, no para descubrir una empresa puntual |
| **Google Places API / Google Maps Platform** | Negocios por categoría + ubicación (nombre, dirección, teléfono, sitio web) | Pago por uso, ~$17/1000 requests (categoría "Places") | Barato y legítimo para detectar existencia de un negocio por zona/categoría; no da tamaño de empresa ni señales de contratación — se combinaría con Apollo para enriquecer |

**Recomendación para la propuesta que se apruebe cuando llegue el momento:** empezar con **Apollo.io** (empresas + contactos en una sola fuente, precio accesible, API documentada) como fuente primaria, y **Google Places** como fuente secundaria barata para completar cobertura geográfica. ZoomInfo queda descartado por costo en esta etapa.

---

## 2. Búsqueda mediante APIs o fuentes públicas permitidas

Nuevo tool para Campaign Agent (o un cuarto agente, "Discovery Agent" — a decidir en el plan detallado de F4.5, no acá): `searchExternalCompanies({ industryName, state, city?, minEstimatedSize? })` — llama a la API elegida (§1), normaliza la respuesta al mismo shape que ya usa el importador de F3 (`ImportCompanyRow`), y la pasa por el **mismo pipeline de importación ya construido en F3** (`POST /prospecting/import`, que ya rechaza industrias sin match y detecta duplicados) — no se construye un segundo camino de creación de `Company`. Esto es reutilización real, no una idea nueva: F3 ya resolvió "cómo entra una empresa al CRM sin que la IA la invente", F4.5 solo cambia la fuente de la fila (API en vez de CSV subido por un humano).

**Límite de costo por búsqueda:** cada llamada a una API de descubrimiento paga consume créditos/dinero real fuera de OpenAI — necesita su propio guardia de presupuesto, análogo a `aiMonthlyBudgetUsd` pero para "gasto de datos" (`Tenant.settings.dataProviderBudgetUsd`), independiente del presupuesto de IA.

---

## 3. Detección de fábricas, warehouses, constructoras, data centers y empresas en expansión

Dos niveles, ninguno con scraping agresivo:
1. **Por categoría de negocio** (vía Apollo/Google Places): filtrar por código NAICS/industria (manufactura, construcción, almacenamiento, data centers son categorías estándar en ambas fuentes).
2. **Señales de expansión** (lo que en la conversación original se llamó "Marketplace de Proyectos", `docs/F3B_PROJECT_MARKETPLACE_PROPOSAL.md`, todavía sin implementar): permisos de construcción públicos, anuncios de prensa económica local — esto sigue siendo la pieza más difícil de automatizar sin scraping. Se documenta acá la misma recomendación que F3b ya dejó: empezar con carga estructurada manual (alguien pega el dato de un proyecto anunciado) antes de intentar cualquier automatización de esto — **F4.5 no resuelve la detección automática de proyectos de expansión**, solo el descubrimiento de empresas existentes por categoría/ubicación. Detectar *proyectos* sigue siendo F3b, una propuesta aparte.

---

## 4. Enriquecimiento de empresas

Una vez que una `Company` existe (importada por F3 o descubierta por F4.5 §2), enriquecerla con datos que Apollo/Clearbit ya devuelven en la misma llamada de búsqueda o en una llamada de detalle: sitio web, tamaño estimado de empleados, tecnología usada (si es relevante para calificar), industria normalizada. Se persiste en los mismos campos que `Company` ya tiene (`website`, `estimatedSize`) — **no se propone ningún campo nuevo en `Company` para esto**, el enriquecimiento solo rellena columnas que hoy quedan `null` cuando el import manual no las trae.

---

## 5. Búsqueda y validación de contactos públicos

Apollo (y equivalentes) también devuelven contactos (nombre, cargo, a veces email) asociados a una empresa. Estos **no se crean automáticamente como `Contact`** — se muestran como sugerencias que un humano confirma antes de persistirlos (mismo principio de F2: "la IA nunca inventa un contacto"; acá el contacto no lo inventa la IA, lo trae un proveedor externo, pero la creación real en el CRM sigue requiriendo una confirmación humana explícita la primera vez que F4.5 se implemente — a revisar si más adelante se relaja a automático una vez que la calidad de la fuente esté probada).

---

## 6. Verificación de emails

Antes de que cualquier email se use para outreach real, se valida con un servicio de verificación (no basta con que el proveedor de datos lo haya devuelto — los emails de estas bases caducan seguido):

| Proveedor | Costo aproximado | Nota |
|---|---|---|
| **NeverBounce** | ~$0.008/verificación (paquetes por volumen) | Integración simple, API REST |
| **ZeroBounce** | ~$0.007–0.01/verificación | Similar, incluye score de "sendability" |

**Recomendación:** verificar un email exactamente una vez, en el momento en que se confirma un `Contact` con email (§5) — no en cada envío. El resultado (`valid`/`invalid`/`risky`/`unknown`) se persistiría en un campo nuevo del `Contact` (a definir en el plan detallado de esta fase — candidato: `Contact.emailVerificationStatus`), y **un email `invalid` bloquea que ese contacto sea destinatario de un envío real** (aunque el borrador ya se haya generado).

---

## 7. Integración con Google Workspace o Microsoft 365

**Decisión de diseño recomendada: enviar desde la cuenta de correo real de la agencia (Gmail API / Microsoft Graph API), no desde un ESP masivo (SendGrid/Postmark/SES).** Para el volumen y el tono de esta fase (outreach personalizado 1:1, no newsletters masivas), enviar "como" el vendedor humano — con su firma, desde su bandeja, con hilos de respuesta normales — es una mejor decisión de producto que un ESP transaccional, y evita construir infraestructura de reputación de dominio de envío masivo desde cero.

- **Google Workspace:** Gmail API (`gmail.send`, `gmail.readonly` scopes), OAuth2 con consentimiento explícito del usuario dueño de la cuenta que va a enviar. Cuota estándar: ~500 envíos/día para una cuenta normal de Workspace — un límite sano para el volumen de esta fase, no un obstáculo.
- **Microsoft 365:** Microsoft Graph API (`Mail.Send`, `Mail.Read`, `Calendars.ReadWrite` scopes), equivalente vía Azure AD app registration.
- **Cuál priorizar primero:** depende de qué usa la agencia hoy (a confirmar con el PO) — la arquitectura interna (una interfaz `MailProvider` genérica, análoga a `LLMProvider` de F2) soporta ambas sin acoplar el resto del sistema a una sola.

Esto es la integración de mayor superficie nueva de todo F4.5 — requiere una pantalla de conexión de cuenta (OAuth), almacenamiento seguro de tokens (refresh tokens cifrados, nunca en texto plano), y manejo de expiración/revocación.

---

## 8. Envío controlado de correo

El envío real **sigue pasando por `ApprovalRequest`** — F4.5 no relaja esa regla, la extiende: hoy "aprobar" solo marca el texto como listo para copiar a mano; en F4.5, aprobar un `ApprovalRequest` de tipo outreach dispara el envío real vía el `MailProvider` (§7), pero **solo si el humano aprobó explícitamente ese borrador específico** — nunca hay un modo de "aprobar todo" ni de auto-aprobación por reglas. Cada envío real queda registrado (mensaje enviado, `Message-ID`, timestamp) — nuevo, pequeño registro de auditoría de envío (a definir su forma exacta en el plan detallado: probablemente un campo en `ApprovalRequest` o una fila nueva mínima, no antes de este punto).

**Límite duro:** un tope diario de envíos reales por tenant (ver §13), independiente de cualquier otro límite — ningún volumen de aprobaciones acumuladas puede disparar más envíos que ese tope en un día.

---

## 9. Lectura de respuestas

Con `gmail.readonly`/`Mail.Read` ya conectado (§7), leer la bandeja de la cuenta conectada para detectar respuestas a hilos de outreach ya enviados (matcheo por `Message-ID`/`In-Reply-To`, no por texto libre). Esto **reemplaza** el mecanismo manual de F4 (§15 del plan base — "un humano pega la respuesta") por uno automático, pero el **Conversation Agent en sí no cambia**: sigue siendo `classifyConversation(replyText)`, solo que ahora `replyText` lo trae la lectura automática del correo en vez de un textarea. Esto confirma que F4 no se tira, se extiende.

**Alcance limitado a hilos propios:** solo se lee correo que sea respuesta a un hilo que el sistema mismo envió (por `Message-ID`) — nunca se procesa la bandeja de entrada completa de la cuenta conectada, evita tocar correo no relacionado (privacidad, alcance mínimo necesario).

---

## 10. Conversation Agent conectado a correo real

Job periódico (mismo mecanismo de scheduler in-process ya extendido en F4): cada N minutos, revisa hilos de outreach enviados sin respuesta clasificada todavía, busca respuestas nuevas vía §9, y si encuentra una, corre `classifyConversation` automáticamente — sin que un humano tenga que pegar nada. El resto del flujo (§16 del plan base F4: `suggestNextStep`, estados `HOT`/`COLD`/`RECOVERED`) no cambia.

---

## 11. Google Calendar o Microsoft Calendar

Cuando `classifyConversation` detecta `CALL_LATER`/`INTERESTED`/`VERY_INTERESTED` con una fecha/hora mencionada en la respuesta, ofrecer crear un evento de calendario (Google Calendar API / Microsoft Graph `Calendars.ReadWrite`) en vez de solo un `FollowUp` interno — **siempre como una propuesta que el humano confirma con un clic**, nunca agendando una reunión de forma autónoma en el calendario real de alguien sin esa confirmación explícita (mismo principio de aprobación aplicado a un nuevo tipo de acción externa).

---

## 12. SPF, DKIM, DMARC, suppression list, rebotes y opt-out

Requisitos técnicos de dominio, no de código de aplicación — deben resolverse en el proveedor de DNS de la agencia antes de enviar cualquier volumen real:

- **SPF**: registro TXT autorizando a Google/Microsoft a enviar en nombre del dominio (ya suele estar configurado si la agencia ya usa Workspace/365 para correo normal — se audita, no se asume).
- **DKIM**: firma criptográfica del dominio, se activa en el panel de administración de Workspace/365 (no requiere código propio).
- **DMARC**: política de qué hacer si SPF/DKIM fallan — se recomienda empezar en modo `p=none` (solo monitoreo) antes de pasar a `p=quarantine`/`p=reject`, para no arriesgar el correo legítimo de la agencia mientras se calienta el dominio.
- **Suppression list** (nueva, mínima): lista de emails que nunca deben recibir outreach — poblada por (a) cualquier opt-out explícito (§14), (b) rebotes duros (`bounce` permanente reportado por el `MailProvider`), (c) el mismo email verificado como `invalid` (§6). Se consulta antes de cualquier envío real, sin excepción.
- **Rebotes**: un rebote duro marca el `Contact`/email en la suppression list automáticamente; un rebote blando (buzón lleno, etc.) no.

---

## 13. Límites diarios y calentamiento del dominio

Enviar 500 correos el primer día desde una cuenta/dominio nuevo para outreach frío es la forma más rápida de terminar en spam permanentemente. Plan de calentamiento estándar de la industria, aplicado como un límite configurable (`Tenant.settings.dailyEmailSendLimit`, Json, mismo patrón que los demás límites de este proyecto):

| Semana | Envíos/día (tope) |
|---|---|
| 1 | 10–20 |
| 2 | 20–40 |
| 3 | 40–80 |
| 4+ | 80–150 (tope estable recomendado para una cuenta de agencia chica) |

El tope nunca lo decide la IA — es un valor de configuración que el humano ajusta, con un default conservador. El guardia se aplica igual que el de presupuesto: antes de cada envío real, se cuenta cuántos ya se enviaron hoy; si se llegó al tope, el resto queda aprobado pero pendiente de envío hasta el día siguiente (nunca se descarta, solo se demora).

---

## 14. Cumplimiento CAN-SPAM

Requisitos concretos que cualquier correo real enviado por el sistema debe cumplir (EE.UU. — la agencia opera en Illinois/Indiana/Iowa/Nebraska según los datos de seed):

1. **Identificación veraz del remitente** — nombre real de la agencia y del vendedor, sin encabezados falsificados (el envío vía Gmail/Graph API con la cuenta real ya lo garantiza estructuralmente).
2. **Asunto no engañoso** — el prompt de `personalizeMessage` (F4 §13) ya prohíbe prometer cosas falsas; se agrega una regla explícita de que el asunto debe describir honestamente el contenido.
3. **Dirección física válida** — el pie de cada correo debe incluir la dirección postal real de la agencia (dato de `Tenant`, a agregar si no existe todavía — revisar en el plan detallado).
4. **Mecanismo de opt-out claro** — un enlace o instrucción de "responder STOP/UNSUBSCRIBE" en cada correo; cualquier opt-out recibido debe honrarse **dentro de 10 días hábiles** (requisito legal) — en la práctica, el sistema lo aplica de inmediato al detectar la palabra clave en una respuesta leída (§9), no espera el plazo máximo.
5. **No usar direcciones de "solo remitente"** — la cuenta conectada debe poder recibir respuestas (ya es el caso al usar Gmail/Graph real, a diferencia de un ESP transaccional configurado para no-reply).
6. **Registro de opt-outs** — la suppression list (§12) es también el registro legal de quién pidió no ser contactado.

Ningún envío real se activa en el código antes de que estos 6 puntos estén implementados y verificados — se documentan acá como parte del Definition of Done de esta fase (§16), no como una nota aparte.

---

## 15. Costos, proveedores y alternativas gratuitas/de pago

Estimado mensual de referencia para una agencia chica (volumen: descubrir ~200 empresas/mes, verificar ~150 emails/mes, enviar dentro del tope de calentamiento):

| Partida | Proveedor recomendado | Costo aprox./mes | Alternativa gratuita |
|---|---|---|---|
| Descubrimiento de empresas + contactos | Apollo.io | $49–99 | Google Places API (~$10–20 al volumen de esta fase) + carga manual, cobertura menor |
| Verificación de email | NeverBounce | $10–15 (a ~$0.008 × 150) | Ninguna gratuita confiable — verificación mala es peor que no verificar (daña reputación de dominio) |
| Envío de correo | Gmail API / Graph API | $0 adicional (ya incluido en la licencia de Workspace/365 que la agencia ya paga) | — |
| Calendario | Google Calendar / Microsoft Graph | $0 adicional (mismo motivo) | — |
| **Total estimado** | | **~$60–115/mes** | |

Esto es independiente y adicional al presupuesto de OpenAI (`aiMonthlyBudgetUsd`, sigue siendo ~$50/mes) — son proveedores de datos/infraestructura de envío, no de IA. Se propone un presupuesto separado (`dataProviderBudgetUsd`, §2) para no mezclar ambos guardias.

---

## 16. Definition of Done (para cuando esta fase se apruebe e implemente)

- [ ] Al menos una fuente de descubrimiento externa conectada y funcionando end-to-end, con las empresas encontradas pasando por el mismo importador de F3 (nunca un camino de creación paralelo)
- [ ] Verificación de email integrada; un email `invalid` bloquea el envío real a ese contacto
- [ ] `MailProvider` (Gmail y/o Microsoft Graph) enviando un correo real solo tras una aprobación humana explícita de ese borrador puntual
- [ ] Lectura automática de respuestas limitada a hilos propios (por `Message-ID`), sin acceder al resto de la bandeja
- [ ] Conversation Agent clasificando respuestas reales leídas automáticamente, sin romper el flujo manual de F4 (ambos caminos siguen funcionando)
- [ ] SPF/DKIM/DMARC verificados en el dominio real antes de cualquier envío de volumen
- [ ] Suppression list funcionando: opt-out, rebote duro, o email inválido bloquean el envío sin excepción
- [ ] Límite diario de envíos con calentamiento progresivo, configurable, nunca decidido por la IA
- [ ] Los 6 requisitos de CAN-SPAM (§14) verificados en un correo real de prueba
- [ ] Presupuesto de proveedores de datos (`dataProviderBudgetUsd`) separado del presupuesto de OpenAI, con su propio guardia
- [ ] F0–F4 intactos; ningún test existente se modifica ni se rompe
- [ ] `pnpm typecheck`/`lint`/`test` limpios en todo el monorepo
- [ ] Aprobación explícita del PO, por escrito, de cada proveedor pago antes de contratarlo — no solo aprobación de este documento

---

**Este documento es de planificación anticipada. No se contrata ningún proveedor, no se conecta ninguna cuenta de correo, y no se escribe código de esta fase hasta que F4 esté completo, verificado, y este plan reciba su propia aprobación explícita — separada de la aprobación de F4.**

---

## Addendum — F4.5A External Discovery Pilot (implementación real)

**Estado:** implementado. Alcance deliberadamente más chico que este documento completo — piloto sin envío de correo, sin proveedores pagos, capado a Illinois / Manufacturing-Warehouse-Logistics-Construction / 50 empresas por misión.

**Desviación respecto a §1 de este documento:** §1 recomienda Apollo.io como fuente primaria (paga, ~$49-99/mes) y Google Places como secundaria (paga por uso). El piloto usa una fuente distinta y no contemplada arriba: **OpenStreetMap Overpass API** (`overpass-api.de/api/interpreter`) — gratuita, sin API key, sin cuenta de facturación, datos bajo licencia ODbL. Se eligió porque cumple mejor la prioridad #1 explícita del piloto ("fuente pública autorizada") que Apollo/Google Places (que son proveedores pagos, prioridad #2/#4), y evita el bloqueante de "necesito una API key paga" para poder demostrar el flujo end-to-end sin gasto ni aprobación de compra.

**Limitaciones conocidas de esta fuente** (documentadas para cuando se evalúe reemplazarla por Apollo, ya con aprobación del PO):
- OSM no tiene datos de contactos con nombre — el pipeline nunca crea `Contact` en este piloto porque nunca hay un dato literal de persona/cargo que citar (regla "nunca inventar" de la fase). Esto es esperado, no un bug.
- No hay señales de contratación (`hiringSignals` queda `NOT_FOUND` siempre) ni email público — OSM no modela eso.
- Cobertura depende de qué tan mapeado esté cada negocio en OSM — puede haber falsos negativos (empresa real que no aparece) pero nunca falsos positivos inventados.
- La instancia pública comparte cuota con el resto de internet — se observó flakiness ocasional (HTTP 406) en algunos patrones de query; el tool implementa reintento y degradación por patrón, nunca inventa un resultado si la fuente falla.

Apollo.io y Google Places siguen siendo la recomendación para una fase posterior con presupuesto aprobado — este piloto no descarta esa decisión, solo la pospone.

### Resultado de la verificación real (2026-07-10)

- **Mecanismo verificado correcto por test automatizado real** (`apps/api/src/modules/discovery/discovery.test.ts`, corrida real contra Overpass, sin mocks): en al menos una corrida durante el desarrollo, `discoverCompaniesTool` creó una `Company` real con `origin=EXTERNAL_DISCOVERY`, `verificationStatus=CONFIRMED`, `sourceUrl` real, `confidenceScore` calculado, cero `Contact` inventados, y cada campo del task output clasificado únicamente como `CONFIRMED`/`NOT_FOUND` (nunca un valor inventado). El suite completo (45/45 tests) queda verde de forma reproducible.
- **Verificación en navegador real (Playwright, sesión de este piloto):** se lanzaron 4 misiones reales vía `/missions` con instrucciones que piden explícitamente empresas "que no tengamos en el CRM" (Manufacturing, Warehouse/Logistics, Construction, IL). En las 4, el CEO Agent interpretó correctamente `useExternalDiscovery=true`, delegó `discover_companies`, y el pipeline **nunca creó** `create_opportunity`/`plan_sequence`/`personalize_message` — confirmado en Mission Detail y en la base de datos. En las 4, `discover_companies` terminó `DONE` (nunca `FAILED`) y generó un Executive Report real.
- **Limitación real encontrada durante esta ventana de verificación:** la instancia pública de Overpass devolvió `HTTP 406`/`429`/`504` en las 4 misiones en vivo y en ~10 llamadas directas adicionales de diagnóstico, mientras que llamadas `curl` intercaladas tuvieron éxito solo de forma intermitente (~30-50%) en la misma ventana — evidencia de que el servidor compartido estaba en un período de degradación real más sostenido que el observado más temprano en el desarrollo (cuando sí devolvió datos reales: "Nestle USA", "Boise Cascade", "Rochelle Logistics Center", confirmados por `curl` con dirección completa). No se pudo confirmar una creación de `Company` nueva en esta ventana específica de verificación en navegador — se reporta explícitamente en vez de forzarlo o inventar un resultado. El tool se comportó exactamente como debía: reintentó con backoff, degradó por patrón, y nunca fabricó un dato.
- **Conclusión honesta:** el pipeline completo (interpretación → discovery → dedup → scoring → creación con procedencia → Lead, sin outreach) está implementado y probado correctamente; el riesgo real de producción no es el código sino la disponibilidad de la fuente gratuita elegida bajo carga — exactamente el tipo de limitación que motiva la recomendación original de este documento (Apollo.io/Google Places, con presupuesto aprobado) para una fase de producción real. Próximo paso concreto sugerido: si se mantiene OSM, considerar un mirror privado o autoalojado de Overpass (sin costo de licencia, solo de infraestructura) para no depender de la instancia pública compartida.

---

## Addendum 2 — F4.5: Google Places como proveedor primario (2026-07-10)

**Estado:** implementado y verificado con datos reales. El piloto F4.5A quedó validado (addendum 1); a partir de acá el objetivo deja de ser "demostrar que el pipeline funciona" y pasa a ser "el CEO Agent descubre empresas reales de forma consistente" — la limitación de disponibilidad de Overpass documentada arriba motivó pasar a un proveedor comercial con SLA real, tal como este documento ya recomendaba en §1.

**Decisión:** Google Places API (New), Text Search — no Apollo.io. Aprobado explícitamente por el Product Owner (autorización de costo real, no solo de código). Overpass **pasa a ser respaldo gratuito** (fallback): el orquestador (`discovery-tools.impl.ts`) solo lo consulta si `GOOGLE_PLACES_API_KEY` no está configurada, si el presupuesto mensual del proveedor de datos ya se gastó, o si Google Places no encontró nada para esa industria.

**Arquitectura:**
- `apps/api/src/modules/agents/tools/discovery-providers/` — un archivo por proveedor (`google-places.ts`, `overpass.ts`), contrato común (`types.ts`: `ProviderCandidate`/`ProviderSearchResult`) para que el orquestador haga dedup/scoring/creación de `Company` una sola vez, sin importar de qué proveedor vino cada candidato.
- Mismo patrón de resiliencia que Overpass: timeout de 30s por request, máximo 3 reintentos con backoff, logs estructurados (`[discovery:google-places] provider requested/response`), señal de cancelación real (Cancelar aborta el fetch en vuelo).
- **Origen distinguido en el CRM:** empresa encontrada por Google Places → `Company.origin = API_PROVIDER`; por Overpass (respaldo) → `EXTERNAL_DISCOVERY`. La badge "API externa" (ya existía desde la fase de transparencia) distingue esto en toda la UI sin cambios adicionales.
- **Presupuesto separado** (`getDataProviderBudgetStatus`, `Tenant.settings.dataProviderBudgetUsd`, default $10/mes) — independiente del presupuesto de IA, tal como recomienda §2 de este documento. Se suma solo el `costUsd` de `AgentTask` con `type=discover_companies`, nunca se mezcla con gasto de LLM.
- Costo estimado: Text Search (New), tier Pro (incluye dirección/teléfono/sitio web) ≈ $0.032/request — **verificar contra el precio vigente en mapsplatform.google.com/pricing antes de escalar volumen**, es un estimado conservador tal como ya se documentaba en §15.

**Verificación real (2026-07-10):** misión de 5 empresas de manufactura en Illinois → **5/5 candidatos únicos convertidos en `Company` reales**, 0 duplicados, 0 insuficientes, confidence promedio 87%, costo real $0.032 (una sola request). Ejemplos reales: "Jessup Manufacturing Company" (McHenry, IL), "Dynamic Manufacturing, Inc." (Hillside, IL), "AJ Manufacturing Co" (Elmhurst, IL), "Principal Manufacturing Corporation" (Broadview, IL), "Chicago American Manufacturing" (Chicago, IL) — todas con `origin=API_PROVIDER`, `verificationStatus=CONFIRMED`, teléfono real, 4/5 con sitio web real, ninguna con email (Google Places no lo provee — `NOT_FOUND` honesto, no inventado). Ninguna existía antes de la misión (confirmado contra snapshot previo de la tabla `Company`) ni aparece en `seed.ts`.

**Bug real encontrado y corregido durante esta verificación:** `addressComponent()` asumía que todo `addressComponent` de la respuesta de Google trae `types` — un componente real de la API a veces no lo trae, causando un `TypeError` no manejado que tiraba la tarea a `FAILED`. Corregido con acceso opcional (`c.types?.includes(...)`); reproducido y verificado con una llamada real antes y después del fix.

**Apollo.io** sigue documentado en §1 como alternativa (mejor cobertura de contactos de personas) para una fase posterior, si se decide sumar descubrimiento de contactos con nombre — no se descarta, se pospone igual que Google Places quedó pospuesto en el addendum 1.
