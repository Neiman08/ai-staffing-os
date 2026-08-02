import { test } from "node:test";
import assert from "node:assert/strict";
import type { LLMCompletionRequest, LLMCompletionResult, LLMProvider } from "@ai-staffing-os/agents";
import { DEFAULT_EMAIL_SIGNATURE } from "@ai-staffing-os/shared";
import {
  classifyHiringSignalLevel,
  generateOutreachDraft,
  resolveDraftLanguage,
  resolvePositionsToOffer,
  type DraftGenerationInput,
  type DraftGenerationSucceeded,
} from "./draft-generation";

/**
 * Regresión de la corrección de idioma/profundidad de los email drafts,
 * y de la corrección de resiliencia posterior (hallazgo real
 * MIS-20260802-0002): el idioma del outreach nunca debe depender del
 * idioma de la instrucción de la misión (ver resolveDraftLanguage), toda
 * Company requiere personalización real basada en evidencia (nunca una
 * plantilla genérica), el nivel de señal de contratación condiciona lo
 * que el mensaje puede afirmar (nunca "está contratando" sin señal
 * CONFIRMED), y generateOutreachDraft NUNCA lanza -- cuando no puede
 * producir un borrador válido devuelve {status:"skipped", reason},
 * nunca aborta a quien lo llama.
 */

function baseInput(overrides: Partial<DraftGenerationInput> = {}): DraftGenerationInput {
  return {
    companyName: "Acme Roofing LLC",
    city: "Decatur",
    state: "IL",
    industryName: "Construction",
    tradeLabel: "Roofing Contractor",
    services: ["Residential Roofing", "Commercial Roofing"],
    hiringSignalLevel: "none",
    hiringSignalEvidence: [],
    hiringSignalSourceUrls: [],
    positionsToOffer: [],
    recipientType: "organizational",
    recipientName: null,
    recipientTitle: null,
    companyWebsite: "https://acme-roofing.example",
    language: "en",
    stepLabel: null,
    openOpportunities: [],
    recentActivitySubjects: [],
    ...overrides,
  };
}

