import { DEFAULT_MODEL, estimateCostUsd, estimateCostUsdBlended, type LLMCompletionResult } from "@ai-staffing-os/agents";

/**
 * F2 §16: accumulates tokens/cost across every LLM call made while
 * executing a single AgentTask. A fresh instance is created per task
 * (see task-runner.ts) so it never leaks usage between tasks.
 */
export class UsageAccumulator {
  tokensUsed = 0;
  costUsd = 0;

  record(result: LLMCompletionResult, model: string = DEFAULT_MODEL): void {
    this.tokensUsed += result.tokensUsed;
    this.costUsd +=
      result.promptTokens != null && result.completionTokens != null
        ? estimateCostUsd(model, result.promptTokens, result.completionTokens)
        : estimateCostUsdBlended(model, result.tokensUsed);
  }

  /**
   * F4.5: costo real de un proveedor de datos (Google Places), no de un
   * LLM — no suma tokens, solo dinero. Se persiste en el mismo
   * AgentTask.costUsd (una tarea puede gastar plata sin gastar tokens);
   * getDataProviderBudgetStatus la lee filtrando por type=discover_companies
   * para no mezclarla con el presupuesto de IA.
   */
  recordExternalCost(amountUsd: number): void {
    this.costUsd += amountUsd;
  }
}
