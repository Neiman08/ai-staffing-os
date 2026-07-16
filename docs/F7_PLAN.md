# F7 — Auditoría post-F6 + reconstrucción de alternativas (SIN código, SIN plan aprobado)

**Naturaleza de este documento: auditoría de solo lectura + reconstrucción de opciones.** No se escribió ninguna línea de código de F7, no se tocó `schema.prisma`, no se creó ningún endpoint ni UI, no se llamó a ningún proveedor externo. Se generó porque, al cerrar F6 (ver `docs/F6_AUTONOMOUS_RECRUITING_AND_OPERATIONS_PLAN.md` §32), la instrucción de gobierno de esta sesión exige buscar un plan de F7 explícitamente aprobado antes de escribir código; no existe ninguno, así que este documento es el entregable final de esa búsqueda — nunca una invención de alcance a partir de un roadmap viejo que ya se demostró, repetidamente, no predictivo de lo que realmente se construyó.

---

## 1. Resultado de la búsqueda: no existe un plan de F7 aprobado

Evidencia directa, no inferida:

- `docs/ROADMAP.md` línea 19 tiene **una sola fila de tabla** para F7 ("SaaS multi-tenant — Onboarding self-service, billing de plataforma, SOC 2 readiness, observabilidad"), sin ningún detalle técnico, sin decisiones del PO, sin DoD.
- `docs/MASTER_PROJECT_STATUS.md` (2026-07-13) — el documento de auditoría más reciente antes de F5/F6 — dice **explícitamente**, en su propia §"Roadmap desactualizado": *"`docs/ROADMAP.md` está completamente desactualizado... Cualquiera que lea solo ese archivo hoy se forma un modelo mental incorrecto del proyecto."* El propio repositorio ya advierte contra usar esa tabla como fuente de verdad.
- `docs/DECISION_LOG.md` (31 líneas) no tiene ninguna entrada sobre F7, multi-tenancy, SOC 2, ni billing de plataforma.
- No existe ningún archivo `docs/F7_*.md` previo a este.
- Cada fase real del proyecto (F1 Revenue Engine, F2 AI Sales Agent, F3 Prospecting, F4 Autonomous Outreach, F4.5–F4.9 Discovery/Email/Auth, F5 Staffing Operations, F6 Autonomous Recruiting) **abandonó el nombre y el contenido que el roadmap original le había asignado** — documentado exhaustivamente en `MASTER_PROJECT_STATUS.md` §1.2. Asumir que "F7 original" (multi-tenant SaaS) sigue siendo correcto solo porque nadie lo reemplazó todavía sería repetir exactamente el error que ese mismo documento señala.

**Conclusión: no hay alcance de F7 aprobado. Este documento reconstruye alternativas reales para que el PO decida, no asume ninguna.**

---

## 2. Estado real post-F6 (lo que existe hoy, sin adornos)

### 2.1 Completo y operativo

- **Motor comercial completo** (F1–F4): CRM (Companies/Contacts/Leads/Opportunities/FollowUps), 9 agentes de IA reales con `AgentRuntime`/`CostTracker`/`ApprovalGate`, Prospecting Engine con scheduler in-process, Autonomous Outreach con secuencias y Daily Revenue Mission (CEO Agent).
- **Descubrimiento y enriquecimiento** (F4.5/F4.6): Google Places + OpenStreetMap, People Data Labs (Contact Intelligence).
- **Sitio público** (F4.8/F4.8A): 11 páginas, 3 formularios reales al CRM, rediseño visual premium.
- **Autenticación de producción construida** (F4.9): `ClerkAuthProvider`, webhooks, MFA, invitaciones — **completo pero inactivo** (`AUTH_MODE=dev-bypass`), pausado por decisión explícita del PO.
- **Núcleo operativo de staffing completo** (F5.1–F5.8, ejecutado después del `MASTER_PROJECT_STATUS.md` de referencia — esa auditoría está desactualizada en este punto): CRUD real de Candidates/Workers/JobOrders/Assignments, verificación real de Compliance (documentos, alertas), aprobación real de horas (TimeEntry) + PayrollRun (creación→aprobación→export), Billing/Invoices + Payment real (modelo agregado en F5.8), Pricing Scenarios de solo lectura.
- **Matching por IA + dashboards por rol + deuda RBAC cerrada** (F6.1–F6.9, este mismo trabajo): Recruiter Agent graduado con capa LLM acotada, scoring determinista v1, integración en JobOrderDetail, Dashboard con métricas condicionadas por permiso real, matriz RBAC 403 completa.

