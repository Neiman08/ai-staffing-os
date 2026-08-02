import { z } from "zod";
import {
  DEFAULT_MODEL,
  OUTREACH_AGENT_SYSTEM_PROMPT,
  type LLMProvider,
  type LLMCompletionResult,
} from "@ai-staffing-os/agents";
import { DEFAULT_EMAIL_SIGNATURE, findKnownPlaceholders } from "@ai-staffing-os/shared";

const BUSINESS_NAME = "DreiStaff";

/**
 * Único generador de borradores de outreach comercial, compartido por
 * los 3 caminos reales que hoy crean un ApprovalRequest de email
 * (outreach-tools.impl.ts::personalizeMessage, discovery-conversion.ts,
 * draft.executor.ts) -- antes cada uno tenía su propio prompt/plantilla,
 * con idiomas hardcodeados y contradictorios entre sí (inglés forzado en
 * uno, español forzado/plantilla estática en los otros dos) y sin usar
 * casi ninguna de las señales reales ya reunidas por Discovery/Hiring
 * Signals/Contact Intelligence. Nunca depende del idioma de la
 * instrucción de la misión -- el idioma del email se decide acá, según
 * evidencia real de la propia empresa (ver resolveDraftLanguage).
 */

export type HiringSignalLevel = "confirmed" | "possible" | "none";

const CONFIRMED_HIRING_STATUSES = new Set(["CONFIRMED_HIRING", "LIKELY_HIRING"]);

export function classifyHiringSignalLevel(hiringStatus: string | null | undefined): HiringSignalLevel {
  if (hiringStatus && CONFIRMED_HIRING_STATUSES.has(hiringStatus)) return "confirmed";
  if (hiringStatus === "POSSIBLE_HIRING") return "possible";
  return "none";
}

export type DraftRecipientType = "person" | "organizational";
export type DraftLanguage = "en" | "es";

/**
 * Títulos reales a ofrecer -- prioridad a la señal de contratación
 * verificada de ESTA Company (targetTitlesMatched), luego a los
 * jobTitles reales de su trade (BusinessTaxonomyEntry) -- nunca la lista
 * completa de un catálogo genérico. Mismo criterio usado por los 4
 * caminos reales que generan un Draft.
 */
export function resolvePositionsToOffer(hiringTargetTitlesMatched: string[], taxonomyJobTitles: string[]): string[] {
  return hiringTargetTitlesMatched.length > 0 ? hiringTargetTitlesMatched : taxonomyJobTitles;
}

// Únicas frases de contratación en español ya reconocidas de forma
// determinista por hiring-signals.ts (GENERIC_HIRING_PHRASES) -- la
// única evidencia real (nunca una suposición) de que el propio sitio de
// la empresa habla en español, y por lo tanto de que el contacto podría
// preferir español. Sin esta evidencia, el idioma por defecto es
// siempre inglés (mercado estadounidense).
const SPANISH_HIRING_EVIDENCE_MARKERS = ["estamos contratando", "unete a nuestro equipo", "aplica ahora", "vacantes disponibles"];

export function resolveDraftLanguage(input: { hiringSignalEvidence: string[] }): DraftLanguage {
  const hasSpanishEvidence = input.hiringSignalEvidence.some((evidence) =>
    SPANISH_HIRING_EVIDENCE_MARKERS.some((marker) => evidence.toLowerCase().includes(marker)),
  );
  return hasSpanishEvidence ? "es" : "en";
}

export interface DraftGenerationInput {
  companyName: string;
  city: string | null;
  state: string | null;
  industryName: string;
  /** Trade específico (BusinessTaxonomyEntry.label), null si la Company nunca tuvo tradeKey real. */
  tradeLabel: string | null;
  services: string[];
  hiringSignalLevel: HiringSignalLevel;
  hiringSignalEvidence: string[];
  hiringSignalSourceUrls: string[];
  /** Tipos de trabajador reales para ofrecer -- nunca la lista completa de un catálogo, solo lo que matchea la evidencia/perfil. */
  positionsToOffer: string[];
  recipientType: DraftRecipientType;
  recipientName: string | null;
  recipientTitle: string | null;
  companyWebsite: string | null;
  language: DraftLanguage;
  stepLabel: string | null;
  openOpportunities: string[];
  recentActivitySubjects: string[];
}

