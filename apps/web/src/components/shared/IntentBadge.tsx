import { Badge, type BadgeProps } from "@/components/ui/badge";

const INTENT_LABELS: Record<string, string> = {
  INTERESTED: "Interesado",
  VERY_INTERESTED: "Muy interesado",
  CALL_LATER: "Llamar después",
  NO_BUDGET: "Sin presupuesto",
  HAS_PROVIDER: "Ya tiene proveedor",
  NOT_INTERESTED: "No interesado",
  OUT_OF_MARKET: "Fuera de mercado",
};

const INTENT_VARIANTS: Record<string, NonNullable<BadgeProps["variant"]>> = {
  INTERESTED: "success",
  VERY_INTERESTED: "success",
  CALL_LATER: "warning",
  NO_BUDGET: "warning",
  HAS_PROVIDER: "warning",
  NOT_INTERESTED: "danger",
  OUT_OF_MARKET: "danger",
};

/** F4 §15: badge de una de las 7 categorías cerradas de intención — nunca inventa una nueva. */
export function IntentBadge({ intent }: { intent: string | null }) {
  if (!intent) return <Badge variant="neutral">Sin clasificar</Badge>;
  return <Badge variant={INTENT_VARIANTS[intent] ?? "neutral"}>{INTENT_LABELS[intent] ?? intent}</Badge>;
}
