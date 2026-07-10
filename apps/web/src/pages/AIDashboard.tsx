import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { Activity, Bot, Coins, Gauge, Wrench, Zap } from "lucide-react";
import type {
  AgentInstanceListItem,
  AiDashboardSummary,
  AuditLogItem,
  CompanyListItem,
  Paginated,
  RevenueIntelligence,
} from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { useAgentTasksByInstance } from "@/lib/useAgentTaskStats";
import { averageDurationMs, countCompletedInLastHour, formatDuration, formatTaskType, timeAgo } from "@/lib/agentTaskStats";

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="card-hover">
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
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

export default function AIDashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ["ai-dashboard"],
    queryFn: () => apiFetch<AiDashboardSummary>("/ai-dashboard/summary"),
    refetchInterval: 5000,
  });

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiFetch<AgentInstanceListItem[]>("/agents"),
    refetchInterval: 5000,
  });
  const tasksByAgent = useAgentTasksByInstance((agents ?? []).map((a) => a.id));

  const { data: auditLog } = useQuery({
    queryKey: ["dashboard", "audit-log"],
    queryFn: () => apiFetch<AuditLogItem[]>("/dashboard/audit-log"),
    refetchInterval: 5000,
  });

  const { data: intelligence } = useQuery({
    queryKey: ["revenue", "intelligence"],
    queryFn: () => apiFetch<RevenueIntelligence>("/revenue/intelligence"),
  });

  const { data: companies } = useQuery({
    queryKey: ["companies", "top-score"],
    queryFn: () => apiFetch<Paginated<CompanyListItem>>("/companies?limit=100"),
  });

  if (isLoading || !data) {
    return (
      <div>
        <PageHeader title="AI Dashboard" description="El centro del producto — todo lo que hacen los agentes" />
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </div>
    );
  }

  const allTasks = [...tasksByAgent.values()].flat();
  const agentActivity = (auditLog ?? []).filter((e) => e.actorType === "AGENT");

  const toolUsage = new Map<string, number>();
  for (const t of allTasks) toolUsage.set(t.type, (toolUsage.get(t.type) ?? 0) + 1);
  const sortedTools = [...toolUsage.entries()].sort((a, b) => b[1] - a[1]);

  const totalTokensAll = allTasks.reduce((sum, t) => sum + (t.tokensUsed ?? 0), 0);
  const avgMs = averageDurationMs(allTasks);

  const tasksLastHour = countCompletedInLastHour(allTasks);

  const topAgents = (agents ?? [])
    .map((a) => {
      const metrics = a.metrics as { tasksCompleted?: number; costUsdThisMonth?: number };
      return {
        ...a,
        taskCount: (tasksByAgent.get(a.id) ?? []).length,
        cost: metrics?.costUsdThisMonth ?? 0,
        tasksCompleted: metrics?.tasksCompleted ?? 0,
      };
    })
    .filter((a) => a.tasksCompleted > 0)
    .sort((a, b) => b.tasksCompleted - a.tasksCompleted)
    .slice(0, 5);

  const topScoredCompanies = [...(companies?.items ?? [])]
    .filter((c) => c.commercialScore != null)
    .sort((a, b) => (b.commercialScore ?? 0) - (a.commercialScore ?? 0))
    .slice(0, 6);

  return (
    <div>
      <PageHeader title="AI Dashboard" description="El centro del producto — todo lo que hacen los agentes, con datos reales" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Empresas analizadas hoy" value={String(data.companiesAnalyzedToday)} />
        <MetricCard label="Empresas nuevas" value={String(data.newCompaniesToday)} />
        <MetricCard label="Leads creados por IA hoy" value={String(data.leadsCreatedByAiToday)} />
        <MetricCard label="Score promedio" value={data.averageScore != null ? data.averageScore.toFixed(1) : "—"} />
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

      {/* F3.5: profundidad operativa de los agentes — tokens, costo, velocidad, tools */}
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Tokens usados (reciente)" value={totalTokensAll.toLocaleString()} hint={`${allTasks.length} tareas consideradas`} />
        <MetricCard
          label="Tiempo promedio de respuesta"
          value={avgMs != null ? formatDuration(avgMs) : "—"}
        />
        <MetricCard label="Tareas completadas (última hora)" value={String(tasksLastHour)} />
        <MetricCard label="Herramientas distintas usadas" value={String(sortedTools.length)} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="card-hover">
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

        <Card className="card-hover">
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

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="card-hover">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Timeline de decisiones
            </CardTitle>
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
              <p className="text-sm text-muted-foreground">Sin decisiones registradas todavía.</p>
            )}
          </CardContent>
        </Card>

        <Card className="card-hover">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="h-4 w-4" />
              Herramientas utilizadas
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {sortedTools.length ? (
              sortedTools.map(([type, count]) => (
                <div key={type} className="flex items-center justify-between text-sm">
                  <span>{formatTaskType(type)}</span>
                  <Badge variant="neutral">{count}</Badge>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Sin tareas registradas todavía.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="card-hover">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-4 w-4" />
              Top agentes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {topAgents.length ? (
              topAgents.map((a) => (
                <div key={a.id} className="flex items-center justify-between text-sm">
                  <div>
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-muted-foreground">{a.tasksCompleted} tareas · ${a.cost.toFixed(4)}</div>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Sin actividad todavía.</p>
            )}
          </CardContent>
        </Card>

        <Card className="card-hover">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Top industrias (won)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {intelligence?.topIndustries.length ? (
              intelligence.topIndustries.map((i) => (
                <div key={i.industryName} className="flex items-center justify-between text-sm">
                  <span>{i.industryName}</span>
                  <span className="font-medium">${Number(i.wonRevenue).toLocaleString()}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Sin oportunidades ganadas todavía.</p>
            )}
          </CardContent>
        </Card>

        <Card className="card-hover">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Coins className="h-4 w-4" />
              Top oportunidades
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {intelligence?.biggestOpportunities.length ? (
              intelligence.biggestOpportunities.slice(0, 5).map((o) => (
                <div key={o.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{o.title}</span>
                  <Badge variant={statusVariant(o.stage)}>{formatStatusLabel(o.stage)}</Badge>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Sin oportunidades abiertas.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4 card-hover">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="h-4 w-4" />
            Top empresas por score
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {topScoredCompanies.length ? (
            topScoredCompanies.map((c) => (
              <Link
                key={c.id}
                to={`/companies/${c.id}`}
                className="flex items-center justify-between rounded-md border border-border p-3 text-sm hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">{c.industryName}</div>
                </div>
                <Badge variant="primary">{c.commercialScore}</Badge>
              </Link>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">Todavía no hay empresas calificadas.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