export interface DraftFact {
  id: string;
  label: string;
}

export interface DraftMetadata {
  language: DraftLanguage;
  personalizationFactsUsed: string[];
  hiringSignalLevel: HiringSignalLevel;
  hiringSignalSource: string[];
  recipientType: DraftRecipientType;
  recipientName: string | null;
  recipientRole: string | null;
  companyName: string;
  companyLocation: string;
  positionsReferenced: string[];
  evidenceSummary: string;
  generationReasoningSummary: string;
}

function buildAvailableFacts(input: DraftGenerationInput): DraftFact[] {
  const facts: DraftFact[] = [];
  if (input.city || input.state) {
    facts.push({ id: "market_area", label: `Market/area: ${[input.city, input.state].filter(Boolean).join(", ")}` });
  }
  if (input.tradeLabel) {
    facts.push({ id: "business_type", label: `Business type / trade: ${input.tradeLabel}` });
  } else if (input.industryName) {
    facts.push({ id: "business_type", label: `Business type / industry: ${input.industryName}` });
  }
  if (input.services.length > 0) {
    facts.push({ id: "services", label: `Services/needs on file: ${input.services.join(", ")}` });
  }
  if (input.hiringSignalLevel !== "none" && input.hiringSignalEvidence.length > 0) {
    facts.push({ id: "hiring_signal", label: `Operational/hiring signal found: ${input.hiringSignalEvidence.slice(0, 3).join("; ")}` });
  }
  if (input.recipientType === "person" && input.recipientName) {
    facts.push({
      id: "decision_maker",
      label: `Decision-maker: ${input.recipientName}${input.recipientTitle ? `, ${input.recipientTitle}` : ""}`,
    });
  }
  if (input.companyWebsite) {
    facts.push({ id: "website", label: `Company website: ${input.companyWebsite}` });
  }
  if (input.openOpportunities.length > 0) {
    facts.push({ id: "open_opportunities", label: `Open opportunities on file: ${input.openOpportunities.join(", ")}` });
  }
  if (input.recentActivitySubjects.length > 0) {
    facts.push({ id: "recent_activity", label: `Recent activity on file: ${input.recentActivitySubjects.join("; ")}` });
  }
  return facts;
}

const HIRING_SIGNAL_GUIDANCE: Record<HiringSignalLevel, string> = {
  confirmed:
    "Hiring signal level: CONFIRMED HIRING. You may state that hiring activity was observed for this company (never invent a specific role beyond what's in the facts above) and reference the specific need found.",
  possible:
    "Hiring signal level: POSSIBLE HIRING (not confirmed). NEVER state or imply the company is currently hiring. Instead, talk about their operational capacity, project volume, or seasonal demand in a prudent, exploratory tone.",
  none:
    "Hiring signal level: NO SIGNAL FOUND. This is a purely exploratory outreach. NEVER mention hiring or vacancies. Ask, in a low-pressure way, whether they ever need temporary, project-based, or seasonal staffing support.",
};

// MIS-20260802-0002 (hallazgo real de producción): mostrar el id entre
// corchetes acá ("- [id] label") entrenaba al modelo a devolver también
// el id ENVUELTO en corchetes dentro de personalizationFactsUsed (ej.
// "[hiring_signal]" en vez de "hiring_signal"), que nunca matcheaba
// contra la lista real de ids y abortaba el borrador (y, antes del
// fix de aislamiento por candidato, la misión entera). Los corchetes acá
// son solo un separador visual; se recalca explícitamente que la
// respuesta debe ser el string plano. normalizeFactId (más abajo) además
// tolera que el modelo igual los incluya -- defensa en profundidad,
// nunca solo una instrucción de prompt.
function formatFactsForPrompt(facts: DraftFact[]): string {
  if (facts.length === 0) return "(no additional facts on file beyond company name/location/industry)";
  return facts.map((f) => `- id="${f.id}": ${f.label}`).join("\n");
}