function extractFactIds(prompt: string): string[] {
  return Array.from(new Set(Array.from(prompt.matchAll(/^- id="([^"]+)":/gm)).map((m) => m[1]!)));
}

function wordyBody(sentences: number): string {
  const filler =
    "We work with companies in your market to provide flexible, pre-vetted staffing support for ongoing roles, project-based demand, and seasonal surges without adding recruiting overhead to your team. ";
  return `Hello,\n\n${filler.repeat(sentences)}\n\n${DEFAULT_EMAIL_SIGNATURE}`;
}

function providerReturning(...responses: Array<Record<string, unknown>>): LLMProvider {
  let call = 0;
  return {
    complete: async (_req: LLMCompletionRequest): Promise<LLMCompletionResult> => {
      const response = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return { content: JSON.stringify(response), tokensUsed: 10, promptTokens: 8, completionTokens: 2 };
    },
  };
}

function goodResponse(prompt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const factIds = extractFactIds(prompt);
  return {
    subject: "Staffing support for Acme Roofing LLC",
    body: wordyBody(3),
    personalizationFactsUsed: factIds.slice(0, 2),
    generationReasoningSummary: "Used market/area and business type to personalize this outreach.",
    ...overrides,
  };
}

async function expectGenerated(provider: LLMProvider, input: DraftGenerationInput): Promise<DraftGenerationSucceeded> {
  const result = await generateOutreachDraft({ llmProvider: provider, input });
  assert.equal(result.status, "generated", result.status === "skipped" ? result.reason : undefined);
  if (result.status !== "generated") throw new Error("unreachable");
  return result;
}

// ---------- resolveDraftLanguage ----------

test("resolveDraftLanguage: sin evidencia -> inglés por defecto (mercado estadounidense)", () => {
  assert.equal(resolveDraftLanguage({ hiringSignalEvidence: [] }), "en");
});

test("resolveDraftLanguage: evidencia de contratación en inglés -> sigue en inglés", () => {
  assert.equal(resolveDraftLanguage({ hiringSignalEvidence: ['Frase de contratación "now hiring" encontrada en https://acme.example'] }), "en");
});

test("resolveDraftLanguage: evidencia REAL de una frase de contratación en español -> español", () => {
  assert.equal(
    resolveDraftLanguage({ hiringSignalEvidence: ['Frase de contratación "estamos contratando" encontrada en https://acme.example'] }),
    "es",
  );
});

test("resolveDraftLanguage: nunca depende del idioma de la instrucción de la misión, solo de evidencia real de la propia empresa", () => {
  // Mismo input sin importar si la misión que originó este borrador fue
  // pedida en español o inglés -- resolveDraftLanguage no recibe (ni
  // puede recibir) el idioma de la instrucción, solo evidencia de la Company.
  assert.equal(resolveDraftLanguage({ hiringSignalEvidence: [] }), "en");
});

// ---------- classifyHiringSignalLevel ----------

test("classifyHiringSignalLevel: CONFIRMED_HIRING y LIKELY_HIRING -> confirmed", () => {
  assert.equal(classifyHiringSignalLevel("CONFIRMED_HIRING"), "confirmed");
  assert.equal(classifyHiringSignalLevel("LIKELY_HIRING"), "confirmed");
});

test("classifyHiringSignalLevel: POSSIBLE_HIRING -> possible", () => {
  assert.equal(classifyHiringSignalLevel("POSSIBLE_HIRING"), "possible");
});

test("classifyHiringSignalLevel: NO_SIGNAL/BLOCKED/UNKNOWN/null -> none", () => {
  assert.equal(classifyHiringSignalLevel("NO_SIGNAL"), "none");
  assert.equal(classifyHiringSignalLevel("BLOCKED"), "none");
  assert.equal(classifyHiringSignalLevel("UNKNOWN"), "none");
  assert.equal(classifyHiringSignalLevel(null), "none");
  assert.equal(classifyHiringSignalLevel(undefined), "none");
});

// ---------- resolvePositionsToOffer ----------

test("resolvePositionsToOffer: prioriza títulos con evidencia real de contratación (matched)", () => {
  assert.deepEqual(resolvePositionsToOffer(["Roofer"], ["Roofer", "Installer", "Laborer"]), ["Roofer"]);
});

test("resolvePositionsToOffer: sin títulos matcheados, cae a los jobTitles reales de la taxonomía del trade", () => {
  assert.deepEqual(resolvePositionsToOffer([], ["Roofer", "Installer", "Laborer"]), ["Roofer", "Installer", "Laborer"]);
});

test("resolvePositionsToOffer: sin evidencia ni taxonomía, nunca inventa -- lista vacía", () => {
  assert.deepEqual(resolvePositionsToOffer([], []), []);
});

// ---------- generateOutreachDraft: NUNCA lanza -- devuelve {status:"skipped"} ----------

test("generateOutreachDraft: tras 2 intentos con IDs de evidencia inventados -> {status:skipped}, nunca lanza, nunca acepta un genérico sin personalizar", async () => {
  const provider = providerReturning(
    { subject: "Hi", body: wordyBody(3), personalizationFactsUsed: ["made_up_fact"], generationReasoningSummary: "x" },
    { subject: "Hi", body: wordyBody(3), personalizationFactsUsed: ["made_up_fact"], generationReasoningSummary: "x" },
  );
  const result = await generateOutreachDraft({ llmProvider: provider, input: baseInput() });
  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") return;
  assert.equal(result.attemptsMade, 2);
  assert.match(result.reason, /made_up_fact/);
});

// MIS-20260802-0002 (hallazgo real de producción): el modelo devolvió
// los ids envueltos en corchetes ("[hiring_signal]") en vez del string
// plano -- normalizeFactId debe recuperarlos igual, nunca rechazar un id
// real solo por el formato.
test("generateOutreachDraft: tolera ids envueltos en corchetes (formato real observado en producción, MIS-20260802-0002)", async () => {
  const provider: LLMProvider = {
    complete: async (req) => {
      const prompt = req.messages[req.messages.length - 1]!.content;
      const factIds = extractFactIds(prompt);
      const bracketed = factIds.slice(0, 2).map((id) => `[${id}]`);
      return {
        content: JSON.stringify({ subject: "Hi", body: wordyBody(3), personalizationFactsUsed: bracketed, generationReasoningSummary: "x" }),
        tokensUsed: 10,
      };
    },
  };
  const result = await expectGenerated(provider, baseInput());
  assert.ok(result.metadata.personalizationFactsUsed.length >= 2);
});

test("generateOutreachDraft: respuesta que no es JSON válido -> {status:skipped} tras 2 intentos, nunca lanza", async () => {
  const provider: LLMProvider = {
    complete: async (): Promise<LLMCompletionResult> => ({ content: "not json at all", tokensUsed: 5 }),
  };
  const result = await generateOutreachDraft({ llmProvider: provider, input: baseInput() });
  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") return;
  assert.match(result.reason, /not valid JSON/);
});

test("generateOutreachDraft: el proveedor LLM lanza (ej. sin API key) -> {status:skipped} tras 2 intentos, nunca propaga la excepción", async () => {
  const provider: LLMProvider = {
    complete: async (): Promise<LLMCompletionResult> => {
      throw new Error("OPENAI_API_KEY no está configurada.");
    },
  };
  const result = await generateOutreachDraft({ llmProvider: provider, input: baseInput() });
  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") return;
  assert.match(result.reason, /OPENAI_API_KEY/);
});

test("generateOutreachDraft: reintenta una vez y acepta si el 2do intento sí referencia hechos reales", async () => {
  let lastPrompt = "";
  const provider: LLMProvider = {
    complete: async (req) => {
      lastPrompt = req.messages[req.messages.length - 1]!.content;
      const attempt = req.messages.some((m) => m.content.includes("Your previous attempt was rejected"));
      const body = attempt ? goodResponse(lastPrompt) : { subject: "Hi", body: wordyBody(3), personalizationFactsUsed: ["nope"], generationReasoningSummary: "x" };
      return { content: JSON.stringify(body), tokensUsed: 10 };
    },
  };
  const result = await expectGenerated(provider, baseInput());
  assert.ok(result.metadata.personalizationFactsUsed.length >= 2);
});

test("generateOutreachDraft: con Company sin evidencia adicional (solo nombre/ubicación/industria), exige menos hechos -- nunca imposible de cumplir", async () => {
  const input = baseInput({ city: null, state: null, tradeLabel: null, industryName: "", services: [], companyWebsite: null });
  const provider: LLMProvider = {
    complete: async (req) => {
      const prompt = req.messages[req.messages.length - 1]!.content;
      return { content: JSON.stringify(goodResponse(prompt)), tokensUsed: 10 };
    },
  };
  // Con cero hechos reales disponibles (sin ciudad/estado/trade/sitio),
  // el mínimo exigido baja a 0 -- nunca debe forzar al modelo a inventar.
  const result = await expectGenerated(provider, input);
  assert.ok(result.subject.length > 0);
});

// ---------- generateOutreachDraft: nivel de señal de contratación ----------

test("generateOutreachDraft: nivel POSSIBLE -- {status:skipped} para una respuesta que afirma 'you are hiring' sin señal confirmada", async () => {
  const provider = providerReturning(
    { subject: "Hi", body: wordyBody(1) + "\n\nWe noticed you are hiring right now.", personalizationFactsUsed: ["market_area", "business_type"], generationReasoningSummary: "x" },
    { subject: "Hi", body: wordyBody(1) + "\n\nWe noticed you are hiring right now.", personalizationFactsUsed: ["market_area", "business_type"], generationReasoningSummary: "x" },
  );
  const result = await generateOutreachDraft({ llmProvider: provider, input: baseInput({ hiringSignalLevel: "possible" }) });
  assert.equal(result.status, "skipped");
});

test("generateOutreachDraft: nivel CONFIRMED -- permite un mensaje que menciona contratación observada", async () => {
  const provider: LLMProvider = {
    complete: async (req) => {
      const prompt = req.messages[req.messages.length - 1]!.content;
      const body = goodResponse(prompt, { body: wordyBody(3) + "\n\nWe noticed you are hiring roofers in your area.\n\n" + DEFAULT_EMAIL_SIGNATURE });
      return { content: JSON.stringify(body), tokensUsed: 10 };
    },
  };
  const result = await expectGenerated(
    provider,
    baseInput({ hiringSignalLevel: "confirmed", hiringSignalEvidence: ['"Roofer" mencionado en https://acme-roofing.example/careers'] }),
  );
  assert.equal(result.metadata.hiringSignalLevel, "confirmed");
});

// ---------- generateOutreachDraft: bloqueo de plantillas genéricas viejas ----------

test("generateOutreachDraft: {status:skipped} para la plantilla genérica vieja en español ('Posible colaboración con...')", async () => {
  const provider = providerReturning(
    { subject: "Posible colaboración con Acme Roofing LLC", body: wordyBody(2), personalizationFactsUsed: ["market_area", "business_type"], generationReasoningSummary: "x" },
    { subject: "Posible colaboración con Acme Roofing LLC", body: wordyBody(2), personalizationFactsUsed: ["market_area", "business_type"], generationReasoningSummary: "x" },
  );
  const result = await generateOutreachDraft({ llmProvider: provider, input: baseInput() });
  assert.equal(result.status, "skipped");
});

test("generateOutreachDraft: {status:skipped} para la plantilla genérica vieja en inglés ('may be looking for staff')", async () => {
  const provider = providerReturning(
    { subject: "Hi", body: "Hello,\n\nWe noticed that your company may be looking for staff.\n\n" + DEFAULT_EMAIL_SIGNATURE, personalizationFactsUsed: ["market_area", "business_type"], generationReasoningSummary: "x" },
    { subject: "Hi", body: "Hello,\n\nWe noticed that your company may be looking for staff.\n\n" + DEFAULT_EMAIL_SIGNATURE, personalizationFactsUsed: ["market_area", "business_type"], generationReasoningSummary: "x" },
  );
  const result = await generateOutreachDraft({ llmProvider: provider, input: baseInput() });
  assert.equal(result.status, "skipped");
});

// ---------- generateOutreachDraft: firma y placeholders ----------

test("generateOutreachDraft: {status:skipped} para un cuerpo que no termina con la firma exacta", async () => {
  const provider = providerReturning(
    { subject: "Hi", body: "Hello,\n\nSome body text without the real signature.", personalizationFactsUsed: ["market_area", "business_type"], generationReasoningSummary: "x" },
    { subject: "Hi", body: "Hello,\n\nSome body text without the real signature.", personalizationFactsUsed: ["market_area", "business_type"], generationReasoningSummary: "x" },
  );
  const result = await generateOutreachDraft({ llmProvider: provider, input: baseInput() });
  assert.equal(result.status, "skipped");
});

test("generateOutreachDraft: {status:skipped} para un placeholder sin completar (ej. [Your Name])", async () => {
  const bodyWithPlaceholder = `Hello [Your Name],\n\n${wordyBody(2)}`;
  const provider = providerReturning(
    { subject: "Hi", body: bodyWithPlaceholder, personalizationFactsUsed: ["market_area", "business_type"], generationReasoningSummary: "x" },
    { subject: "Hi", body: bodyWithPlaceholder, personalizationFactsUsed: ["market_area", "business_type"], generationReasoningSummary: "x" },
  );
  const result = await generateOutreachDraft({ llmProvider: provider, input: baseInput() });
  assert.equal(result.status, "skipped");
});

// ---------- generateOutreachDraft: metadata devuelta ----------

test("generateOutreachDraft: metadata refleja idioma, tipo de destinatario, ubicación y hechos usados", async () => {
  const provider: LLMProvider = {
    complete: async (req) => {
      const prompt = req.messages[req.messages.length - 1]!.content;
      return { content: JSON.stringify(goodResponse(prompt)), tokensUsed: 10 };
    },
  };
  const result = await expectGenerated(provider, baseInput({ recipientType: "person", recipientName: "Maria", recipientTitle: "Operations Manager" }));
  assert.equal(result.metadata.language, "en");
  assert.equal(result.metadata.recipientType, "person");
  assert.equal(result.metadata.recipientName, "Maria");
  assert.equal(result.metadata.recipientRole, "Operations Manager");
  assert.equal(result.metadata.companyLocation, "Decatur, IL");
  assert.ok(result.metadata.personalizationFactsUsed.length >= 2);
  assert.ok(result.metadata.evidenceSummary.length > 0);
});
