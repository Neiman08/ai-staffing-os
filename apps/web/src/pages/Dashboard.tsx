import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Bot,
  Briefcase,
  CheckSquare,
  DollarSign,
  Mail,
  Rocket,
  Sparkles,
  Trophy,
  Users,
} from "lucide-react";
import type {
  AiDashboardSummary,
  AuditLogItem,
  CompanyListItem,
  DashboardSummary,
  MissionListItem,
  Paginated,
} from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatCard } from "@/components/shared/StatCard";
import { AgentStatusDot } from "@/components/shared/AgentStatusDot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { timeAgo } from "@/lib/agentTaskStats";

const AGENT_ACTION_LABELS: Record<string, string> = {
  "lead.created_by_agent": "creó un lead",
  "company.scored_by_agent": "calificó una empresa",
  "outreach.drafted_by_agent": "preparó un borrador de outreach",
  "opportunity.created_by_agent": "creó una oportunidad",
  "followUp.created_by_agent": "creó un seguimiento",
};

function formatAgentAction(action: string): string {
  return AGENT_ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

export default function Dashboard() {
  const { data: summary, isLoading } = useQuery({
    queryKey: ["dashboard", "summary"],
    queryFn: () => apiFetch<DashboardSummary>("/dashboard/summary"),
  });

  const { data: auditLog } = useQuery({
    queryKey: ["dashboard", "audit-log"],
    queryFn: () => apiFetch<AuditLogItem[]>("/dashboard/audit-log"),
    refetchInterval: 5000,
  });

  const { data: aiSummary } = useQuery({
    queryKey: ["ai-dashboard"],
    queryFn: () => apiFetch<AiDashboardSummary>("/ai-dashboard/summary"),
    refetchInterval: 5000,
  });

  const { data: companies } = useQuery({
    queryKey: ["companies", "top-score"],
    queryFn: () => apiFetch<Paginated<CompanyListItem>>("/companies?limit=100"),
  });

  const { data: missions } = useQuery({
    queryKey: ["missions"],
    queryFn: () => apiFetch<MissionListItem[]>("/missions"),
    refetchInterval: 5000,
  });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todaysMission = missions?.find((m) => new Date(m.createdAt) >= todayStart);

  const agentActivity = (auditLog ?? []).filter((e) => e.actorType === "AGENT").slice(0, 8);
  const topScoredCompanies = [...(companies?.items ?? [])]
    .filter((c) => c.commercialScore != null)
    .sort((a, b) => (b.commercialScore ?? 0) - (a.commercialScore ?? 0))
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="Mission Control — visión general del tenant" />

      {/* F3.5: la IA como protagonista visual — arriba de todo, siempre visible. */}
      <div className="rounded-xl border border-primary/20 bg-gradient-to-br from-primary/5 via-transparent to-transparent p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Actividad de IA</h2>
            {agentActivity.length > 0 && (
              <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                <AgentStatusDot active className="h-1.5 w-1.5" />
                En vivo
              </span>
            )}
          </div>
          <Link to="/ai-dashboard" className="text-xs font-medium text-primary hover:underline">
            Ver AI Dashboard →
          </Link>
        </div>

        <Card className="card-hover mb-4 border-primary/20">
          <CardContent className="p-4">
            {todaysMission ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Rocket className="h-4 w-4 shrink-0 text-primary" />
                    <span className="truncate text-sm font-medium" title={todaysMission.rawInstruction}>
                      {todaysMission.rawInstruction}
                    </span>
                  </div>
                  <Badge
                    variant={
                      todaysMission.missionState === "COMPLETED"
                        ? "success"
                        : todaysMission.missionState === "CANCELLED"
                          ? "neutral"
                          : "info"
                    }
                  >
                    {formatStatusLabel(todaysMission.missionState)}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {todaysMission.objectiveProgress.rawText || "Objetivo de la misión"} —{" "}
                    {todaysMission.objectiveProgress.current}
                    {todaysMission.objectiveProgress.target ? ` / ${todaysMission.objectiveProgress.target}` : ""}{" "}
                    {todaysMission.objectiveProgress.unit}
                  </span>
                  <Link to="/missions" className="font-medium text-primary hover:underline">
                    Ver misión →
                  </Link>
                </div>
                {todaysMission.objectiveProgress.percentComplete != null && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${Math.min(100, todaysMission.objectiveProgress.percentComplete)}%` }}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Rocket className="h-4 w-4 text-primary" />
                  Sin misión lanzada hoy — dale una instrucción diaria al CEO Agent.
                </div>
                <Link to="/missions" className="text-xs font-medium text-primary hover:underline">
                  Lanzar misión →
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {aiSummary && (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatCard icon={Bot} label="Analizadas" value={String(aiSummary.companiesAnalyzedToday)} hint="Hoy" accent="primary" />
            <StatCard icon={Users} label="Leads IA" value={String(aiSummary.leadsCreatedByAiToday)} hint="Hoy" accent="primary" />
            <StatCard
              icon={Trophy}
              label="ROI IA (est.)"
              value={aiSummary.roiEstimate.ratio != null ? `${aiSummary.roiEstimate.ratio.toFixed(1)}x` : "—"}
              accent="emerald"
            />
            <StatCard icon={Mail} label="Correos IA" value={String(aiSummary.pendingApprovals)} hint="Listos" accent="amber" />
            <StatCard
              icon={DollarSign}
              label="Costo IA (mes)"
              value={`$${aiSummary.costUsdThisMonth.toFixed(4)}`}
              hint={`de $${aiSummary.budgetUsd.toFixed(2)}`}
              accent="primary"
            />
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="card-hover">
            <CardHeader>
              <CardTitle>Actividad de agentes en vivo</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {agentActivity.length ? (
                agentActivity.map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between gap-2 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0">🤖</span>
                      <span className="truncate">
                        <span className="font-medium">{entry.actorLabel}</span>{" "}
                        <span className="text-muted-foreground">{formatAgentAction(entry.action)}</span>
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(entry.createdAt)}</span>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">Sin actividad de agentes todavía.</p>
              )}
            </CardContent>
          </Card>

          <Card className="card-hover">
            <CardHeader>
              <CardTitle>Empresas con mayor score</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {topScoredCompanies.length ? (
                topScoredCompanies.map((c) => (
                  <Link
                    key={c.id}
                    to={`/companies/${c.id}`}
                    className="flex items-center justify-between gap-2 text-sm hover:text-primary"
                  >
                    <span className="truncate">{c.name}</span>
                    <Badge variant="primary">{c.commercialScore}</Badge>
                  </Link>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">Todavía no hay empresas calificadas.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Operaciones</h2>

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
              accent={summary.unresolvedComplianceAlerts > 0 ? "amber" : "primary"}
            />
            <StatCard
              icon={DollarSign}
              label="Margen bruto (7 días)"
              value={`$${summary.weeklyGrossMargin.toLocaleString()}`}
              hint={`${summary.weeklyHours}h · $${summary.billableRevenuePeriod.toLocaleString()} facturable`}
              accent="emerald"
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="card-hover lg:col-span-2">
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

        <Card className="card-hover">
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

      <Card className="card-hover">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckSquare className="h-4 w-4" />
            Actividad reciente (todo el tenant)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {auditLog?.length ? (
            auditLog.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0">
                <div className="flex items-center gap-2">
                  {entry.actorType === "AGENT" && <span>🤖</span>}
                  <span className="font-medium">{entry.actorLabel}</span>{" "}
                  <span className="text-muted-foreground">{entry.action}</span>
                </div>
                <span className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
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