/** Tolera que el modelo devuelva el id envuelto en corchetes/espacios (ver comentario de formatFactsForPrompt) -- nunca acepta un id que no exista en la lista real, solo recupera el formato esperado de uno que sí existe. */
function normalizeFactId(raw: string): string {
  return raw.trim().replace(/^\[+/, "").replace(/\]+$/, "").trim();
}

function buildDraftPrompt(input: DraftGenerationInput, facts: DraftFact[]): string {
  const languageLabel = input.language === "en" ? "professional US English" : "professional Spanish";
  const greetingGuidance =
    input.recipientType === "person" && input.recipientName
      ? `A real named decision-maker was identified -- address them by first name (${input.recipientName}).`
      : `No specific person was identified for this company -- address the organization generally (e.g. "Hello ${input.companyName} Team,"), never invent a person's name, and never label this contact as an identified individual.`;

  const positionsLine =
    input.positionsToOffer.length > 0
      ? `Worker types we could realistically help cover for this company (select only what fits the evidence/profile below -- never list all of them automatically): ${input.positionsToOffer.join(", ")}.`
      : "No specific worker-type evidence on file -- speak in general operational-staffing terms, never invent specific trade titles.";

  const stepLine = input.stepLabel
    ? `This is step "${input.stepLabel}" of an outreach sequence -- it must read as a fresh, genuinely personalized message, never a restated first email.`
    : "";

  return `Write a commercial outreach email draft for ${BUSINESS_NAME}, a staffing agency, targeting a real prospect company. This is ONLY a draft -- never say it was already sent.

Write the ENTIRE email (subject + body) in ${languageLabel}, regardless of the language of any internal mission instruction that led to this outreach.

Company: ${input.companyName}
Location: ${[input.city, input.state].filter(Boolean).join(", ") || "unknown"}
Industry: ${input.industryName}
${stepLine}

Available real facts about this company (use AT LEAST 2 of these to personalize the email -- never invent a fact that isn't listed here). Each fact has an id="..." -- in personalizationFactsUsed, return ONLY the bare id string exactly as it appears inside the quotes (e.g. market_area), never wrapped in brackets or quotes, never a value that isn't one of the ids below:
${formatFactsForPrompt(facts)}

${HIRING_SIGNAL_GUIDANCE[input.hiringSignalLevel]}

${positionsLine}

${greetingGuidance}

Mandatory structure, 110-180 words total (shorter is acceptable ONLY if the facts above are too sparse to sustain that length honestly -- never pad with filler):
1. Personalized greeting
2. Concrete reference to the company (name, location, or a real fact above -- never invented)
3. Specific reason for reaching out
4. Brief value proposition (what ${BUSINESS_NAME} does, staffing-focused)
5. Worker types we could help provide (only if evidence supports it)
6. Operational benefit (e.g. project-based staffing, seasonal surge coverage, coverage for absences/growth, reduced recruiting time, pre-vetted candidates, flexible scaling -- pick what's plausible, never promise licenses/certifications/background checks/immediate availability unless explicitly confirmed above)
7. Brief, low-pressure call to action (e.g. a short call)
8. Professional closing

Subject line: specific, natural, and non-spammy -- never a generic pattern like "Possible partnership with ${input.companyName}" or "Regarding your business". Never claim a vacancy/hiring need exists in the subject unless the hiring signal level above is CONFIRMED.

Never invent a name, headcount, project, certification, or capability not listed above. Never promise pricing, rates, or commitments. Never present yourself as a named individual (never write "My name is [...]") -- write on behalf of the ${BUSINESS_NAME} team. When evidence is limited, use cautious language ("It appears that...", "Based on your company's current operations...").

End the message EXACTLY with this signature, unmodified and untranslated, and never use any bracketed placeholder anywhere in the message (e.g. "[Your Name]"):
${DEFAULT_EMAIL_SIGNATURE}

Respond ONLY with a JSON object of this exact shape:
{"subject": "<short, specific subject>", "body": "<full email following the structure above, ending with the exact signature>", "personalizationFactsUsed": ["<bare fact id from the list above, e.g. market_area -- never bracketed>", "..."], "generationReasoningSummary": "<1-2 sentence, human-reviewable explanation of what evidence drove this draft's angle>"}`;
}

const draftOutputSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  personalizationFactsUsed: z.array(z.string()),
  generationReasoningSummary: z.string().min(1),
});
type DraftOutput = z.infer<typeof draftOutputSchema>;

function tryParseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const parsed: unknown = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    return schema.parse(parsed);
  } catch {
    return null;
  }
}

// Bloqueo explícito de las plantillas genéricas viejas (español e
// inglés) -- si alguna de estas reaparece, es evidencia de que el
// modelo volvió a un texto de relleno en vez de personalizar de verdad.
const BANNED_GENERIC_PATTERNS: RegExp[] = [
  /may be looking for staff/i,
  /posible colaboraci[oó]n con/i,
  /podr[ií]a estar buscando personal/i,
  /regarding your business/i,
  /possible partnership with/i,
];

const ASSERTIVE_HIRING_CLAIM_RE = /\byou('re| are)\s+(currently\s+)?hiring\b/i;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function validateDraftOutput(output: DraftOutput, input: DraftGenerationInput, facts: DraftFact[]): string[] {
  const problems: string[] = [];
  const factIds = new Set(facts.map((f) => f.id));
  const usedRealFacts = output.personalizationFactsUsed.map(normalizeFactId).filter((id) => factIds.has(id));
  // Mínimo 2 hechos reales cuando la Company los tiene -- pero nunca un
  // piso imposible de cumplir: si genuinamente solo hay 0/1 hecho
  // disponible (Company con muy poca evidencia todavía), exigir 2 solo
  // forzaría al modelo a inventar uno. min(2, hechos disponibles).
  const requiredFactCount = Math.min(2, facts.length);
  if (usedRealFacts.length < requiredFactCount) {
    problems.push(
      `personalizationFactsUsed must reference at least ${requiredFactCount} real fact(s) from the provided list (got: ${JSON.stringify(output.personalizationFactsUsed)}). The ONLY valid bare ids are: ${JSON.stringify(Array.from(factIds))}. Return them exactly as plain strings, never wrapped in brackets.`,
    );
  }

  const wordCount = countWords(output.body);
  if (wordCount < 60 || wordCount > 260) {
    problems.push(`body word count (${wordCount}) is far outside the expected 110-180 word range.`);
  }

  if (BANNED_GENERIC_PATTERNS.some((re) => re.test(output.body) || re.test(output.subject))) {
    problems.push("body/subject contains a banned generic template phrase -- write a genuinely personalized message instead.");
  }

  if (input.hiringSignalLevel !== "confirmed" && ASSERTIVE_HIRING_CLAIM_RE.test(output.body)) {
    problems.push("body asserts the company is currently hiring, but the hiring signal is not CONFIRMED.");
  }

  if (findKnownPlaceholders(output.body).length > 0 || findKnownPlaceholders(output.subject).length > 0) {
    problems.push("body/subject contains an unfilled bracket placeholder.");
  }

  if (!output.body.includes(DEFAULT_EMAIL_SIGNATURE.trim())) {
    problems.push("body does not end with the exact required signature, unmodified.");
  }

  return problems;
}

