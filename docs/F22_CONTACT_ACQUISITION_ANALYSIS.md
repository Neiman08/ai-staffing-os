# F22 — Análisis técnico: por qué la mayoría de las Companies terminan solo con teléfono

**Fecha:** 2026-07-22. **Alcance:** solo análisis y propuesta priorizada — cero cambios de código en este documento, tal como se pidió. Datos reales extraídos de producción (`ai-staffing-os-db`, 112 Companies al momento del análisis) más lectura directa del código del pipeline de enriquecimiento.

---

## 1. Distribución real hoy (n=112 Companies, producción)

Calculada aplicando la misma prioridad de `resolveBestContactChannel` (contact-channel.ts, F21) sobre los datos reales ya persistidos:

| Canal resultante | Companies | % |
|---|---|---|
| Solo teléfono (`PHONE_ONLY`) | 67 | **59.8%** |
| Email organizacional verificado (`VERIFIED_ORG_EMAIL`) | 25 | 22.3% |
| Sin ningún canal (`NONE`) | 8 | 7.1% |
| Email organizacional sin verificar (`WEBSITE_ORG_EMAIL`) | 7 | 6.3% |
| LinkedIn de un contacto real | 5 | 4.5% |
| Email personal verificado (`VERIFIED_PERSON_EMAIL`) | 0 | **0.0%** |

**Hallazgo #1 (estructural, no de datos):** el Tier 1 de la propia estrategia de prioridad — contacto personal con email *verificado* — es hoy **inalcanzable en la práctica**. `contact-enrichment.ts` calcula `emailDomainTrust` (email-trust.ts, heurística de "¿el dominio del email coincide con el sitio de la empresa?") pero **nunca lo escribe** en `Contact.emailVerificationStatus` al crear el registro — ese campo queda siempre en su default `NOT_VERIFIED`, por diseño explícito (el comentario en el código aclara que esa heurística de dominio nunca debe confundirse con una verificación real de entregabilidad). Resultado: aunque SÍ se encuentre una persona real con email real, nunca puede llegar a Tier 1 tal como está construido hoy. Esto es una brecha real, no un problema de proveedores.

**Señales crudas** (denominador = 112 Companies):

| Señal | Companies | % |
|---|---|---|
| Tiene `website` | 94 | 83.9% |
| Tiene `phone` | 98 | 87.5% |
| Tiene ≥1 `CompanyContactPoint` (email organizacional) | 32 | 28.6% |
| — de esos, verificado | 25 | 78% de los 32 |
| Tiene `Company.email` directo | 25 | 22.3% |
| Tiene ≥1 `Contact` (persona real) | 11 | 9.8% |
| — de esos, con email | 11 | 100% de los 11 |
| — de esos, email VERIFIED | 0 | 0% |
| Tiene ≥1 `Contact` con LinkedIn | 5 | 4.5% |
| Formulario de contacto detectado (`hasContactForm`) | 0 medido | ver Hallazgo #2 |
| Careers page detectada | 0 medido | ver Hallazgo #2 |

**Hallazgo #2 (medición, no dato real):** "0% con formulario de contacto" y "0% con careers page" **no significa que ningún sitio tenga uno** — significa que, hasta la Fase 2 de F21 (esta misma sesión), el crawler ya calculaba `hasContactForm`/`contactFormUrl` pero el dato se descartaba antes de persistirse (nunca llegaba a `Company`). Recién ahora queda capturado en `discoveryMetadata.contactChannel`, y todavía ninguna Company fue re-descubierta desde ese cambio. Es decir: probablemente ya tenemos esta señal disponible en varias de las 94 Companies con website, simplemente todavía no la medimos. Esto es en sí mismo el hallazgo más barato de resolver (ver §5, prioridad 0).

---

## 2. Dónde exactamente se pierde la mayoría

Trazando el pipeline real (`mission-executor.ts` → `company-enrichment.ts` → `contact-enrichment.ts`) contra los números de arriba:

