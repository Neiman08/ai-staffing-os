import { Badge, type BadgeProps } from "@/components/ui/badge";

const ORIGIN_LABELS: Record<string, string> = {
  DEMO_SEED: "Demo",
  MANUAL: "Manual",
  CSV_IMPORT: "CSV",
  EXTERNAL_DISCOVERY: "Descubierta por IA",
  API_PROVIDER: "API externa",
};

const ORIGIN_VARIANTS: Record<string, NonNullable<BadgeProps["variant"]>> = {
  DEMO_SEED: "neutral",
  MANUAL: "neutral",
  CSV_IMPORT: "info",
  EXTERNAL_DISCOVERY: "primary",
  API_PROVIDER: "primary",
};

/**
 * F4.5 (ajuste de transparencia): nunca debe haber duda entre una empresa
 * demo, importada, manual, o descubierta externamente — origin es un enum
 * cerrado (ver companyOriginSchema), nunca se infiere ni se adivina acá.
 */
export function CompanyOriginBadge({ origin, title }: { origin: string; title?: string }) {
  return (
    <Badge variant={ORIGIN_VARIANTS[origin] ?? "neutral"} title={title}>
      {ORIGIN_LABELS[origin] ?? origin}
    </Badge>
  );
}
