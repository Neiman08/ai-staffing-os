import type { BusinessTaxonomyEntry } from "./contracts";

// F7.1: Business Taxonomy -- unica fuente de verdad para clasificar
// lenguaje natural de negocio. Nunca se dispersa en ifs sueltos ni en
// diccionarios paralelos (regla explicita del PO) -- el interprete
// (intent-interpreter.ts) SOLO lee de este arreglo, nunca tiene su
// propio vocabulario embebido.
//
// crmIndustryBucket es null quando ninguna Industry real del CRM (hoy:
// Construction, Warehouse/Logistics, Manufacturing, General Labor,
// Hospitality -- ver docs/F7_CEO_INTELLIGENCE_AND_AUTONOMOUS_CLIENT_
// ACQUISITION_PLAN.md §1.7 y la auditoría de descubrimiento real del
// 2026-07-19, F13) es un match razonable. Crear una Industry real nueva
// para el resto (Healthcare, Retail, etc.) sigue fuera de alcance --
// null sigue siendo la interpretacion conservadora ahí, nunca una
// industria inventada.
export const BUSINESS_TAXONOMY: BusinessTaxonomyEntry[] = [
  {
    key: "hospitality",
    label: "Hospitality (Hotels & Resorts)",
    // F14 (refinamiento de calidad, 2026-07-19): grupo semántico
    // ampliado a pedido explícito del PO -- Hotel/Resort/Inn/Lodge/
    // Suites/Motel/Bed & Breakfast/Boutique Hotel deben activar la
    // MISMA entrada real, nunca quedar repartidos en matches parciales.
    synonyms: [
      "hotel",
      "hoteles",
      "resort",
      "resorts",
      "lodging",
      "lodge",
      "hospitality",
      "hospitalidad",
      "motel",
      "motels",
      "inn",
      "suites",
      "bed and breakfast",
      "bed & breakfast",
      "boutique hotel",
    ],
    // F7.4 Parte A: "suites"/"hospitality property" agregados -- evidencia
    // de aceptacion explicita pedida por el PO para validar un candidato
    // real de hospitality (ver docs/F7.../PLAN.md §"Hoteles").
    companyTypes: [
      "hotel",
      "resort",
      "lodging property",
      "lodge",
      "motel",
      "inn",
      "suites",
      "hospitality property",
      "bed and breakfast",
      "boutique hotel",
    ],
    // F13 (auditoría PO, 2026-07-19): antes null -- "Crear una Industry
    // real nueva... es una decision de F5/F6 territory, fuera de
    // alcance de F7.1" (ver nota de arriba). El PO ya autorizó
    // explícitamente esta Industry en la auditoría de descubrimiento
    // real (Fase 4: "Asegura soporte mínimo para Hospitality/Hotels") --
    // seedIndustries() en packages/db/prisma/seed.ts la crea como
    // Industry real (isGlobal, mismo patrón que las otras 4).
    crmIndustryBucket: "Hospitality",
    // F14: orden específico-primero, mismo criterio que electrical.
    googleSearchPhrases: [
      "hotel",
      "resort",
      "boutique hotel",
      "bed and breakfast",
      "lodging property",
      "inn",
      "motel",
      "hospitality group",
    ],
    websitePhrases: ["rooms", "reservations", "check-in", "housekeeping", "hospitality"],
    jobTitles: [
      "Housekeeper",
      "Room Attendant",
      "Housekeeping",
      "Laundry Attendant",
      "Cleaning Staff",
      "Front Desk Agent",
    ],
    decisionMakers: ["General Manager", "Executive Housekeeper", "Housekeeping Manager", "HR Manager", "Recruiter"],
    // F7.4 Parte A: "cleaning"/"property management"/"restaurant" agregados
    // -- rechazos explicitos pedidos por el PO (cleaning contractors,
    // property management sin evidencia de hotel, restaurantes).
    negativeKeywords: ["staffing agency", "recruiting agency", "travel agency", "cleaning", "property management", "restaurant"],
    relatedIndustries: ["janitorial", "commercial_cleaning"],
    validations: [
      "El sitio menciona reservas/habitaciones/check-in",
      "El nombre incluye Hotel/Resort/Inn/Motel o equivalente",
    ],
    isGenericFallback: false,
    version: 2,
  },
  {
    key: "manufacturing",
    label: "Manufacturing (General)",
    synonyms: [
      "manufacturing",
      "manufactura",
      "manufacturera",
      "manufacturero",
      "fabrica",
      "fabricas",
      // F14 (validación real, 2026-07-19): "fabricante(s)" (manufacturer/s)
      // faltaba -- hallazgo real de una misión real ("Busca 10 fabricantes
      // reales en Illinois") que devolvía 0 search queries (matchedTaxonomyKeys
      // vacío) porque containsWord exige coincidencia de palabra completa
      // -- "fabrica" nunca matchea dentro de "fabricantes" (son palabras
      // distintas, no un plural regular de la misma).
      "fabricante",
      "fabricantes",
      "planta industrial",
      "plantas industriales",
      "industrial plant",
      "factory",
    ],
    // F7.4 Parte A: "manufacturing"/"manufacturer"/"production"/
    // "fabrication"/"processing"/"assembly"/"plant" agregados -- evidencia
    // de aceptacion explicita pedida por el PO (ver docs/F7.../PLAN.md
    // §"Manufacturing"). "manufacturing" standalone es deliberado: el
    // caso real reportado por el PO ("General Manufacturing, LLC") usa
    // la palabra sola, sin "company" ni "-er" -- el patrón más común en
    // nombres reales de empresa, no cubierto por "manufacturing company"
    // ni "manufacturer" por separado.
    companyTypes: ["manufacturing company", "factory", "industrial plant", "manufacturing", "manufacturer", "production", "fabrication", "processing", "assembly", "plant"],
    crmIndustryBucket: "Manufacturing",
    googleSearchPhrases: ["manufacturing company", "factory", "industrial manufacturer"],
    websitePhrases: ["production line", "manufacturing facility", "plant", "quality control"],
    jobTitles: ["Production Worker", "Machine Operator", "Maintenance Technician", "Quality Control Inspector"],
    decisionMakers: ["Plant Manager", "Operations Manager", "Production Manager", "HR Manager", "Recruiter"],
    // F7.4 Parte A: "consulting" agregado -- rechazo explicito pedido por
    // el PO ("Rechazar: consulting; staffing; pure logistics; ...").
    negativeKeywords: ["staffing agency", "logistics only", "pure distribution", "consulting"],
    relatedIndustries: ["food_manufacturing", "beverage_manufacturing", "packaging", "industrial_automation"],
    validations: ["El sitio muestra evidencia real de producción/planta", "No es una oficina corporativa sin planta"],
    isGenericFallback: true,
    version: 1,
  },
  {
    key: "food_manufacturing",
    label: "Food Manufacturing",
    synonyms: [
      "food manufacturing",
      "food processing",
      "food processor",
      "fabricantes de alimentos",
      "fabricas de alimentos",
      "empresas manufactureras de alimentos",
      "bakery manufacturer",
      "dairy processing",
      "meat processing",
    ],
    // F7.4 Parte A: "food processing"/"beverage production"/"packaging
    // food"/"plant"/"factory" agregados -- evidencia de aceptacion
    // explicita pedida por el PO (ver docs/F7.../PLAN.md §"Food Manufacturing").
    companyTypes: ["food manufacturer", "food processing plant", "bakery manufacturer", "dairy processor", "food processing", "beverage production", "packaging food", "plant", "factory"],
    crmIndustryBucket: "Manufacturing",
    googleSearchPhrases: ["food manufacturing company", "food processing plant", "food production facility"],
    websitePhrases: ["food safety", "FDA", "HACCP", "food production"],
    jobTitles: ["Production Worker", "Machine Operator", "Food Safety Technician", "Sanitation Worker"],
    decisionMakers: ["Plant Manager", "Production Manager", "Operations Manager", "HR Manager"],
    negativeKeywords: ["restaurant", "grocery store", "distributor only"],
    relatedIndustries: ["manufacturing", "beverage_manufacturing", "packaging"],
    validations: ["El sitio menciona producción/procesamiento de alimentos, no solo venta"],
    isGenericFallback: false,
    version: 1,
  },
  {
    key: "beverage_manufacturing",
    label: "Beverage Manufacturing",
    synonyms: [
      "beverage manufacturing",
      "beverage plant",
      "fabricas de bebidas",
      "fabricante de bebidas",
      "bottling plant",
      "brewery",
      "cervecera",
    ],
    companyTypes: ["beverage manufacturer", "bottling plant", "brewery", "beverage plant"],
    crmIndustryBucket: "Manufacturing",
    googleSearchPhrases: ["beverage manufacturing company", "bottling plant", "brewery"],
    websitePhrases: ["bottling", "brewing", "beverage production"],
    jobTitles: ["Production Worker", "Machine Operator", "Bottling Line Operator"],
    decisionMakers: ["Plant Manager", "Production Manager", "Operations Manager", "HR Manager"],
    negativeKeywords: ["bar", "restaurant", "liquor store"],
    relatedIndustries: ["food_manufacturing", "manufacturing", "packaging"],
    validations: ["El sitio muestra evidencia de producción/embotellado, no solo venta al público"],
    isGenericFallback: false,
    version: 1,
  },
  {
    key: "packaging",
    label: "Packaging",
    synonyms: ["packaging", "empaques", "empaquetado", "packaging company", "packaging manufacturer"],
    companyTypes: ["packaging manufacturer", "packaging company"],
    crmIndustryBucket: "Manufacturing",
    googleSearchPhrases: ["packaging manufacturing company", "packaging plant"],
    websitePhrases: ["packaging solutions", "corrugated", "co-packing"],
    jobTitles: ["Production Worker", "Machine Operator", "Packaging Line Worker"],
    decisionMakers: ["Plant Manager", "Operations Manager", "Production Manager", "HR Manager"],
    negativeKeywords: ["shipping only", "retail packaging store"],
    relatedIndustries: ["manufacturing", "food_manufacturing", "beverage_manufacturing"],
    validations: ["El sitio muestra evidencia de fabricación de empaques, no solo distribución"],
    isGenericFallback: false,
    version: 1,
  },
  {
    key: "warehousing",
    label: "Warehousing",
    synonyms: ["warehouse", "warehouses", "warehousing", "almacen", "almacenes", "bodega"],
    // F7.4 Parte A: "distribution center"/"logistics facility"/"shipping
    // and receiving" agregados -- evidencia de aceptacion explicita
    // pedida por el PO (ver docs/F7.../PLAN.md §"Warehousing").
    companyTypes: ["warehouse", "warehousing company", "fulfillment center", "distribution center", "logistics facility", "shipping and receiving"],
    crmIndustryBucket: "Warehouse/Logistics",
    googleSearchPhrases: ["warehouse company", "warehousing and fulfillment", "distribution warehouse"],
    websitePhrases: ["warehouse", "fulfillment", "storage facility", "distribution center", "shipping", "receiving"],
    jobTitles: ["Forklift Operator", "Warehouse Associate", "Material Handler", "Order Picker"],
    decisionMakers: ["Warehouse Manager", "Operations Manager", "HR Manager", "Recruiter"],
    negativeKeywords: ["retail store", "office only"],
    relatedIndustries: ["distribution", "transportation", "manufacturing"],
    validations: ["El sitio muestra evidencia de operación de almacén/fulfillment"],
    isGenericFallback: true,
    version: 1,
  },
  {
    key: "distribution",
    label: "Distribution & Logistics",
    synonyms: ["distribution", "distribucion", "logistics", "logistica", "distribution center"],
    companyTypes: ["distribution company", "logistics company", "distribution center"],
    crmIndustryBucket: "Warehouse/Logistics",
    googleSearchPhrases: ["distribution company", "logistics company", "distribution center"],
    websitePhrases: ["distribution center", "supply chain", "logistics"],
    jobTitles: ["Forklift Operator", "Warehouse Associate", "Material Handler", "Delivery Driver"],
    decisionMakers: ["Operations Manager", "Warehouse Manager", "HR Manager", "Recruiter"],
    negativeKeywords: ["pure manufacturing only"],
    relatedIndustries: ["warehousing", "transportation"],
    validations: ["El sitio muestra evidencia de operación de distribución/logística"],
    isGenericFallback: true,
    version: 1,
  },
  {
    key: "healthcare",
    label: "Healthcare Facilities",
    synonyms: ["hospital", "hospitales", "healthcare", "clinic", "clinica", "medical center", "nursing home"],
    companyTypes: ["hospital", "clinic", "medical center", "nursing home", "healthcare facility"],
    crmIndustryBucket: null,
    googleSearchPhrases: ["hospital", "medical center", "healthcare facility", "nursing home"],
    websitePhrases: ["patient care", "medical center", "emergency room"],
    jobTitles: [
      "Environmental Services",
      "Environmental Services Technician",
      "Housekeeping",
      "Custodian",
      "personal de limpieza",
    ],
    decisionMakers: ["Environmental Services Director", "Facilities Manager", "HR Manager", "Recruiter"],
    negativeKeywords: ["staffing agency", "insurance company"],
    relatedIndustries: ["janitorial", "commercial_cleaning"],
    validations: ["El sitio muestra evidencia real de atención médica/paciente"],
    isGenericFallback: true,
    version: 1,
  },
  {
    key: "janitorial",
    label: "Janitorial Services",
    synonyms: ["janitorial", "janitorial services", "servicios de limpieza", "limpieza comercial"],
    // F7.4 Parte A: "janitorial"/"custodial services"/"facility services"
    // agregados -- evidencia de aceptacion explicita pedida por el PO
    // (ver docs/F7.../PLAN.md §"Janitorial / Commercial Cleaning").
    // "janitorial" standalone (sin "services company") cubre el patrón
    // más común de nombre real, ej. "Bright Star Janitorial Services".
    companyTypes: ["janitorial services company", "cleaning services company", "janitorial", "custodial services", "facility services"],
    crmIndustryBucket: null,
    googleSearchPhrases: ["janitorial services company", "commercial cleaning company"],
    websitePhrases: ["janitorial", "commercial cleaning", "facility maintenance"],
    jobTitles: ["Janitor", "Custodian", "Cleaning Technician"],
    decisionMakers: ["Owner", "President", "Operations Manager", "Branch Manager", "HR Manager", "Recruiter"],
    negativeKeywords: ["staffing agency", "residential cleaning only"],
    relatedIndustries: ["commercial_cleaning", "hospitality", "healthcare"],
    validations: ["El sitio ofrece servicios de limpieza comercial reales, no es un cliente de limpieza"],
    isGenericFallback: false,
    version: 1,
  },
  {
    key: "commercial_cleaning",
    label: "Commercial Cleaning",
    synonyms: ["commercial cleaning", "limpieza comercial", "cleaning company", "facility services"],
    // F7.4 Parte A: "custodial services" agregado -- evidencia de
    // aceptacion explicita pedida por el PO.
    companyTypes: ["commercial cleaning company", "facility services company", "custodial services"],
    crmIndustryBucket: null,
    googleSearchPhrases: ["commercial cleaning company", "facility services company"],
    websitePhrases: ["commercial cleaning", "facility services", "office cleaning"],
    jobTitles: ["Janitor", "Custodian", "Cleaning Technician"],
    decisionMakers: ["Owner", "President", "Operations Manager", "Branch Manager", "HR Manager"],
    negativeKeywords: ["staffing agency", "residential cleaning only"],
    relatedIndustries: ["janitorial"],
    validations: ["El sitio ofrece servicios de limpieza comercial reales"],
    isGenericFallback: false,
    version: 1,
  },
  {
    key: "construction",
    label: "Construction (General)",
    synonyms: ["construction", "construccion", "contractor", "contratista", "builder"],
    companyTypes: ["construction company", "general contractor", "builder"],
    crmIndustryBucket: "Construction",
    googleSearchPhrases: ["construction company", "general contractor"],
    websitePhrases: ["construction services", "general contractor", "projects completed"],
    jobTitles: ["Laborer", "Carpenter", "Project Manager"],
    decisionMakers: ["Owner", "President", "Project Manager", "Operations Manager", "HR Manager"],
    negativeKeywords: ["staffing agency", "real estate agency"],
    relatedIndustries: ["roofing", "electrical", "industrial_automation"],
    validations: ["El sitio muestra proyectos reales de construcción"],
    isGenericFallback: true,
    version: 1,
  },
  {
    key: "roofing",
    label: "Roofing Contractors",
    synonyms: ["roofing", "roofers", "roofing contractor", "techos", "techado"],
    companyTypes: ["roofing contractor", "roofing company"],
    crmIndustryBucket: "Construction",
    googleSearchPhrases: ["roofing contractor", "roofing company"],
    websitePhrases: ["roofing services", "roof repair", "roof installation"],
    jobTitles: ["Roofer", "Laborer", "Installer"],
    decisionMakers: ["Owner", "President", "Operations Manager", "Project Manager", "HR Manager"],
    negativeKeywords: ["staffing agency", "real estate agency"],
    relatedIndustries: ["construction"],
    validations: ["El sitio ofrece servicios de techado reales"],
    isGenericFallback: false,
    version: 1,
  },
  {
    key: "electrical",
    label: "Electrical Contractors",
    // F13 (auditoría PO, 2026-07-19): hallazgo real durante la
    // validación -- "contratistas electricos" (adjetivo, la forma real
    // que usó el PO) NUNCA matcheaba porque solo estaba la forma
    // sustantivo ("electricistas") -- el intérprete caía a la industria
    // genérica más cercana ("Construction") y buscaba "construction
    // company" en vez de contratistas eléctricos reales.
    // F14 (refinamiento de calidad, 2026-07-19): vocabulario ampliado a
    // pedido explícito del PO -- especializaciones reales del rubro
    // (industrial/comercial/power systems/substation/alto y bajo
    // voltaje/data center) para que el descubrimiento externo las
    // reconozca como UNA sola industria, nunca fragmentadas.
    synonyms: [
      "electrical contractor",
      "electrical contractors",
      "electricians",
      "electricistas",
      "electrical company",
      "electrical services",
      "electrical construction",
      "electrico",
      "electricos",
      "contratista electrico",
      "contratistas electricos",
      "industrial electrical",
      "commercial electrical",
      "power systems contractor",
      "substation contractor",
      "high voltage contractor",
      "low voltage contractor",
      "data center electrical",
    ],
    companyTypes: [
      "electrical contractor",
      "industrial electrical contractor",
      "commercial electrical contractor",
      "electrical services company",
      "electrical construction company",
      "power systems contractor",
      "substation contractor",
      "high voltage contractor",
      "low voltage contractor",
      "data center electrical contractor",
      // F16: "electrician" es el slug real que devuelve Google Places
      // `place.types` para este rubro -- palabra distinta a "electrical
      // contractor" (sin raíz común detectable por containsWord), así
      // que sin esta entrada la evidencia real de Google nunca podía
      // matchear pese a ser la categorización oficial del negocio.
      "electrician",
    ],
    crmIndustryBucket: "Construction",
    // F14: orden específico-primero, pedido explícito del PO -- nunca
    // debe correr una query genérica de "construction"/"industrial
    // contractor" antes de agotar TODAS estas variantes reales de
    // eléctrico. Ver buildSearchQueries en mission-planner.ts (ordena
    // entradas no genéricas antes que genéricas) + el cupo por query en
    // mission-executor.ts (ninguna query, ni siquiera la primera de
    // esta lista, puede consumir sola todo el volumen pedido).
    googleSearchPhrases: [
      "electrical contractor",
      "industrial electrical contractor",
      "commercial electrical contractor",
      "electrical services company",
      "electrician company",
      "electrical construction company",
      "power systems contractor",
      "substation contractor",
      "high voltage contractor",
      "low voltage contractor",
      "data center electrical contractor",
    ],
    websitePhrases: ["electrical services", "licensed electrician", "electrical contractor", "industrial electrical", "commercial electrical", "power systems", "substation", "high voltage", "low voltage"],
    jobTitles: [
      "Electrician",
      "Electricista",
      "Apprentice Electrician",
      "Journeyman Electrician",
      "Master Electrician",
      "Industrial Electrician",
      "Commercial Electrician",
    ],
    decisionMakers: ["Owner", "President", "Operations Manager", "Project Manager", "HR Manager"],
    negativeKeywords: ["staffing agency", "electronics retail store"],
    relatedIndustries: ["construction", "industrial_automation", "data_centers"],
    validations: ["El sitio ofrece servicios eléctricos contratados reales"],
    isGenericFallback: false,
    version: 2,
  },
  {
    key: "industrial_automation",
    label: "Industrial Automation",
    synonyms: [
      "industrial automation",
      "automatizacion industrial",
      "controls contractor",
      "automation integrator",
    ],
    companyTypes: ["industrial automation company", "controls contractor", "automation integrator"],
    crmIndustryBucket: "Construction",
    googleSearchPhrases: ["industrial automation company", "controls contractor", "automation integrator"],
    websitePhrases: ["industrial automation", "controls integration", "PLC programming"],
    jobTitles: ["Controls Technician", "Maintenance Technician", "Automation Technician"],
    decisionMakers: ["Owner", "President", "Operations Manager", "Project Manager", "HR Manager"],
    negativeKeywords: ["staffing agency", "software company only"],
    relatedIndustries: ["manufacturing", "electrical", "data_centers"],
    validations: ["El sitio ofrece integración/automatización industrial real"],
    isGenericFallback: false,
    version: 1,
  },
  {
    key: "data_centers",
    label: "Data Centers",
    synonyms: ["data center", "data centers", "colocation", "hyperscale", "critical facilities"],
    companyTypes: ["data center operator", "colocation facility", "critical facilities contractor"],
    crmIndustryBucket: "Construction",
    googleSearchPhrases: ["data center construction", "colocation facility", "hyperscale data center construction"],
    websitePhrases: ["data center", "colocation", "uptime", "critical facilities"],
    jobTitles: ["Electrician", "Electricista", "Data Center Technician", "Maintenance Technician"],
    decisionMakers: ["Facilities Manager", "Operations Manager", "Project Manager", "HR Manager"],
    negativeKeywords: ["staffing agency", "software/cloud company only (no physical facility)"],
    relatedIndustries: ["mission_critical", "electrical", "industrial_automation"],
    validations: ["El sitio muestra evidencia de una instalación física real de data center"],
    isGenericFallback: false,
    version: 1,
  },
  {
    key: "mission_critical",
    label: "Mission Critical Facilities",
    synonyms: ["mission critical", "mission critical contractor", "mission critical facilities"],
    companyTypes: ["mission critical contractor", "critical facilities company"],
    crmIndustryBucket: "Construction",
    googleSearchPhrases: ["mission critical construction", "mission critical contractor", "critical facilities contractor"],
    websitePhrases: ["mission critical", "critical facilities", "uptime"],
    jobTitles: ["Electrician", "Maintenance Technician", "Facilities Technician"],
    decisionMakers: ["Facilities Manager", "Operations Manager", "Project Manager", "HR Manager"],
    negativeKeywords: ["staffing agency"],
    relatedIndustries: ["data_centers", "electrical", "industrial_automation"],
    validations: ["El sitio muestra evidencia real de instalaciones críticas/mission critical"],
    isGenericFallback: false,
    version: 1,
  },
  {
    key: "landscaping",
    label: "Landscaping",
    synonyms: ["landscaping", "landscaping company", "jardineria", "paisajismo", "lawn care"],
    companyTypes: ["landscaping company", "lawn care company"],
    crmIndustryBucket: null,
    googleSearchPhrases: ["landscaping company", "lawn care company"],
    websitePhrases: ["landscaping services", "lawn care", "grounds maintenance"],
    jobTitles: ["Groundskeeper", "Landscape Laborer", "Crew Leader"],
    decisionMakers: ["Owner", "President", "Operations Manager", "Branch Manager", "HR Manager"],
    negativeKeywords: ["staffing agency", "garden retail store"],
    relatedIndustries: ["construction"],
    validations: ["El sitio ofrece servicios de paisajismo/jardinería reales"],
    isGenericFallback: false,
    version: 1,
  },
  {
    key: "restaurants",
    label: "Restaurants",
    synonyms: ["restaurant", "restaurantes", "restaurant group", "dining", "food service establishment"],
    companyTypes: ["restaurant", "restaurant group", "dining establishment"],
    crmIndustryBucket: null,
    googleSearchPhrases: ["restaurant", "restaurant group"],
    websitePhrases: ["menu", "reservations", "dining"],
    jobTitles: ["Dishwasher", "Line Cook", "Server", "Host"],
    decisionMakers: ["General Manager", "Owner", "HR Manager", "Recruiter"],
    negativeKeywords: ["staffing agency", "food manufacturer", "grocery store"],
    relatedIndustries: ["food_manufacturing"],
    validations: ["El sitio muestra un menú/servicio de comida real al público"],
    isGenericFallback: false,
    version: 1,
  },
  {
    key: "retail",
    label: "Retail",
    synonyms: ["retail", "retail store", "tienda", "comercio minorista", "retailer"],
    companyTypes: ["retail store", "retailer", "retail chain"],
    crmIndustryBucket: null,
    googleSearchPhrases: ["retail store", "retail chain"],
    websitePhrases: ["store locations", "shop", "retail"],
    jobTitles: ["Sales Associate", "Cashier", "Store Manager"],
    decisionMakers: ["Store Manager", "District Manager", "HR Manager", "Recruiter"],
    negativeKeywords: ["staffing agency", "wholesale distributor only"],
    relatedIndustries: ["distribution"],
    validations: ["El sitio muestra tiendas/ubicaciones de venta al público reales"],
    isGenericFallback: true,
    version: 1,
  },
  {
    key: "transportation",
    label: "Transportation & Trucking",
    synonyms: ["transportation", "transporte", "trucking", "trucking company", "freight carrier"],
    companyTypes: ["trucking company", "freight carrier", "transportation company"],
    crmIndustryBucket: "Warehouse/Logistics",
    googleSearchPhrases: ["trucking company", "freight carrier", "transportation company"],
    websitePhrases: ["fleet", "freight", "trucking services"],
    jobTitles: ["Truck Driver", "CDL Driver", "Dispatcher", "Warehouse Associate"],
    decisionMakers: ["Operations Manager", "Fleet Manager", "HR Manager", "Recruiter"],
    negativeKeywords: ["staffing agency", "car dealership"],
    relatedIndustries: ["warehousing", "distribution"],
    validations: ["El sitio muestra evidencia real de flota/operación de transporte"],
    isGenericFallback: true,
    version: 1,
  },
];

export function getTaxonomyEntry(key: string): BusinessTaxonomyEntry | undefined {
  return BUSINESS_TAXONOMY.find((entry) => entry.key === key);
}