```
Descubrimiento (Google Places)          112 Companies
        │
        ▼
¿Tiene website?                          94  (83.9%)   ← pérdida 1: 16.1% nunca llega a tener un sitio
        │                                                 real (franquicias/cadenas sin sitio propio en
        │                                                 Google Places, o el campo vino vacío)
        ▼
Website Intelligence (crawler.ts)
  home + hasta 5 páginas ENLAZADAS
  desde la home, MAX_PAGES=6, sin
  sitemap.xml, sin adivinar rutas,
  sin ejecutar JS
        │
        ▼
¿Se extrajo algún email organizacional?  32  (34% de los 94 con sitio)   ← PÉRDIDA MÁS GRANDE
                                                                            66% de los sitios SÍ crawleables
                                                                            no dejan nada usable
        │
        ▼
Contact Intelligence (cascada PDL →
  Website named people → Hunter)
        │
        ▼
¿Se identificó una persona real?         11  (9.8% del total)   ← segunda pérdida más grande
```

**El paso donde se pierde la mayoría de las empresas es el crawl del sitio web (`website-intelligence/crawler.ts`), no la falta de proveedores externos.** De las 94 Companies con un sitio real y crawleable, solo 32 (34%) terminan con algún email — es decir, dos de cada tres sitios reales no aportan nada, aunque el crawl en sí haya funcionado. Las causas concretas, verificadas en el código:

