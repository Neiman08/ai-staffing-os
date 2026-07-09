import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, Briefcase, DollarSign, Users } from "lucide-react";
import type { AuditLogItem, DashboardSummary } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatCard } from "@/components/shared/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatStatusLabel, statusVariant } from "@/lib/status";

export default function Dashboard() {
  const { data: summary, isLoading } = useQuery({
    queryKey: ["dashboard", "summary"],
    queryFn: () => apiFetch<DashboardSummary>("/dashboard/summary"),
  });

  const { data: auditLog } = useQuery({
    queryKey: ["dashboard", "audit-log"],
    queryFn: () => apiFetch<AuditLogItem[]>("/dashboard/audit-log"),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="Vista general del tenant" />

      {isLoading || !summary ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon={Users} label="Trabajadores activos" value={summary.activeWorkers.toString()} />
          <StatCard
            icon={Briefcase}
            label="Job orders abiertas"
            value={summary.openJobOrders.toString()}
            hint={`Fill rate: ${(summary.fillRate * 100).toFixed(0)}%`}
          />
          <StatCard
            icon={AlertTriangle}
            label="Alertas de compliance"
            value={summary.unresolvedComplianceAlerts.toString()}
            hint="Sin resolver"
          />
          <StatCard
            icon={DollarSign}
            label="Margen bruto (7 días)"
            value={`$${summary.weeklyGrossMargin.toLocaleString()}`}
            hint={`${summary.weeklyHours}h · $${summary.billableRevenuePeriod.toLocaleString()} facturable`}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Horas y margen — últimos 14 días</CardTitle>
          </CardHeader>
          <CardContent className="h-72 pt-2">
            {summary && (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={summary.dailySeries}>
                  <defs>
                    <linearGradient id="marginGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(255 92% 62%)" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="hsl(255 92% 62%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(v: string) => v.slice(5)}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis fontSize={11} tickLine={false} axisLine={false} width={36} />
                  <RechartsTooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="margin"
                    name="Margen ($)"
                    stroke="hsl(255 92% 62%)"
                    fill="url(#marginGradient)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Alertas recientes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {summary?.recentAlerts.length ? (
              summary.recentAlerts.map((alert) => (
                <div key={alert.id} className="flex items-start justify-between gap-2 text-sm">
                  <div>
                    <div className="font-medium">{formatStatusLabel(alert.type)}</div>
                    <div className="text-xs text-muted-foreground">{alert.message}</div>
                  </div>
                  <Badge variant={statusVariant(alert.severity)}>{formatStatusLabel(alert.severity)}</Badge>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Sin alertas pendientes.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Actividad reciente</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {auditLog?.length ? (
            auditLog.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0">
                <div>
                  <span className="font-medium">{entry.actorLabel}</span>{" "}
                  <span className="text-muted-foreground">{entry.action}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">Sin actividad reciente.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
