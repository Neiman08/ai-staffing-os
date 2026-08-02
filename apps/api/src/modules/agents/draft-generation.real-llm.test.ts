import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "@ai-staffing-os/agents";
import { env } from "../../core/env";
import { REAL_PROVIDER_TESTS_ENABLED, REAL_PROVIDER_TEST_SKIP_REASON } from "../../test-helpers/real-provider-tests";
import { generateOutreachDraft, type DraftGenerationInput } from "./draft-generation";

/**
 * Único test con una llamada REAL a OpenAI (gpt-4o-mini) -- confirma con
 * evidencia real, no solo con un fake determinista, que el escenario
 * concreto del pedido (roofing en Illinois, misión pedida originalmente
 * en español) produce un draft en inglés, personalizado con evidencia
 * real, y sin afirmar contratación sin señal confirmada. Gateado detrás
 * de RUN_REAL_PROVIDER_TESTS=1 -- nunca corre en CI ni en `pnpm test`
 * por default (ver test-helpers/real-provider-tests.ts).
 */

const roofingIllinoisInput: DraftGenerationInput = {
  companyName: "Stanley Roofing",
  city: "Decatur",
  state: "IL",
  industryName: "Construction",
  tradeLabel: "Roofing Contractor",
  services: ["Residential Roofing", "Commercial Roofing"],
  hiringSignalLevel: "possible",
  hiringSignalEvidence: ['Frase de contratación "join our team" encontrada en https://stanleyroofing.example/careers'],
  hiringSignalSourceUrls: ["https://stanleyroofing.example/careers"],
  positionsToOffer: ["Roofer", "Roofing Laborer", "Installer"],
  recipientType: "organizational",
  recipientName: null,
  recipientTitle: null,
  companyWebsite: "https://stanleyroofing.example",
  language: "en",
  stepLabel: null,
  openOpportunities: [],
  recentActivitySubjects: [],
};

test(
  "generateOutreachDraft (LLM real): misión de roofing en Illinois pedida en español produce un draft real en inglés, personalizado, sin afirmar contratación confirmada",
  { skip: !REAL_PROVIDER_TESTS_ENABLED ? REAL_PROVIDER_TEST_SKIP_REASON : false },
  async () => {
    assert.ok(env.OPENAI_API_KEY, "RUN_REAL_PROVIDER_TESTS=1 requiere OPENAI_API_KEY real configurada");
    const provider = new OpenAIProvider(env.OPENAI_API_KEY!);

    const result = await generateOutreachDraft({ llmProvider: provider, input: roofingIllinoisInput });
    assert.equal(result.status, "generated", result.status === "skipped" ? result.reason : undefined);
    if (result.status !== "generated") return;

    // Nunca en español -- el idioma de la instrucción original de la
    // misión (que pidió esto en español) nunca debe filtrarse al draft.
    assert.doesNotMatch(result.body, /\b(empresa|saludos|estimado|gracias|contrataci[oó]n)\b/i);
    assert.doesNotMatch(result.subject, /\b(empresa|posible colaboraci[oó]n)\b/i);

    // Nunca afirma contratación confirmada -- el nivel de señal es "possible".
    assert.doesNotMatch(result.body, /\byou('re| are)\s+(currently\s+)?hiring\b/i);

    // Personalización real: al menos 2 hechos reales usados.
    assert.ok(result.metadata.personalizationFactsUsed.length >= 2, `personalizationFactsUsed: ${JSON.stringify(result.metadata.personalizationFactsUsed)}`);
    assert.equal(result.metadata.language, "en");
    assert.equal(result.metadata.hiringSignalLevel, "possible");

    // Estructura mínima: firma real, sin placeholders (ya validado
    // internamente por generateOutreachDraft, pero se reconfirma acá
    // como evidencia end-to-end real).
    assert.match(result.body, /DreiStaff/);
  },
);