function buildMetadata(input: DraftGenerationInput, facts: DraftFact[], parsed: DraftOutput): DraftMetadata {
  const factLabelById = new Map(facts.map((f) => [f.id, f.label]));
  const usedFactIds = parsed.personalizationFactsUsed.map(normalizeFactId).filter((id) => factLabelById.has(id));
  return {
    language: input.language,
    personalizationFactsUsed: usedFactIds,
    hiringSignalLevel: input.hiringSignalLevel,
    hiringSignalSource: input.hiringSignalSourceUrls,
    recipientType: input.recipientType,
    recipientName: input.recipientName,
    recipientRole: input.recipientTitle,
    companyName: input.companyName,
    companyLocation: [input.city, input.state].filter(Boolean).join(", ") || "unknown",
    positionsReferenced: input.positionsToOffer,
    evidenceSummary: usedFactIds
      .map((id) => factLabelById.get(id))
      .filter((v): v is string => !!v)
      .join(" | "),
    generationReasoningSummary: parsed.generationReasoningSummary,
  };
}

export interface GenerateOutreachDraftParams {
  llmProvider: LLMProvider;
  usage?: { record: (result: LLMCompletionResult) => void };
  input: DraftGenerationInput;
}

export interface DraftGenerationSkipped {
  status: "skipped";
  /** Motivo legible, listo para persistir como draftSkippedReason -- nunca oculta el problema real. */
  reason: string;
  attemptsMade: number;
}

export interface DraftGenerationSucceeded {
  status: "generated";
  subject: string;
  body: string;
  metadata: DraftMetadata;
}

export type DraftGenerationOutcome = DraftGenerationSucceeded | DraftGenerationSkipped;

/**
 * Genera un borrador real vía LLM, con hasta 1 reintento cuando la
 * primera respuesta no pasa la validación de contenido (ver
 * validateDraftOutput) -- nunca se acepta un borrador que no personalice
 * con al menos 2 hechos reales, que reviva una plantilla genérica vieja,
 * o que afirme contratación sin señal confirmada.
 *
 * NUNCA lanza (hallazgo real MIS-20260802-0002: una excepción acá
 * escapaba sin aislamiento por candidato dentro de executeDiscoveryPlan
 * y abortaba la misión completa aunque el problema fuera de UNA sola
 * empresa). Cuando no se puede producir un borrador válido -- evidencia
 * insuficiente, respuesta del LLM inválida dos veces, o el propio
 * proveedor de LLM falla -- se devuelve `{status: "skipped", reason}` y
 * cada llamador decide cómo continuar (nunca forzando un Draft
 * inventado, nunca abortando la misión por esto).
 */
export async function generateOutreachDraft(params: GenerateOutreachDraftParams): Promise<DraftGenerationOutcome> {
  const facts = buildAvailableFacts(params.input);
  const basePrompt = buildDraftPrompt(params.input, facts);

  let lastProblems: string[] = ["no attempt made yet"];
  let attemptsMade = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    attemptsMade = attempt + 1;
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nYour previous attempt was rejected for these EXACT reasons -- fix ONLY the problem(s) described below, keep everything else that was already correct, and answer again with the same JSON shape:\n${lastProblems.map((p) => `- ${p}`).join("\n")}`;

    let completion: LLMCompletionResult;
    try {
      completion = await params.llmProvider.complete({
        model: DEFAULT_MODEL,
        messages: [
          { role: "system", content: OUTREACH_AGENT_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      });
    } catch (err) {
      lastProblems = [`LLM provider call failed: ${err instanceof Error ? err.message : String(err)}`];
      continue;
    }
    params.usage?.record(completion);

    const parsed = tryParseJson(completion.content, draftOutputSchema);
    if (!parsed) {
      lastProblems = ["LLM response was not valid JSON matching {subject, body, personalizationFactsUsed, generationReasoningSummary}."];
      continue;
    }

    const problems = validateDraftOutput(parsed, params.input, facts);
    if (problems.length === 0) {
      return { status: "generated", subject: parsed.subject, body: parsed.body, metadata: buildMetadata(params.input, facts, parsed) };
    }
    lastProblems = problems;
  }

  return {
    status: "skipped",
    reason: `No se pudo generar un borrador válido tras ${attemptsMade} intento(s): ${lastProblems.join(" | ")}`,
    attemptsMade,
  };
}
