import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trophy, XCircle, Clock, Percent } from "lucide-react";
import type { CommercialMetrics } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { downloadFile } from "@/lib/download";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatCard } from "@/components/shared/StatCard";
import { AnalyticsPeriodFilter } from "@/components/analytics/AnalyticsPeriodFilter";
import { ComparisonBadge } from "@/components/analytics/ComparisonBadge";

function buildQuery(from: string, to: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export default function AnalyticsCommercial() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exporting, setExporting] = useState(false);
  const qs = buildQuery(from, to);

  const { data, isLoading } = useQuery({
    queryKey: ["analytics-commercial", from, to],
    queryFn: () => apiFetch<CommercialMetrics>(`/analytics/commercial${qs}`),
  });

  async function handleExport() {
    setExporting(true);
    try {
      await downloadFile(`/analytics/commercial/export${qs}`, "commercial-metrics.csv");
    } finally {
      setExporting(false);
    }
  }

  const c = data?.commercial;
  const hasNothing = !isLoading && !c?.winRate && !c?.conversion;

  return (
    <div>
      <PageHeader title="Commercial Metrics" description="Win-rate, sales cycle length and lead conversion — real Opportunity/Lead outcomes." />
      <AnalyticsPeriodFilter from={from} to={to} onFromChange={setFrom} onToChange={setTo} onExport={handleExport} exporting={exporting} />

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {hasNothing && (
        <p className="rounded-lg border border-border bg-card/40 p-4 text-sm text-muted-foreground">
          No commercial metrics available for your current role permissions.
        </p>
      )}

      {c?.winRate && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={Trophy} label="Opportunities Won" value={String(c.winRate.won)} accent="emerald" />
            <StatCard icon={XCircle} label="Opportunities Lost" value={String(c.winRate.lost)} accent="red" />
            <StatCard
              icon={Percent}
              label="Win Rate"
              value={c.winRate.winRatePercent === null ? "—" : `${c.winRate.winRatePercent}%`}
              accent="primary"
            />
            {c.salesCycle && (
              <StatCard
                icon={Clock}
                label="Avg Sales Cycle"
                value={c.salesCycle.averageDays === null ? "—" : `${c.salesCycle.averageDays}d`}
                hint={`${c.salesCycle.opportunitiesWon} won`}
                accent="primary"
              />
            )}
          </div>
          {c.comparison && (
            <div className="mt-2 flex flex-wrap gap-4">
              {c.comparison.opportunitiesWon && <ComparisonBadge comparison={c.comparison.opportunitiesWon} />}
              {c.comparison.opportunitiesLost && <ComparisonBadge comparison={c.comparison.opportunitiesLost} />}
            </div>
          )}
        </>
      )}

      {c?.conversion && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <StatCard
            icon={Percent}
            label="Lead Conversion Rate"
            value={c.conversion.leadConversionRate === null ? "—" : `${c.conversion.leadConversionRate}%`}
            accent="primary"
          />
          {c.conversion.leadToOpportunityRate !== undefined && (
            <StatCard
              icon={Percent}
              label="Lead → Opportunity Rate"
              value={c.conversion.leadToOpportunityRate === null ? "—" : `${c.conversion.leadToOpportunityRate}%`}
              hint="Company-level proxy (no direct leadId on Opportunity)"
              accent="primary"
            />
          )}
        </div>
      )}
      {c?.comparison && (c.comparison.leadsCreated || c.comparison.leadsConverted) && (
        <div className="mt-2 flex flex-wrap gap-4">
          {c.comparison.leadsCreated && <ComparisonBadge comparison={c.comparison.leadsCreated} />}
          {c.comparison.leadsConverted && <ComparisonBadge comparison={c.comparison.leadsConverted} />}
        </div>
      )}
    </div>
  );
}
