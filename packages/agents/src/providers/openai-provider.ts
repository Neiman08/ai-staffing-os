import OpenAI from "openai";
import type { LLMCompletionRequest, LLMCompletionResult, LLMProvider } from "../core/LLMProvider";

/**
 * F2: primer LLMProvider real. Modelo económico por defecto (Architecture
 * §6.3, "modelo pequeño para tareas rutinarias") — el Sales Agent en F2 no
 * necesita razonamiento abierto, solo interpretación acotada (scoring) y
 * redacción corta (draftOutreach).
 */
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("OpenAIProvider requires a non-empty API key");
    }
    this.client = new OpenAI({ apiKey });
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    // F2's AgentRuntime is single-shot (no multi-turn tool-calling loop
    // yet, see AgentRuntime.ts) — only system/user/assistant messages are
    // ever produced today. The "tool" role in LLMMessage exists for a
    // future ReAct loop and isn't handled here yet.
    const messages = request.messages.map((m) => {
      if (m.role === "tool") {
        throw new Error("OpenAIProvider: 'tool' role messages are not supported yet (no multi-turn loop in F2)");
      }
      return { role: m.role, content: m.content };
    });

    const response = await this.client.chat.completions.create({
      model: request.model,
      messages,
    });

    const choice = response.choices[0];
    return {
      content: choice?.message?.content ?? "",
      tokensUsed: response.usage?.total_tokens ?? 0,
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
    };
  }
}