### 2.2 Dangling — construido pero deliberadamente inactivo o bloqueado (no es "trabajo de F7", es deuda pausada que un PO podría decidir retomar)

- **F4.9-12:** verificación real contra una cuenta Clerk real — diferida indefinidamente por decisión del PO (uso interno, ≤5 personas). Código intacto, sin activar.
- **Despliegue real a Render:** `render.yaml`/scripts listos, nunca ejecutado. Bloqueado por una decisión pendiente sobre `NODE_ENV` conviviendo con el guard que prohíbe `AUTH_MODE=dev-bypass` en producción, y por que el PO nunca conectó su cuenta real de Render.
- **F4.7 (Gmail/envío real):** diseño completo, bloqueado por 3 decisiones de negocio del PO (cuenta de Google Cloud/OAuth, dirección postal comercial real, subdominio de envío con SPF/DKIM/DMARC) — nunca de ingeniería.
- **F4.8B:** pulido visual del sitio público, pausado a mitad de camino (búsqueda de foto de hero correcta). Sin cambios sin commitear.
- **F3b (Project Marketplace):** propuesta documentada, nunca aprobada ni planificada en detalle.
- **F6 — límites conocidos** (ver `F6_AUTONOMOUS_RECRUITING_AND_OPERATIONS_PLAN.md` §32.13): el modo "Determinista + revisión IA" del matching nunca se ejerció contra OpenAI real; el factor "Idiomas" del scoring usa una señal genérica por falta de un campo real de idioma requerido en `JobOrder`; el corte de 365 días de "Recencia de datos" es una interpretación propia, no un valor dado por el plan.
- **Roadmap original nunca retomado:** tax engine externo/Stripe (era "F5 original"), Marketing Agent real + Indeed/LinkedIn + Twilio SMS (era "F6 original") — ambos explícitamente fuera de alcance de los F5/F6 reales que sí se construyeron, y ninguno tiene un plan aprobado hoy.

### 2.3 Lo que el producto todavía no puede hacer, de punta a punta, con datos reales

- Cobrarle a un cliente y que el pago llegue (falta un procesador de pagos real — Stripe u otro — sobre el modelo `Payment` ya existente).
- Pagarle a un worker con un tax engine real (Check/Gusto u otro) — `PayrollRun` hoy calcula y exporta, no integra con nómina externa.
- Publicar una vacante en un job board externo o mandar un SMS real (Indeed/LinkedIn/Twilio) — cero integración hoy.
- Servir a más de un tenant real de forma self-service (hoy: 1 tenant, `tenant-titan`, provisto manualmente vía seed).
- Enviar un email real de outreach (bloqueado en F4.7 por decisiones de negocio, no técnicas).
- Iniciar sesión con una cuenta Clerk real fuera de dev-bypass.

---

## 3. Alternativas reconstruidas para "F7" (ninguna aprobada — para que el PO elija)

Cada una reutiliza una fracción distinta de lo ya construido y tiene un perfil de riesgo/bloqueo distinto. No son mutuamente excluyentes — el PO puede elegir una, combinar varias, o rechazar todas y proponer algo no listado acá.

### Alternativa A — Cerrar la deuda de producción diferida (Clerk real + despliegue Render real)
**Qué es:** ejecutar F4.9-12 (verificación real contra Clerk) y el despliegue real a Render, ambos ya diseñados y casi listos.
**Por qué podría ser lo siguiente:** es la brecha más chica entre "construido" y "verificado en producción real" — cero diseño nuevo, solo ejecución y verificación.
**Riesgo/bloqueo:** requiere que el PO cree/conecte una cuenta Clerk real y una cuenta Render real, y decida la política de `NODE_ENV`/`AUTH_MODE` en producción. Es una decisión de negocio (¿vale la pena la fricción de auth real para un equipo de ≤5 personas?), no de ingeniería — la misma razón por la que se pausó en F4.9.
**Costo externo:** posible costo de hosting en Render (plan pago si se necesita uptime real); Clerk tiene tier gratuito para el volumen actual.

