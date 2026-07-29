import { z } from "zod";

/**
 * Corrección estructural (misión Iowa, 2026-07-13): la instrucción decía
 * explícitamente "no crear campañas; no crear oportunidades; no enviar
 * correos; no contactar a nadie", y la misión creó una Campaign de todas
 * formas — porque `mission-orchestrator.ts` la crea de forma
 * INCONDICIONAL en cada corrida, sin leer ninguna restricción. No existía
 * ningún campo que representara "el usuario prohibió esto".
 *
 * Este módulo convierte esas frases en flags estructurados que viajan
 * por todo el pipeline (input de la misión → mission-orchestrator.ts) y
 * lo bloquean en código — nunca dependiendo solo de que el LLM
 * (interpretDailyDirective) "recuerde" la frase. El detector determinista
 * de acá es la red de seguridad: el LLM también recibe la instrucción y
 * puede marcar estos mismos flags, pero el resultado final es el AND de
 * ambas señales — un flag solo puede pasar de permitido a prohibido,
 * nunca al revés, sin importar qué diga el LLM.
 */
export const missionRestrictionsSchema = z.object({
  allowCampaignCreation: z.boolean(),
  allowOpportunityCreation: z.boolean(),
  allowOutreach: z.boolean(),
  allowMessageSending: z.boolean(),
  // F28 (hallazgo real, misiones roofing/landscaping 2026-07-27): "Crea
  // Leads, Opportunities y Drafts únicamente. No envíes correos
  // automáticamente." terminó sin ningún Draft, porque allowMessageSending
  // (pensado para "no enviar") era el mismo flag que gateaba la creación
  // del borrador en mission-orchestrator.ts -- "no enviar" nunca debe
  // significar "no redactar". Flag independiente, default permisivo,
  // solo se apaga con una negación EXPLÍCITA de redactar/preparar (ver
  // NO_DRAFT_RE) -- nunca por una frase que solo prohíbe el envío.
  allowDraftCreation: z.boolean(),
  // F28 (misión real de Hospitality, 2026-07-28, pedido explícito del PO):
  // true SOLO cuando la instrucción exige explícitamente evidencia de
  // contratación ("que estén contratando"/"actively hiring") -- default
  // false. A diferencia de los flags allowX de arriba (permisivos por
  // default, una negación explícita los restringe), este es restrictivo
  // por default y se ACTIVA con una señal positiva explícita -- se
  // combina por OR, no por AND (ver mergeMissionRestrictions): si
  // CUALQUIERA de las dos fuentes detecta el pedido, se aplica.
  requireHiringSignal: z.boolean(),
});
export type MissionRestrictions = z.infer<typeof missionRestrictionsSchema>;

export const DEFAULT_MISSION_RESTRICTIONS: MissionRestrictions = {
  allowCampaignCreation: true,
  allowOpportunityCreation: true,
  allowOutreach: true,
  allowMessageSending: true,
  allowDraftCreation: true,
  requireHiringSignal: false,
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // quita acentos — "campañas" -> "campanas"
}

// Cada patrón cubre español e inglés, singular y plural, con o sin
// "sin"/"no" como negador — construidos a partir de la frase real que
// disparó este fix ("no crear campañas; no crear oportunidades; no
// enviar correos; no contactar a nadie") más variantes razonables.
const NO_CAMPAIGN_RE = /\b(no|sin|nunca)\s+(crear|crees|creen|genera|generar|generes|abrir|abras|lanzar|lances)\s+campa(n|ñ)as?\b|\bno\s+campaigns?\b/;
// F7.2 (bug confirmado): "no crear campañas ni/o oportunidades" no
// disparaba esta regex porque el verbo "crear" nunca queda adyacente a
// "oportunidad(es)" en esa construcción — la 3ra alternativa cubre
// EXACTAMENTE ese caso confirmado (conector "ni"/"o"), sin ampliar el
// alcance a ninguna otra expresión no confirmada.
const NO_OPPORTUNITY_RE =
  /\b(no|sin|nunca)\s+(crear|crees|creen|genera|generar|generes|abrir|abras)\s+oportunidad(es)?\b|\bno\s+opportunit(y|ies)\b|\b(no|sin|nunca)\s+(crear|crees|creen|genera|generar|generes|abrir|abras|lanzar|lances)\s+campa(?:n|ñ)as?\s+(?:ni|o)\s+oportunidad(?:es)?\b/;
