import type { LLMCompletionResult, LLMProvider } from "@ai-staffing-os/agents";

/**
 * Fake LLM compartido por los tests de los 3 caminos reales que crean un
 * Draft (outreach-tools.impl.test.ts, discovery-conversion.integration.test.ts,
 * draft.executor.test.ts) -- nunca hardcodea un `subject`/`body` fijo,
 * porque generateOutreachDraft (draft-generation.ts) ahora exige
 * `personalizationFactsUsed` (>= 2 ids reales tomados del prompt) y
 * rechaza cualquier respuesta que no los referencie. Este fake lee los
 * ids reales listados en el prompt ("Available real facts...", formato
 * `id="..."`) y los devuelve tal cual -- así cada test sigue controlando
 * la evidencia (vía la Company/Contact real que crea) sin tener que
 * fabricar contenido de email a mano.
 */
export function fakeDraftLLMProvider(): { provider: LLMProvider; callCount: () => number } {
  let calls = 0;
  const provider: LLMProvider = {
    complete: async (params): Promise<LLMCompletionResult> => {
      calls += 1;
      const prompt = params.messages.map((m) => m.content).join("\n");
      const factIds = Array.from(new Set(Array.from(prompt.matchAll(/^- id="([^"]+)":/gm)).map((m) => m[1]!)));
      const companyName = /^Company: (.+)$/m.exec(prompt)?.[1]?.trim() ?? "your company";
      const signatureMatch = /exactly with this signature[^:]*:\n([\s\S]+?)\n\nRespond ONLY/i.exec(prompt);
      const signature = signatureMatch?.[1]?.trim() ?? "Best regards,\n\nThe DreiStaff Team";
      const body = [
        `Hello,`,
        ``,
        `We came across ${companyName} and wanted to reach out regarding your current staffing needs. Based on your company's operations, it appears you could benefit from reliable, pre-vetted workforce support as your business continues its regular activity in your market.`,
        `We work with companies like yours to provide flexible staffing coverage, whether for ongoing roles, project-based demand, or seasonal surges, and our goal is to reduce the time and effort it takes to find dependable workers so your team can stay focused on operations.`,
        `Would you be open to a brief call sometime this week to discuss whether this could be useful for your team?`,
        ``,
        signature,
      ].join("\n");
      return {
        content: JSON.stringify({
          subject: `Staffing support for ${companyName}`,
          body,
          personalizationFactsUsed: factIds.slice(0, Math.max(2, factIds.length)),
          generationReasoningSummary: "Fixture: reasoning summary for automated tests.",
        }),
        tokensUsed: 80,
        promptTokens: 60,
        completionTokens: 20,
      };
    },
  };
  return { provider, callCount: () => calls };
}

export function throwingLLMProvider(message: string): LLMProvider {
  return {
    complete: async (): Promise<LLMCompletionResult> => {
      throw new Error(message);
    },
  };
}
