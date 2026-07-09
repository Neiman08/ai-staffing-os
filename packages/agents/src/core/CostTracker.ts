/**
 * F2 §16: control de costos. Tabla de precios por modelo — mantenerla acá
 * (no en apps/api) preserva "aislado, extraíble" (Architecture §1.1): el
 * costo de una llamada es una propiedad del proveedor de LLM, no del
 * negocio de staffing.
 */
export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
};

export const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * Costo exacto cuando se conoce el desglose prompt/completion tokens.
 */
export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL]!;
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPerMillionUsd;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPerMillionUsd;
  return inputCost + outputCost;
}

/**
 * Aproximación cuando solo se conoce el total de tokens (blend input/output).
 * Se usa como fallback — preferir siempre estimateCostUsd() con el desglose real.
 */
export function estimateCostUsdBlended(model: string, totalTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL]!;
  const blendedPerMillion = (pricing.inputPerMillionUsd + pricing.outputPerMillionUsd) / 2;
  return (totalTokens / 1_000_000) * blendedPerMillion;
}