// F28: "preparar/prepares" (y su negación EN "prepare/preparing") se
// movieron a NO_DRAFT_RE, abajo -- "no enviar correos" y "no preparar
// mensajes" son prohibiciones DISTINTAS (enviar vs. redactar), y hasta
// F27 esta única regex las trataba como la misma cosa. Esta regex ahora
// cubre EXCLUSIVAMENTE el verbo de envío real (enviar/mandar/send) más
// las frases de "no contactar/no outreach" -- una prohibición amplia de
// alcanzar a alguien, que sigue implicando "no enviar" (nunca al revés:
// no implica "no redactar", ver allowDraftCreation).
// F28: los verbos "enviar/mandar" solo existen en español -- el soporte
// EN de esta regex viene de las ramas sueltas de abajo, que aceptan
// "no"/"not"/"don't"/"do not" como negador (antes SOLO "no" literal,
// así que "Don't send emails" nunca se detectaba pese a ser la forma
// más natural en inglés de decir lo mismo).
const NO_OUTREACH_RE =
  /\b(no|sin|nunca)\s+(enviar|envies|env[ií]e|mandar|mandes)\s+(correos?|emails?|mensajes?|mails?)\b|\bno\s+contactar\s+a?\s*nadie\b|\bno\s+contact(ar)?\b|\bno\s+outreach\b|\b(?:no|not|don'?t|do\s+not)\s+send(ing)?\s+(emails?|messages?)\b/;

// F28 (hallazgo real, misiones roofing/landscaping 2026-07-27): única
// forma real de prohibir la REDACCIÓN de un borrador -- nunca disparada
// por "no enviar/no mandar" (eso es NO_OUTREACH_RE, arriba, y solo
// afecta allowOutreach/allowMessageSending). Mismos verbos ES/EN que
// tenía "preparar" antes de este fix, más "redactar"/"draft" explícitos,
// y el mismo soporte de negador EN ("not"/"don't"/"do not") que arriba.
const NO_DRAFT_RE =
  /\b(no|sin|nunca)\s+(preparar|prepares|redactar|redactes|generar|generes)\s+(correos?|emails?|mensajes?|mails?|borradores?|drafts?)\b|\bno\s+prepar(e|ing)\s+(emails?|messages?|drafts?)\b|\b(?:no|not|don'?t|do\s+not)\s+draft(ing)?\s+(emails?|messages?)\b|\b(?:no|not|don'?t|do\s+not)\s+writ(e|ing)\s+draft(s)?\b/;

// F28 (misión real de Hospitality, 2026-07-28): frase positiva EXPLÍCITA
// de que la contratación/hiring es un criterio real de la misión --
// nunca disparado por la sola presencia de la palabra "hiring" (ej.
// "hiring signals" es un término reconocido del producto, no un pedido
// de filtrar por él, ver KNOWN_CAPABILITY_TERMS en ceo-tools.impl.ts).
const REQUIRE_HIRING_SIGNAL_RE =
  /\bque\s+est[eé]n?\s+contratando\b|\bactivamente\s+contratando\b|\bque\s+est[eé]n?\s+reclutando\b|\bactively\s+hiring\b|\bthat\s+are\s+hiring\b|\bcurrently\s+hiring\b|\bwho\s+are\s+hiring\b/;

/**
 * Detector determinista — cero LLM, cero ambigüedad. Solo puede resultar
 * en flags MÁS restrictivos que el default (nunca reactiva algo que el
 * texto no autorizó explícitamente); combinar con la interpretación del
 * LLM es responsabilidad del llamador (ver ceo-tools.impl.ts).
 */
export function detectMissionRestrictionsFromText(rawInstruction: string): MissionRestrictions {
  const text = normalize(rawInstruction);
  const outreachBlocked = NO_OUTREACH_RE.test(text);
  return {
    allowCampaignCreation: !NO_CAMPAIGN_RE.test(text),
    allowOpportunityCreation: !NO_OPPORTUNITY_RE.test(text),
    allowOutreach: !outreachBlocked,
    allowMessageSending: !outreachBlocked,
    allowDraftCreation: !NO_DRAFT_RE.test(text),
    requireHiringSignal: REQUIRE_HIRING_SIGNAL_RE.test(text),
  };
}

/**
 * Combina la interpretación del LLM con el detector determinista — el AND
 * lógico asegura que ninguna de las dos fuentes pueda, por sí sola,
 * reactivar algo que la otra ya prohibió. Dirección segura: de permitido
 * a prohibido, nunca al revés.
 */
export function mergeMissionRestrictions(
  llmParsed: Partial<MissionRestrictions> | null | undefined,
  rawInstruction: string,
): MissionRestrictions {
  const deterministic = detectMissionRestrictionsFromText(rawInstruction);
  const llm = { ...DEFAULT_MISSION_RESTRICTIONS, ...(llmParsed ?? {}) };
  return {
    allowCampaignCreation: llm.allowCampaignCreation && deterministic.allowCampaignCreation,
    allowOpportunityCreation: llm.allowOpportunityCreation && deterministic.allowOpportunityCreation,
    allowOutreach: llm.allowOutreach && deterministic.allowOutreach,
    allowMessageSending: llm.allowMessageSending && deterministic.allowMessageSending,
    allowDraftCreation: llm.allowDraftCreation && deterministic.allowDraftCreation,
    // OR, no AND -- ver el comentario del campo en el schema: esto es un
    // requisito que se ACTIVA, nunca un permiso que se restringe.
    requireHiringSignal: llm.requireHiringSignal || deterministic.requireHiringSignal,
  };
}
