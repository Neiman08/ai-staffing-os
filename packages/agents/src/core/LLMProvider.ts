/**
 * Abstracción sobre el proveedor de LLM (Architecture §6.1). Sin
 * implementación en F0 — se implementa en F3 (OpenAI hoy, otros mañana).
 */
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LLMCompletionRequest {
  model: string;
  messages: LLMMessage[];
  tools?: unknown[];
}

export interface LLMCompletionResult {
  content: string;
  toolCalls?: unknown[];
  tokensUsed: number;
}

export interface LLMProvider {
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
}
