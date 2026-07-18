import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { Briefcase, DollarSign, Percent, ShieldAlert, TrendingUp, Users } from "lucide-react";
import type { ExecutiveDashboard } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatCard } from "@/components/shared/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function formatUsd(value: number | string): string {
  return `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * F11.3/F11.9: snapshot ejecutivo cross-dominio -- cada tarjeta se
 * renderiza solo si el bloque/campo correspondiente vino en la
 * respuesta (RBAC de campo, F6.8), nunca un placeholder en 0 para un
 * campo que el rol actual no puede ver. Sin filtros de fecha (a
 * diferencia de las 3 páginas de drill-down) -- es intencionalmente un
 * "ahora mismo", el detalle histórico vive en Recruiting/Commercial/
 * Financial.
 */
export default function AnalyticsExecutive() {
  const { data, isLoading } = useQuery({
    queryKey: ["analytics-executive"],
    queryFn: () => apiFetch<ExecutiveDashboard>("/analytics/executive"),
  });

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Executive Dashboard" description="Recruiting, commercial, operations and financial KPIs, unified." />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const r = data?.recruiting;
  const c = data?.commercial;
  const o = data?.operations;
  const f = data?.financial;

  const hasNothing = !r?.activeWorkers && !c?.pipelineValue && !o?.assignmentsByStatus && !f?.weeklyGrossMargin;

  return (
    <div>
      <PageHeader
        title="Executive Dashboard"
        description={data ? `Generated at ${new Date(data.generatedAt).toLocaleString()}` : "Recruiting, commercial, operations and financial KPIs, unified."}
      />

      {hasNothing && (
        <p className="rounded-lg border border-border bg-card/40 p-4 text-sm text-muted-foreground">
          No metrics available for your current role permissions.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {r?.activeWorkers !== undefined && <StatCard icon={Users} label="Active Workers" value={String(r.activeWorkers)} accent="primary" />}
        {r?.openJobOrders !== undefined && <StatCard icon={Briefcase} label="Open Job Orders" value={String(r.openJobOrders)} accent="primary" />}
        {r?.fillRate !== undefined && <StatCard icon={Percent} label="Fill Rate" value={`${(r.fillRate * 100).toFixed(0)}%`} accent="emerald" />}
        {c?.pipelineValue !== undefined && <StatCard icon={TrendingUp} label="Pipeline Value" value={formatUsd(c.pipelineValue)} accent="emerald" />}
        {c?.openOpportunities !== undefined && <StatCard icon={TrendingUp} label="Open Opportunities" value={String(c.openOpportunities)} accent="primary" />}
        {c?.newLeadsThisWeek !== undefined && <StatCard icon={Users} label="New Leads (7d)" value={String(c.newLeadsThisWeek)} accent="primary" />}
        {o?.unresolvedComplianceAlerts !== undefined && (
          <StatCard icon={ShieldAlert} label="Unresolved Compliance Alerts" value={String(o.unresolvedComplianceAlerts)} accent={o.unresolvedComplianceAlerts > 0 ? "amber" : "emerald"} />
        )}
        {o?.openIncidentCount !== undefined && (
          <StatCard icon={ShieldAlert} label="Open Incidents" value={String(o.openIncidentCount)} accent={o.openIncidentCount > 0 ? "amber" : "emerald"} />
        )}
        {f?.weeklyGrossMargin !== undefined && <StatCard icon={DollarSign} label="Weekly Gross Margin" value={formatUsd(f.weeklyGrossMargin)} accent="emerald" />}
        {f?.billableRevenuePeriod !== undefined && <StatCard icon={DollarSign} label="Billable Revenue (7d)" value={formatUsd(f.billableRevenuePeriod)} accent="emerald" />}
      </div>

      {f?.dailySeries && f.dailySeries.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-sm">Hours & Margin (14d)</CardTitle>
          </CardHeader>
          <CardContent className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={f.dailySeries}>
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

      <div className="mt-6 flex flex-wrap gap-3 text-sm">
        <Link to="/analytics/recruiting" className="text-primary hover:underline">
          Recruiting metrics →
        </Link>
        <Link to="/analytics/commercial" className="text-primary hover:underline">
          Commercial metrics →
        </Link>
        <Link to="/analytics/financial" className="text-primary hover:underline">
          Financial metrics →
        </Link>
      </div>
    </div>
  );
}