### Alternativa B — Terminar F4.7 (Gmail/envío real de outreach)
**Qué es:** activar el envío real de emails de outreach, ya diseñado en detalle (`GmailConnection`/`EmailMessage`/`MailProvider`).
**Por qué podría ser lo siguiente:** el motor de prospección genera borradores reales hoy pero nunca los envía — es el eslabón que falta para que el "SDR autónomo" (F4) sea de punta a punta.
**Riesgo/bloqueo:** 3 decisiones de negocio explícitas y ya documentadas (cuenta de Google Cloud/OAuth Client, dirección postal comercial real para cumplimiento CAN-SPAM, subdominio de envío con SPF/DKIM/DMARC configurado). Ninguna es una decisión de ingeniería.
**Costo externo:** Google Workspace (si no existe ya), posible costo de un proveedor de envío transaccional si Gmail directo no escala.

### Alternativa C — Monetización real: pagos (Stripe) sobre `Invoice`/`Payment`
**Qué es:** integrar un procesador de pagos real (Stripe u otro) para que un `Invoice` generado en F5.8 pueda cobrarse de verdad, cerrando el loop "coloco un worker → factura al cliente → cobro".
**Por qué podría ser lo siguiente:** es la pieza que el propio `MASTER_PROJECT_STATUS.md` señaló como "el valor demostrable central del producto" — hoy el 100% del ciclo de staffing es real excepto el cobro.
**Riesgo/bloqueo:** requiere una cuenta real de Stripe (o equivalente) del PO, decisión de modelo de cobro (¿tarjeta, ACH, ambos?), y probablemente una decisión sobre si el tax engine (Check/Gusto, "F5 original") se aborda en el mismo esfuerzo o se difiere otra vez. Nueva cuenta externa + posible presupuesto de procesamiento (fees de Stripe).
**Nota:** el modelo `Payment` ya existe (F5.8) — este trabajo es "conectarlo a un proveedor real", no diseñarlo desde cero.

### Alternativa D — Canales externos reales (Marketing Agent + job boards + SMS) — "F6 original"
**Qué es:** lo que el roadmap original llamaba F6 y que el F6 real explícitamente excluyó: Marketing Agent con tools reales, publicación en Indeed/LinkedIn, Twilio SMS con opt-in TCPA.
**Por qué podría ser lo siguiente:** expande el alcance de adquisición de talento más allá del CRM/matching interno construido en F6.
**Riesgo/bloqueo:** el de mayor fricción externa de todas las alternativas — requiere cuentas/API keys de Indeed, LinkedIn, Twilio, presupuesto de publicación/SMS, y cumplimiento legal real (TCPA para SMS). Es, con diferencia, la alternativa con más decisiones de negocio nuevas y mayor superficie de riesgo regulatorio.

### Alternativa E — Multi-tenant SaaS real — "F7 original"
**Qué es:** lo que el roadmap original llamaba F7: onboarding self-service, billing de plataforma (cobrarle a otras agencias por usar el producto), SOC 2 readiness, observabilidad.
**Por qué podría ser lo siguiente:** es el único camino hacia "vender esto a otras agencias" en vez de operarlo solo para `tenant-titan`.
**Riesgo/bloqueo:** el de mayor ambigüedad de negocio — presupone una decisión estratégica (¿el objetivo es un producto SaaS vendible a terceros, o una herramienta interna para una sola agencia?) que **no está confirmada en ningún documento actual**. SOC 2 readiness en particular implica auditoría externa real, políticas de seguridad formales, y meses de trabajo no solo de ingeniería. Es la alternativa menos "lista para empezar mañana" de todas — necesitaría su propio documento de descubrimiento antes de siquiera plantear subfases.

### Alternativa F — Profundizar el propio F6 (matching/dashboards) sin salir del perímetro ya construido
**Qué es:** extender lo que F6 ya dejó funcionando — ej. activar `Notification`/`DomainEvent` (hoy dormidos, ver F6 §11), un flujo de sugerencia de Assignment basado en el ranking de matching (con aprobación humana explícita, nunca automática), más tools reales para el Recruiter Agent, o cerrar los límites conocidos de F6 (probar el modo LLM contra OpenAI real con guardas, definir un campo real de idioma requerido en JobOrder si el PO decide que vale la pena el cambio de schema).
**Por qué podría ser lo siguiente:** cero cuentas/credenciales/presupuesto externo nuevo — reutiliza 100% de la infraestructura de agentes/matching ya construida y verificada.
**Riesgo/bloqueo:** el de menor riesgo de todas las alternativas, pero también el de menor "salto" de producto — no resuelve ninguna de las brechas de negocio de fondo (cobro real, canales externos, multi-tenancy).

