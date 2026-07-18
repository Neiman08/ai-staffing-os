import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PeriodComparison } from "@ai-staffing-os/shared";

/**
 * F11.9: refleja exactamente lo que el backend ya calculó
 * (comparePeriods() en core/analytics/period.ts) -- nunca reinterpreta
 * el signo o inventa un "sin cambios" cuando deltaPercent es null (eso
 * significa "sin base real para comparar", no "0% de cambio").
 */
export function ComparisonBadge({ comparison }: { comparison: PeriodComparison }) {
  if (comparison.deltaPercent === null) {
    return <span className="text-xs text-muted-foreground">vs. {comparison.previous} previous period</span>;
  }

  const isUp = comparison.deltaPercent > 0;
  const isFlat = comparison.deltaPercent === 0;
  const Icon = isFlat ? Minus : isUp ? TrendingUp : TrendingDown;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        isFlat ? "text-muted-foreground" : isUp ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {isUp ? "+" : ""}
      {comparison.deltaPercent}% vs. previous ({comparison.previous})
    </span>
  );
}
