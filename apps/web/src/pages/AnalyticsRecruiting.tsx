import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, UserCheck, ListChecks, Briefcase, Clock } from "lucide-react";
import type { RecruitingMetrics } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { downloadFile } from "@/lib/download";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatCard } from "@/components/shared/StatCard";
import { AnalyticsPeriodFilter } from "@/components/analytics/AnalyticsPeriodFilter";
import { ComparisonBadge } from "@/components/analytics/ComparisonBadge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function buildQuery(from: string, to: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export default function AnalyticsRecruiting() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exporting, setExporting] = useState(false);
  const qs = buildQuery(from, to);

  const { data, isLoading } = useQuery({
    queryKey: ["analytics-recruiting", from, to],
    queryFn: () => apiFetch<RecruitingMetrics>(`/analytics/recruiting${qs}`),
  });

  async function handleExport() {
    setExporting(true);
    try {
      await downloadFile(`/analytics/recruiting/export${qs}`, "recruiting-metrics.csv");
    } finally {
      setExporting(false);
    }
  }

  const r = data?.recruiting;
  const hasNothing = !isLoading && !r?.funnel && !r?.sourceEffectiveness;

  return (
    <div>
      <PageHeader title="Recruiting Metrics" description="Funnel, time-to-fill and source effectiveness — real counts, no forecasting." />
      <AnalyticsPeriodFilter from={from} to={to} onFromChange={setFrom} onToChange={setTo} onExport={handleExport} exporting={exporting} />

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {hasNothing && (
        <p className="rounded-lg border border-border bg-card/40 p-4 text-sm text-muted-foreground">
          No recruiting metrics available for your current role permissions.
        </p>
      )}

      {r?.funnel && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={Users} label="Sourced" value={String(r.funnel.sourced)} accent="primary" />
            <StatCard icon={UserCheck} label="Qualified" value={String(r.funnel.qualified)} accent="primary" />
            <StatCard icon={ListChecks} label="Shortlisted" value={String(r.funnel.shortlisted)} accent="primary" />
            <StatCard icon={Briefcase} label="Placed" value={String(r.funnel.placed)} accent="emerald" />
          </div>
          {r.funnelComparison && (
            <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-4">
              <ComparisonBadge comparison={r.funnelComparison.sourced} />
              <ComparisonBadge comparison={r.funnelComparison.qualified} />
              <ComparisonBadge comparison={r.funnelComparison.shortlisted} />
              <ComparisonBadge comparison={r.funnelComparison.placed} />
            </div>
          )}
        </>
      )}

      {r?.timeToFill && (
        <Card className="mt-4">
          <CardContent className="flex items-center gap-3 p-4">
            <Clock className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">
                {r.timeToFill.averageDays === null ? "No Job Orders filled in this period" : `${r.timeToFill.averageDays} days average time-to-fill`}
              </div>
              <div className="text-xs text-muted-foreground">{r.timeToFill.jobOrdersFilled} Job Order(s) filled</div>
            </div>
          </CardContent>
        </Card>
      )}

      {r?.sourceEffectiveness && r.sourceEffectiveness.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-sm">Source Effectiveness</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-4">Source</th>
                  <th className="pb-2 pr-4">Candidates</th>
                  <th className="pb-2 pr-4">Placed</th>
                  <th className="pb-2">Placement Rate</th>
                </tr>
              </thead>
              <tbody>
                {r.sourceEffectiveness.map((entry) => (
                  <tr key={entry.source} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-4">{entry.source}</td>
                    <td className="py-2 pr-4 tabular-nums">{entry.candidateCount}</td>
                    <td className="py-2 pr-4 tabular-nums">{entry.placedCount}</td>
                    <td className="py-2 tabular-nums">{entry.placementRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