---

## 4. Decisiones que el PO necesita tomar antes de que exista un F7 real

1. **¿Cuál alternativa (o combinación) es la prioridad?** — A/B/C/D/E/F de la sección 3, o algo no listado.
2. Si se elige **A**: ¿se conecta una cuenta Clerk/Render real ahora? ¿Cuál es la política de `NODE_ENV` en producción con dev-bypass activo hoy?
3. Si se elige **B**: ¿cuenta de Google Cloud/Workspace? ¿dirección postal comercial real? ¿subdominio de envío?
4. Si se elige **C**: ¿Stripe u otro procesador? ¿se aborda el tax engine externo (Check/Gusto) en el mismo esfuerzo o se difiere?
5. Si se elige **D**: ¿qué canales primero (Indeed vs. LinkedIn vs. SMS)? ¿presupuesto de publicación/SMS? ¿revisión legal de TCPA antes de escribir una sola línea de SMS?
6. Si se elige **E**: ¿el objetivo real es vender el producto a otras agencias, o seguir operándolo solo para esta agencia? Esta pregunta por sí sola determina si E tiene sentido en absoluto.
7. Si se elige **F**: ¿cuál extensión específica del perímetro de F6 tiene más valor — Notifications, sugerencia de Assignment, más tools del Recruiter Agent, o cerrar un límite conocido puntual?

**Ninguna subfase de F7 debería empezar sin que el PO responda la pregunta 1 (y las preguntas condicionales de la alternativa elegida) explícitamente — el mismo estándar que F5 y F6 exigieron antes de arrancar.**

---

## 5. Plantilla de subfases y DoD (genérica — a instanciar recién cuando el PO elija una alternativa)

Una vez elegida una dirección, el siguiente paso **no es escribir código** — es redactar un documento de plan dedicado (`docs/F7_<NOMBRE>_PLAN.md`), siguiendo exactamente el mismo formato que ya demostró funcionar en F5/F6:

1. Auditoría técnica de solo lectura del área elegida (schema real, servicios reales, gaps reales) — sin código.
2. Decisiones explícitas del PO documentadas una por una (mismo patrón que F6 §27's "17 decisiones").
3. Cambios de schema necesarios, si existen, presentados como evidencia antes de tocar `schema.prisma`.
4. Diseño de contratos compartidos (`packages/shared`), servicios, endpoints, UI — en ese orden, cada uno con su propio "DoD" (definition of done) verificable.
5. Plan de tests explícito por subfase (nunca "correrá bien", siempre "estos casos, estos roles, esta cobertura").
6. Reglas de guardas para llamadas externas reales (presupuesto, límite de llamadas, fallback) si la alternativa elegida involucra un proveedor externo (B, C, D).
7. Subfases numeradas (F7.1, F7.2, ...) con dependencias explícitas, igual que F6 §9/§30.
8. Cierre formal con verificación completa + doc de cierre, igual que este mismo documento cierra F6.

Ningún elemento de esta plantilla se llena todavía — depende enteramente de qué alternativa elija el PO.

---

## 6. Estado de este documento y próximo paso

**No se escribió código de F7. No se tocó schema, ni endpoints, ni UI, ni se llamó a ningún proveedor externo.** Este documento cumple exactamente lo que la instrucción de gobierno de esta sesión pedía para este escenario: *"si no existe un plan aprobado, solo producir una auditoría del estado post-F6, una reconstrucción de qué debería ser F7, y este documento — luego detenerse."*

**Próximo paso: el PO debe elegir una alternativa de la sección 3 (o proponer una nueva) y responder las decisiones de la sección 4.** Recién ahí correspondería escribir un plan técnico dedicado para esa alternativa específica, con el mismo nivel de detalle y aprobación explícita que tuvieron `F5_STAFFING_OPERATIONS_PLAN.md` y `F6_AUTONOMOUS_RECRUITING_AND_OPERATIONS_PLAN.md`.
