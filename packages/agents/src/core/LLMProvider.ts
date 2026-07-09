/**
 * Abstracción sobre el proveedor de LLM (Architecture §6.1). Implementada
 * en F2 (OpenAI) — ver ../providers/openai-provider.ts.
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
  // F2: desglose para CostTracker (input/output tienen precio distinto).
  // Opcionales para no romper la interfaz si un provider no los reporta.
  promptTokens?: number;
  completionTokens?: number;
}

export interface LLMProvider {
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
}
