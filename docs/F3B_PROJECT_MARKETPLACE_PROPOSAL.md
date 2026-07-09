# F3b — Marketplace de Proyectos — Propuesta

**Estado:** Propuesta documentada, NO aprobada, NO en el alcance de F3. No se ha escrito ni se escribirá código de esto durante F3.
**Origen:** surgió como "una mejora estratégica" durante la aprobación de F3 (docs/F3_PROSPECTING_ENGINE_PLAN.md §17). El PO decidió mantenerlo fuera de F3 para no bloquear la entrega del motor de prospección de empresas, y documentarlo por separado con el mismo nivel de detalle una vez que F3 cierre.

---

## 1. Idea central

Hoy el sistema prospecta **empresas**. La propuesta es que también prospecte **proyectos**: eventos concretos que implican una necesidad de staffing futura — una expansión de planta, un nuevo data center, una nueva fábrica, un contrato de construcción grande — antes de que la empresa responsable siquiera sea un lead activo. Cuando el sistema detecta un proyecto:

1. Crea el proyecto (como oportunidad de mercado, no como proyecto operativo — ver §3).
2. Lo asocia a la empresa responsable (creándola si no existe todavía).
3. Estima cuántos trabajadores podría requerir.
4. Estima ingresos potenciales.
5. Lo prioriza según el valor esperado (trabajadores × duración × tarifa estimada, o una fórmula similar).

El resultado sería un "marketplace" interno: una lista priorizada de oportunidades de proyecto, no solo de empresas, para que Sales sepa dónde enfocar el esfuerzo humano de cierre.

---

## 2. Por qué no entra en F3 tal cual

**El problema de la fuente de datos.** F3 prospecta empresas a partir de carga estructurada (CSV/Excel) — datos que un humano ya tiene. Un proyecto como "nuevo data center en Iowa" es información pública que hoy nadie tiene cargada en ningún sistema interno; conocerla en el momento en que se anuncia requeriría **scraping de noticias/permisos de construcción o una API de terceros** (ej. agregadores de noticias de construcción, permisos públicos de condado/estado) — exactamente lo que este proyecto excluye explícitamente desde F2 ("no scraping agresivo, no APIs pagas sin aprobación").

Esto no significa que la idea sea inviable — significa que, igual que con las empresas en F3, el punto de entrada realista en una primera versión es **carga estructurada manual**: alguien en Sales pega o sube la información del proyecto (nombre, ubicación, empresa asociada si se conoce, tamaño estimado, fuente de la noticia) y el sistema la analiza y prioriza desde ahí — no que el sistema "descubra" el proyecto solo. Una integración real con fuentes de noticias/permisos quedaría como una fase posterior, sujeta a la misma regla de aprobación explícita de nuevas fuentes de datos que ya rige desde F2.

**El problema del modelo de datos.** El modelo `Project` que ya existe en el schema (desde F0) es para proyectos **operativos**: tiene `companyId` obligatorio (la empresa ya tiene que existir y ser cliente), no tiene campos de estimación (`estimatedWorkers`, `estimatedRevenue`) ni de prioridad, y está pensado para colgar `JobOrder`/`Assignment` una vez que el trabajo ya se está ejecutando. Reusarlo para "proyecto detectado, todavía sin cliente confirmado" mezclaría dos conceptos distintos con reglas de negocio distintas. Hace falta un modelo nuevo.

---

## 3. Modelo de datos propuesto (boceto, sujeto a revisión en el plan final)

```prisma
model ProjectOpportunity {
  id                 String   @id @default(cuid())
  tenantId           String
  name               String
  companyId          String?  // null si la empresa responsable todavía no existe en el CRM
  company            Company? @relation(fields: [companyId], references: [id])
  location           Json?    // { city, state }
  description        String?
  source             String?  // de dónde vino el dato (carga manual, nombre del archivo, etc.)
  estimatedWorkers    Int?
  estimatedRevenue    Decimal? @db.Decimal(12, 2)
  priorityScore       Float?   // determinista, mismo patrón D8 que Company.commercialScore
  priorityRationale   String?
  status              ProjectOpportunityStatus @default(NEW)
  createdByAgentTaskId String?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@index([tenantId, status])
}

enum ProjectOpportunityStatus {
  NEW
  QUALIFIED
  CONTACTED
  CONVERTED
  DISCARDED
}
```

Nota: nombre de trabajo `ProjectOpportunity` para no chocar con el `Project` operativo existente — el nombre final se decide en el plan detallado.

---

## 4. Cómo reutilizaría lo que F2/F3 ya dejan construido

- **Mismo patrón híbrido determinista+LLM (D8)** para estimar trabajadores/ingresos: un cálculo base con reglas explícitas (tamaño típico de proyecto por categoría, benchmarks internos si existen) y el LLM solo interpretando/explicando dentro de un rango — nunca inventando el número final. Mismo mecanismo que `scoreCompany`.
- **Mismo Prospecting Agent**, con un tool nuevo (`processProjectOpportunity` o similar) siguiendo la misma estructura de `processCompanyPipeline`.
- **Misma `ApprovalRequest`** si en algún momento el flujo de un proyecto genera un borrador de contacto.
- **Mismo Dashboard Comercial IA** (F3 §12) como lugar natural para mostrar los proyectos priorizados — probablemente una pestaña o sección nueva, no un dashboard aparte.
- **Mismo guardia de presupuesto y misma auditoría** (`AgentTask`/`AuditLog`) — sin mecanismo nuevo de costos.

---

## 5. Siguiente paso real

Este documento es una propuesta de alcance, no un plan de implementación. Antes de escribir cualquier código de esto hace falta:

1. Aprobación explícita del PO de que la fuente de datos (carga manual, sin scraping ni APIs nuevas) es aceptable para una primera versión.
2. Un plan técnico completo (`docs/F3B_PROJECT_MARKETPLACE_PLAN.md` o similar) con el mismo nivel de detalle que `F2_AI_SALES_AGENT_PLAN.md`/`F3_PROSPECTING_ENGINE_PLAN.md`: schema final, rutas, cambios de frontend, riesgos, Definition of Done — siguiendo el mismo protocolo de aprobación antes de tocar código.

No se implementa nada de esto durante F3.
