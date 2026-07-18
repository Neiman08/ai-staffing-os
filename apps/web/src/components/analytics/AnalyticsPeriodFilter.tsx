import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface AnalyticsPeriodFilterProps {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onExport: () => void;
  exporting: boolean;
}

/**
 * F11.9: filtro compartido por las 3 páginas de drill-down (Recruiting/
 * Commercial/Financial) -- from/to vacíos significan "sin filtrar" (el
 * backend aplica su propio default por dominio, ver
 * core/analytics/period.ts:resolvePeriod), nunca un rango inventado acá
 * para forzar un valor inicial.
 */
export function AnalyticsPeriodFilter({ from, to, onFromChange, onToChange, onExport, exporting }: AnalyticsPeriodFilterProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card/40 p-3">
      <div>
        <label htmlFor="analytics-from" className="mb-1 block text-xs font-medium text-muted-foreground">
          From
        </label>
        <Input id="analytics-from" type="date" value={from} onChange={(e) => onFromChange(e.target.value)} className="w-40" />
      </div>
      <div>
        <label htmlFor="analytics-to" className="mb-1 block text-xs font-medium text-muted-foreground">
          To
        </label>
        <Input id="analytics-to" type="date" value={to} onChange={(e) => onToChange(e.target.value)} className="w-40" />
      </div>
      {(from || to) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onFromChange("");
            onToChange("");
          }}
        >
          Clear
        </Button>
      )}
      <div className="ml-auto">
        <Button type="button" variant="outline" size="sm" onClick={onExport} disabled={exporting}>
          <Download className="h-3.5 w-3.5" />
          {exporting ? "Exporting…" : "Export CSV"}
        </Button>
      </div>
    </div>
  );
}