1. **Descubrimiento de páginas por enlace, no por ruta conocida.** `findTargetLinks` solo sigue links presentes en el HTML crudo de la home. Si "Contact"/"About"/"Careers" está en un menú hamburguesa renderizado por JS, o el sitio usa una URL no obvia (`/get-in-touch` en vez de `/contact`), esa página nunca se visita — nunca se intenta `/contact-us`, `/about-us`, `/team` ni se lee `sitemap.xml`.
2. **Sin ejecución de JavaScript.** `fetchPage` hace un `fetch()` plano (Accept: text/html). Sitios armados en Wix/Squarespace/React/Webflow que renderizan el contenido de contacto client-side devuelven HTML casi vacío al crawler, aunque un humano sí vea la información en el navegador.
3. **Tope de 6 páginas.** Razonable en costo, pero en sitios grandes (cadenas hoteleras, franquicias) puede agotarse antes de llegar a la página relevante.
4. **`hasContactForm` calculado pero nunca aprovechado como canal** hasta esta sesión (Hallazgo #2) — un formulario real no contaba como nada.

**Además, los dos proveedores pagos de la cascada de personas están efectivamente caídos hoy** (observado en vivo, de forma consistente, durante toda esta sesión — en producción y en dev, en decenas de llamadas reales distintas):
- **People Data Labs**: 402 (`payment_required` — créditos de la cuenta agotados) en el 100% de los intentos observados.
- **Hunter.io**: 429 (rate limit) en la mayoría de los intentos observados.

Esto deja **únicamente "Website Intelligence → namedPeople"** como fuente funcional de contactos personales — y esa fuente depende 100% del mismo crawl limitado del punto anterior. Es la razón directa de que solo el 9.8% de las Companies tengan una persona real identificada.

---

## 3. Fuentes adicionales — ventajas, límites, costo aproximado

Evalúo cada una contra la brecha específica que resuelve. Precios de mercado a **julio 2026, verificar antes de contratar** — dos de los cuatro pricing pages pedidos por el nombre no devolvieron números al fetch en vivo (contenido renderizado por JS del lado del proveedor), así que marco explícitamente cuáles confirmé en vivo vs. cuáles son estimaciones basadas en conocimiento general del mercado.

| Proveedor | Resuelve | Ventajas | Límites | Costo aprox. |
|---|---|---|---|---|
| **Hunter.io (ya integrado, plan superior)** | Emails organizacionales + patrón de email por dominio | Ya está en el código (`hunter.ts`), solo requiere subir de plan/créditos. Domain Search + Email Verifier en el mismo proveedor. | El plan actual está rate-limited (429 constante) — el problema puede ser simplemente de plan/cuota, no del proveedor en sí. | Growth: ~US$49–149/mes según volumen (no confirmado en vivo esta sesión). |
| **Dropcontact** | Verificación de email + enriquecimiento GDPR-compliant (relevante si se opera con datos de contactos EU) | Verificación real de entregabilidad (no heurística de dominio) — resolvería directamente el Hallazgo #1. API simple, "nunca guarda datos sin verificar". | Foco en Europa; menor cobertura de personas en EE.UU. que Apollo/RocketReach. | **Confirmado en vivo:** Starter €79/mes (500 créditos), Growth €120/mes (500 créditos + más features), Enterprise desde 200k créditos/mes (a medida). |
| **Apollo.io** | Personas + emails + teléfonos directos, base de datos muy grande (foco EE.UU./B2B SaaS) | Cobertura muy amplia, incluye teléfonos móviles verificados en planes altos, API + UI. | Pricing page no devolvió números en el fetch en vivo (contenido dinámico) — verificar manualmente. De memoria de mercado: plan pago desde ~US$49–99/usuario/mes con créditos limitados de "mobile"/"export". | ~US$49–99/mes por asiento (no confirmado en vivo, verificar). |
| **RocketReach** | Personas + emails + teléfonos + LinkedIn | Buena cobertura de LinkedIn/redes, API decente. | Misma limitación de fetch en vivo — de mercado, planes desde ~US$53–100+/mes según volumen de lookups. | ~US$53–100+/mes (no confirmado en vivo, verificar). |
| **Prospeo** | Verificación + finder de emails, precio agresivo | Suele ser más barato por crédito que Hunter/Apollo, buena tasa de verificación reportada. | Menor marca/cobertura que los anteriores, catch-all detection variable. | No confirmado en vivo (fetch sin datos) — de mercado, planes desde ~US$39–49/mes. |
| **NeverBounce / ZeroBounce (verificación pura)** | **Resuelve directamente el Hallazgo #1** (Tier 1 estructuralmente vacío) | Verificación real de entregabilidad vía SMTP-check, no heurística. Se integraría como UN paso nuevo (verificar el email ya encontrado por PDL/Website/Hunter), no como fuente nueva de descubrimiento — footprint de integración chico. | No descubre contactos nuevos, solo verifica los que ya se encontraron — no ataca la pérdida más grande (§2, el crawl). | Verificación por lote, típicamente US$0.004–0.008 por email (~US$8/1000) — más barato que cualquier "finder". |
| **Clearbit (ahora parte de HubSpot) / Clay** | Enriquecimiento + orquestación multi-proveedor (Clay permite encadenar Apollo+Hunter+PDL+verificación en un solo flujo con fallback automático) | Clay en particular resolvería la "cascada con fallback" de forma más robusta que mantenerla a mano — aunque el pipeline actual (contact-enrichment.ts) ya implementa ese patrón de cascada. | Costo más alto, capa de orquestación adicional sobre proveedores que probablemente ya se pagarían por separado. | Clay: desde ~US$149/mes (créditos limitados); Clearbit/HubSpot: variable, más caro. |
| **Cognism** | Datos verificados por teléfono (foco EMEA/UK, compliance fuerte) | Alta tasa de verificación telefónica real. | Precio enterprise, contratos anuales, poco relevante si el foco es EE.UU. (Illinois, este caso). | Solo por cotización — no publica precio público. |

**Recomendación de esta sección:** antes de sumar un proveedor NUEVO de *descubrimiento* de personas (Apollo/RocketReach/Prospeo), lo más rentable en relación costo/impacto es (a) resolver por qué PDL/Hunter están degradados HOY (puede ser solo cuota/plan, costo marginal vs. contratar algo nuevo) y (b) agregar un verificador barato (Dropcontact o NeverBounce) para destrabar el Tier 1 que hoy está en 0% de forma estructural.

---

## 4. Mejoras posibles usando solo el sitio web oficial (antes de sumar proveedores)

Esto ataca directamente la pérdida más grande identificada en §2 (66% de sitios crawleables no dejan nada), a costo marginal cero (ningún proveedor nuevo, mismo `crawler.ts`):

1. **Aprovechar `hasContactForm`/`contactFormUrl` ya capturado (F21 Fase 2)** — hoy se calcula y se descarta para las Companies existentes; ya está persistido para descubrimientos nuevos. Es la mejora de menor esfuerzo posible (cero código nuevo, solo tiempo — se auto-completa con cada misión nueva).
2. **Leer `sitemap.xml`** antes de depender solo de los links de la home — la mayoría de los sitios lo tienen, y ahí suelen listarse `/contact`, `/about`, `/careers` aunque no estén en el menú principal visible.
3. **Fallback a rutas conocidas** cuando `findTargetLinks` no encuentra nada: intentar directamente `/contact`, `/contact-us`, `/about`, `/about-us`, `/team`, `/careers`, `/jobs` antes de rendirse — sigue siendo "solo datos literales del sitio", nunca se inventa nada, solo se prueba con más rutas típicas.
4. **Extraer datos estructurados (JSON-LD `schema.org/Organization`, `ContactPoint`, `Person`)** — muchos sitios los incluyen para SEO, son 100% máquina-legibles, evitan parsing de HTML frágil, y suelen tener exactamente teléfono/email/rol de contacto ya estructurado.
5. **Considerar un fetch con renderizado JS (headless, ej. Playwright) como fallback** cuando la home devuelve HTML casi vacío — solo para el subconjunto de sitios donde el fetch plano claramente no encontró nada, para no encarecer el costo/tiempo del caso común. Este es el cambio de mayor esfuerzo de los cinco, pero el que más atacaría el problema real de sitios modernos (Wix/Squarespace/React).
6. **Subir `MAX_PAGES`** de 6 a un número mayor solo cuando el sitio parece grande (ej. tiene sitemap con +50 URLs) — no un cambio global de costo, sino condicional.

Estas seis mejoras, combinadas, atacan exactamente el cuello de botella real medido en §2 — y no dependen de contratar nada nuevo.

---

## 5. Estrategia priorizada recomendada

Ordenada por impacto esperado ÷ esfuerzo, manteniendo siempre el principio de "nunca inventar información":

| # | Acción | Ataca | Esfuerzo | Costo |
|---|---|---|---|---|
| **0** | Nada que hacer — dejar que `contactFormUrl`/`hasContactForm` (ya en producción desde F21) se auto-complete con cada misión nueva | Hallazgo #2 (medición) | Cero | Cero |
| **1** | Agregar fallback a rutas conocidas (`/contact-us`, `/about`, `/team`, `/careers`) + lectura de `sitemap.xml` en `crawler.ts` | Pérdida más grande (§2: 66% de sitios crawleables sin nada) | Bajo-medio | Cero (mismo crawler) |
| **2** | Extraer JSON-LD `schema.org` en `extract.ts` | Misma pérdida, complementaria al #1 | Bajo | Cero |
| **3** | Diagnosticar y resolver PDL (402, créditos agotados) y Hunter (429, rate limit) — probablemente un tema de plan/cuota, no de integración | Segunda pérdida más grande (§2: cascada de personas caída) | Bajo (administrativo, no código) | Ya se está pagando — verificar plan actual |
| **4** | Sumar un verificador de email barato (Dropcontact o NeverBounce) como paso posterior a cualquier email ya encontrado | Hallazgo #1 (Tier 1 estructuralmente en 0%) | Bajo-medio | ~US$8–20/1000 verificaciones |
| **5** | Evaluar headless rendering (Playwright) como fallback solo quando el fetch plano no encuentra nada | Sitios modernos JS-only, cola larga de la pérdida del crawl | Medio-alto | Cero de licencia, sí de cómputo/tiempo |
| **6** | Recién acá, si 1–5 no alcanzan el volumen necesario: sumar un proveedor de descubrimiento de personas nuevo (Apollo o Prospeo por costo, RocketReach por cobertura de LinkedIn) | Cobertura restante | Medio | Ver §3 |

**Por qué este orden:** las acciones 0–2 y 4 no requieren ningún proveedor nuevo ni gasto adicional, atacan directamente los dos puntos de pérdida más grandes medidos con datos reales (§2), y son coherentes con "nunca inventar información" (todo sigue siendo evidencia literal del propio sitio o una verificación real de lo ya encontrado). La acción 3 es prácticamente gratis (probablemente un tema de plan, no de código) y podría por sí sola destrabar el 90% de companies que hoy no llegan a tener una persona real identificada. Sumar un proveedor nuevo (acción 6) recién tiene sentido después de agotar las mejoras de costo marginal cero — de lo contrario se estaría pagando por resolver un problema que hoy es principalmente de crawl y de proveedores ya contratados pero degradados.

---

## Resumen ejecutivo

- **59.8%** de las Companies terminan hoy solo con teléfono.
- La pérdida más grande no es "faltan proveedores" — es que **2 de cada 3 sitios web reales y crawleables no dejan nada usable** con el crawler actual (sin sitemap, sin rutas de respaldo, sin JS).
- El **Tier 1 de la propia estrategia de prioridad (email personal verificado) está en 0% de forma estructural**, no por falta de datos: nunca se verifica un email ya encontrado.
- **PDL y Hunter están efectivamente caídos ahora mismo** (402 y 429 consistentes, observado en vivo toda la sesión) — posiblemente un tema de plan/cuota, no de integración.
- La estrategia de mayor retorno es mejorar el crawl propio y verificar lo ya encontrado (costo ~cero) **antes** de sumar un proveedor de pago nuevo.
