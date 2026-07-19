import { normalizeText } from "./text-normalize";

// F7.1: gazetteer minimo, deliberadamente NO exhaustivo -- el proyecto
// nunca geocodifica (mismo principio que matching/scoring.ts de F6:
// "Ubicacion 15/8/0 same-city/same-state/different, sin geocodificacion").
// Ciudades listadas: las que ya aparecen en los 8 Daily Revenue Missions
// reales auditados en F7.0 (docs/F7_CEO_INTELLIGENCE_AND_AUTONOMOUS_
// CLIENT_ACQUISITION_PLAN.md §2) mas las capitales de los mismos 8
// estados que discovery-tools.impl.ts ya sabe buscar (US_STATE_NAMES) --
// nunca una lista inventada, siempre trazable a datos reales u otro
// codigo ya existente. Extender esta lista es un cambio de datos, no de
// arquitectura -- no requiere tocar el interprete.

// Mismos 8 estados que apps/api/src/modules/agents/tools/discovery-
// tools.impl.ts (US_STATE_NAMES) -- duplicado a proposito (ver nota en
// docs/F7.../PLAN.md §7 sobre "capa pura, sin importar codigo de
// apps/api/modules/agents/" sobre esta misma decision): este modulo es
// puro y no debe depender de discovery-tools.impl.ts, que si depende de
// Prisma/env. Si algún día divergen, es evidencia real de que hay que
// unificarlos en una sola fuente compartida -- no se anticipa acá.
export const SUPPORTED_STATE_CODES: Record<string, string> = {
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  NE: "Nebraska",
  WI: "Wisconsin",
  MI: "Michigan",
  OH: "Ohio",
  MO: "Missouri",
  // F13 (auditoría PO, 2026-07-19): Texas, agregado con evidencia real
  // (misión real de contratistas eléctricos en Houston, TX, requerida en
  // la validación de descubrimiento externo) -- mismo criterio que el
  // resto de esta lista, cambio de datos, no de arquitectura.
  TX: "Texas",
};

interface KnownCity {
  name: string;
  stateCode: string;
}

const KNOWN_CITIES: KnownCity[] = [
  // Illinois -- ciudades reales de las 8 misiones auditadas en F7.0.
  { name: "Chicago", stateCode: "IL" },
  { name: "Rosemont", stateCode: "IL" },
  { name: "Schaumburg", stateCode: "IL" },
  { name: "Naperville", stateCode: "IL" },
  { name: "Aurora", stateCode: "IL" },
  { name: "Rockford", stateCode: "IL" },
  { name: "Elk Grove Village", stateCode: "IL" },
  { name: "Addison", stateCode: "IL" },
  { name: "Bolingbrook", stateCode: "IL" },
  { name: "Joliet", stateCode: "IL" },
  { name: "Elgin", stateCode: "IL" },
  { name: "Peoria", stateCode: "IL" },
  { name: "Decatur", stateCode: "IL" },
  { name: "Springfield", stateCode: "IL" },
  { name: "Champaign", stateCode: "IL" },
  { name: "Moline", stateCode: "IL" },
  { name: "Edwardsville", stateCode: "IL" },
  { name: "Waukegan", stateCode: "IL" },
  { name: "Bloomington", stateCode: "IL" },
  { name: "Romeoville", stateCode: "IL" },
  { name: "Plainfield", stateCode: "IL" },
  { name: "Carol Stream", stateCode: "IL" },
  { name: "Franklin Park", stateCode: "IL" },
  { name: "Melrose Park", stateCode: "IL" },
  { name: "Bedford Park", stateCode: "IL" },
  // Iowa
  { name: "Cedar Rapids", stateCode: "IA" },
  { name: "Des Moines", stateCode: "IA" },
  { name: "Council Bluffs", stateCode: "IA" },
  { name: "Davenport", stateCode: "IA" },
  { name: "Iowa City", stateCode: "IA" },
  // Texas -- F13 (auditoría PO, 2026-07-19), ver SUPPORTED_STATE_CODES arriba.
  { name: "Houston", stateCode: "TX" },
  { name: "Dallas", stateCode: "TX" },
  { name: "Austin", stateCode: "TX" },
  { name: "San Antonio", stateCode: "TX" },
  { name: "Fort Worth", stateCode: "TX" },
  { name: "El Paso", stateCode: "TX" },
];

// F14 (refinamiento de calidad, 2026-07-19): adyacencia geográfica real
// de EE.UU., pero SOLO entre estados que ya están en SUPPORTED_STATE_CODES
// arriba -- ampliar a un estado que el resto del sistema no reconoce no
// serviría de nada (executeDiscoveryPlan igual lo rechazaría). Usado
// exclusivamente por el refinamiento progresivo de descubrimiento
// (mission-executor.ts): si un estado no tiene ningún vecino soportado
// (ej. Texas hoy, cuyos vecinos reales -- Nuevo México, Oklahoma,
// Arkansas, Luisiana -- no están en la lista), ese paso del refinamiento
// simplemente no aporta estados nuevos, degradación honesta, nunca un
// vecino inventado.
export const NEARBY_SUPPORTED_STATES: Record<string, string[]> = {
  IL: ["IN", "WI", "IA", "MO"],
  IN: ["IL", "OH", "MI"],
  IA: ["IL", "WI", "MO", "NE"],
  NE: ["IA", "MO"],
  WI: ["IL", "IA", "MI"],
  MI: ["IN", "OH", "WI"],
  OH: ["IN", "MI"],
  MO: ["IL", "IA", "NE"],
  TX: [],
};

export interface GeoMatch {
  cities: string[];
  states: string[];
}

/**
 * Detecta ciudades/estados conocidos en un texto -- pura, determinista.
 * Un estado se infiere de una ciudad reconocida aunque el texto no lo
 * nombre explícitamente (ej. "Chicago" -> IL); nunca al revés (nombrar
 * un estado no inventa una ciudad). Códigos de 2 letras se reconocen
 * como palabra completa (evita que "IL" matchee dentro de otra palabra).
 */
export function detectCitiesAndStates(rawInstruction: string): GeoMatch {
  const normalized = normalizeText(rawInstruction);
  const cities = new Set<string>();
  const states = new Set<string>();

  for (const city of KNOWN_CITIES) {
    const normalizedCity = normalizeText(city.name);
    if (normalized.includes(normalizedCity)) {
      cities.add(city.name);
      states.add(city.stateCode);
    }
  }

  for (const [code, fullName] of Object.entries(SUPPORTED_STATE_CODES)) {
    const codeRe = new RegExp(`(?:^|[^a-z0-9])${code.toLowerCase()}(?:$|[^a-z0-9])`, "i");
    if (codeRe.test(` ${rawInstruction} `) || normalized.includes(normalizeText(fullName))) {
      states.add(code);
    }
  }

  return { cities: Array.from(cities), states: Array.from(states) };
}
