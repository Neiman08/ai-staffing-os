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
});
export type MissionRestrictions = z.infer<typeof missionRestrictionsSchema>;

export const DEFAULT_MISSION_RESTRICTIONS: MissionRestrictions = {
  allowCampaignCreation: true,
  allowOpportunityCreation: true,
  allowOutreach: true,
  allowMessageSending: true,
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
const NO_OPPORTUNITY_RE = /\b(no|sin|nunca)\s+(crear|crees|creen|genera|generar|generes|abrir|abras)\s+oportunidad(es)?\b|\bno\s+opportunit(y|ies)\b/;
const NO_OUTREACH_RE =
  /\b(no|sin|nunca)\s+(enviar|envies|env[ií]e|mandar|mandes)\s+(correos?|emails?|mensajes?|mails?)\b|\bno\s+contactar\s+a?\s*nadie\b|\bno\s+contact(ar)?\b|\bno\s+outreach\b|\bno\s+send(ing)?\s+(emails?|messages?)\b/;

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
  };
}
