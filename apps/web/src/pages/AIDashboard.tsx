import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import type { AiDashboardSummary } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

const chartTooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
};

export default function AIDashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ["ai-dashboard"],
    queryFn: () => apiFetch<AiDashboardSummary>("/ai-dashboard/summary"),
  });

  if (isLoading || !data) {
    return (
      <div>
        <PageHeader title="AI Dashboard" description="Actividad del motor de prospección autónoma" />
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="AI Dashboard" description="Actividad del motor de prospección autónoma (F3)" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Empresas analizadas hoy" value={String(data.companiesAnalyzedToday)} />
        <MetricCard label="Empresas nuevas" value={String(data.newCompaniesToday)} />
        <MetricCard label="Leads creados por IA hoy" value={String(data.leadsCreatedByAiToday)} />
        <MetricCard
          label="Score promedio"
          value={data.averageScore != null ? data.averageScore.toFixed(1) : "—"}
        />
        <MetricCard
          label="Costo IA este mes"
          value={`$${data.costUsdThisMonth.toFixed(4)}`}
          hint={`de $${data.budgetUsd.toFixed(2)} presupuestados`}
        />
        <MetricCard
          label="ROI IA (estimado)"
          value={data.roiEstimate.ratio != null ? `${data.roiEstimate.ratio.toFixed(1)}x` : "—"}
          hint={`$${data.roiEstimate.estimatedRevenueUsd.toLocaleString()} estimado — no es revenue realizado`}
        />
        <MetricCard label="Prospectos pendientes" value={String(data.pendingProspects)} />
        <MetricCard label="Correos pendientes de aprobación" value={String(data.pendingApprovals)} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Empresas por industria</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.companiesByIndustry}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="industryName" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis fontSize={11} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                <RechartsTooltip contentStyle={chartTooltipStyle} />
                <Bar dataKey="count" name="Empresas" fill="hsl(255 92% 62%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Mapa de oportunidades (por estado)</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.companiesByState}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="state" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis fontSize={11} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                <RechartsTooltip contentStyle={chartTooltipStyle} />
                <Bar dataKey="count" name="Empresas" fill="hsl(255 92% 62% / 0.6)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
