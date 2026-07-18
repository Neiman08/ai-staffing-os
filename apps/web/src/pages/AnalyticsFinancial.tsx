import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { DollarSign, Clock, Wallet, Receipt } from "lucide-react";
import type { FinancialMetrics } from "@ai-staffing-os/shared";
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

function formatUsd(value: string): string {
  return `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default function AnalyticsFinancial() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exporting, setExporting] = useState(false);
  const qs = buildQuery(from, to);

  const { data, isLoading } = useQuery({
    queryKey: ["analytics-financial", from, to],
    queryFn: () => apiFetch<FinancialMetrics>(`/analytics/financial${qs}`),
  });

  async function handleExport() {
    setExporting(true);
    try {
      await downloadFile(`/analytics/financial/export${qs}`, "financial-metrics.csv");
    } finally {
      setExporting(false);
    }
  }

  const f = data?.financial;
  const hasNothing = !isLoading && !f?.marginTrend && !f?.invoiceAging && !f?.payrollCost;

  return (
    <div>
      <PageHeader title="Financial Metrics" description="Margin trend, invoice aging and payroll cost — real figures, no projections." />
      <AnalyticsPeriodFilter from={from} to={to} onFromChange={setFrom} onToChange={setTo} onExport={handleExport} exporting={exporting} />

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {hasNothing && (
        <p className="rounded-lg border border-border bg-card/40 p-4 text-sm text-muted-foreground">
          No financial metrics available for your current role permissions.
        </p>
      )}

      {f?.comparison && (
        <div className="mb-2 flex flex-wrap gap-4">
          <ComparisonBadge comparison={f.comparison.totalHours} />
          <ComparisonBadge comparison={f.comparison.totalMargin} />
        </div>
      )}

      {f?.marginTrend && f.marginTrend.length > 0 && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-sm">Margin Trend</CardTitle>
          </CardHeader>
          <CardContent className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={f.marginTrend}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis tick={{ fontSize: 11 }} />
                <RechartsTooltip />
                <Bar dataKey="margin" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
      {f?.marginTrend && f.marginTrend.length === 0 && (
        <p className="mb-4 rounded-lg border border-border bg-card/40 p-4 text-sm text-muted-foreground">
          No TimeEntry activity in this period.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {f?.invoiceAging && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Receipt className="h-4 w-4" /> Invoice Aging
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Current (0-30d)</span>
                <span className="tabular-nums">{formatUsd(f.invoiceAging.current)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">31-60d</span>
                <span className="tabular-nums">{formatUsd(f.invoiceAging.days31to60)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">61-90d</span>
                <span className="tabular-nums">{formatUsd(f.invoiceAging.days61to90)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">90+d</span>
                <span className="tabular-nums">{formatUsd(f.invoiceAging.over90)}</span>
              </div>
              <div className="mt-2 flex justify-between border-t border-border pt-2 font-medium">
                <span>Total Outstanding</span>
                <span className="tabular-nums">{formatUsd(f.invoiceAging.totalOutstanding)}</span>
              </div>
            </CardContent>
          </Card>
        )}

        {f?.payrollCost && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatCard icon={Wallet} label="Total Gross" value={formatUsd(f.payrollCost.totalGross)} accent="primary" />
            <StatCard icon={DollarSign} label="Total Bill" value={formatUsd(f.payrollCost.totalBill)} accent="primary" />
            <StatCard icon={DollarSign} label="Total Margin" value={formatUsd(f.payrollCost.totalMargin)} accent="emerald" />
            <StatCard icon={Clock} label="Payroll Runs" value={String(f.payrollCost.runsIncluded)} accent="primary" />
          </div>
        )}
      </div>
    </div>
  );
}
