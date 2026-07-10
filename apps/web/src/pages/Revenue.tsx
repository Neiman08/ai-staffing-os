import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import {
  Briefcase,
  Building2,
  CalendarClock,
  DollarSign,
  ListTodo,
  Percent,
  Sparkles,
  Target,
  TrendingUp,
  Trophy,
  Users,
} from "lucide-react";
import type {
  AiDashboardSummary,
  CompanyListItem,
  LeadListItem,
  OpportunityListItem,
  Paginated,
  RevenueIntelligence,
  RevenueSummary,
} from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatCard } from "@/components/shared/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";

const WON_STAGE = "WON";
const LOST_STAGE = "LOST";

function isWithinDays(dateStr: string, days: number): boolean {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(dateStr).getTime() >= cutoff;
}

function sumEstimatedRevenue(opportunities: OpportunityListItem[]): number {
  return opportunities.reduce((sum, o) => sum + (o.estimatedRevenue ? Number(o.estimatedRevenue) : 0), 0);
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * F3.5: panel ejecutivo de "revenue impulsado por IA" — todo derivado
 * client-side de ventanas acotadas (limit=100) de endpoints ya
 * existentes (/opportunities, /leads, /companies, /ai-dashboard/summary).
 * No hay endpoints nuevos ni datos inventados.
 */
function AiRevenuePanel() {
  const { data: revenueSummary } = useQuery({
    queryKey: ["revenue", "summary"],
    queryFn: () => apiFetch<RevenueSummary>("/revenue/summary"),
  });

  const { data: aiSummary } = useQuery({
    queryKey: ["ai-dashboard"],
    queryFn: () => apiFetch<AiDashboardSummary>("/ai-dashboard/summary"),
    refetchInterval: 5000,
  });

  const { data: opportunities } = useQuery({
    queryKey: ["opportunities", "revenue-panel"],
    queryFn: () => apiFetch<Paginated<OpportunityListItem>>("/opportunities?limit=100"),
  });

  const { data: leads } = useQuery({
    queryKey: ["leads", "revenue-panel"],
    queryFn: () => apiFetch<Paginated<LeadListItem>>("/leads?limit=100"),
  });

  const { data: companies } = useQuery({
    queryKey: ["companies", "revenue-panel"],
    queryFn: () => apiFetch<Paginated<CompanyListItem>>("/companies?limit=100"),
  });

  if (!aiSummary || !opportunities || !leads || !companies || !revenueSummary) {
    return <p className="text-sm text-muted-foreground">Cargando panel de IA…</p>;
  }

  const won = opportunities.items.filter((o) => o.stage === WON_STAGE);
  const lost = opportunities.items.filter((o) => o.stage === LOST_STAGE);
  const revenueTotal = sumEstimatedRevenue(won);
  const revenueAi = sumEstimatedRevenue(won.filter((o) => o.createdByAgentTaskId != null));
  const conversionRate = won.length + lost.length > 0 ? (won.length / (won.length + lost.length)) * 100 : null;

  const aiLeadsCount = leads.items.filter((l) => l.createdByAgentTaskId != null).length;
  const aiOpportunitiesCount = opportunities.items.filter((o) => o.createdByAgentTaskId != null).length;
  const totalClients = companies.items.filter((c) => c.status === "CLIENT").length;
  const newCompanies = companies.items.filter((c) => isWithinDays(c.createdAt, 7)).length;
  const newClients = companies.items.filter((c) => c.status === "CLIENT" && isWithinDays(c.createdAt, 7)).length;

  const costThisMonth = aiSummary.costUsdThisMonth;
  const costPerLead = aiLeadsCount > 0 ? costThisMonth / aiLeadsCount : null;
  const costPerOpportunity = aiOpportunitiesCount > 0 ? costThisMonth / aiOpportunitiesCount : null;
  const costPerClient = totalClients > 0 ? costThisMonth / totalClients : null;

  return (
    <div className="rounded-xl border border-primary/20 bg-gradient-to-br from-primary/5 via-transparent to-transparent p-5">
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Revenue impulsado por IA</h2>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={DollarSign}
          label="Revenue total"
          value={formatUsd(revenueTotal)}
          hint="Oportunidades ganadas"
          accent="emerald"
        />
        <StatCard
          icon={Sparkles}
          label="Revenue por IA"
          value={formatUsd(revenueAi)}
          hint="Ganadas, creadas por IA"
          accent="primary"
        />
        <StatCard
          icon={Briefcase}
          label="Pipeline"
          value={formatUsd(Number(revenueSummary.pipelineValue))}
          hint={`${revenueSummary.openOpportunities} abiertas`}
          accent="primary"
        />
        <StatCard
          icon={Percent}
          label="Conversión"
          value={conversionRate != null ? `${conversionRate.toFixed(0)}%` : "—"}
          hint="Ganadas / (ganadas + perdidas)"
          accent="primary"
        />
        <StatCard icon={Building2} label="Empresas nuevas" value={String(newCompanies)} hint="Últimos 7 días" />
        <StatCard icon={Users} label="Clientes nuevos" value={String(newClients)} hint="Últimos 7 días" />
        <StatCard
          icon={Target}
          label="Leads IA"
          value={String(aiSummary.leadsCreatedByAiToday)}
          hint="Creados hoy"
          accent="primary"
        />
        <StatCard
          icon={Trophy}
          label="ROI IA (est.)"
          value={aiSummary.roiEstimate.ratio != null ? `${aiSummary.roiEstimate.ratio.toFixed(1)}x` : "—"}
          accent="emerald"
        />
        <StatCard
          icon={DollarSign}
          label="Costo IA (mes)"
          value={`$${costThisMonth.toFixed(4)}`}
          hint={`de $${aiSummary.budgetUsd.toFixed(2)}`}
          accent="amber"
        />
        <StatCard
          icon={DollarSign}
          label="Costo por lead"
          value={costPerLead != null ? `$${costPerLead.toFixed(4)}` : "—"}
          hint="Estimado"
        />
        <StatCard
          icon={DollarSign}
          label="Costo/oportunidad"
          value={costPerOpportunity != null ? `$${costPerOpportunity.toFixed(4)}` : "—"}
          hint="Estimado"
        />
        <StatCard
          icon={DollarSign}
          label="Costo por cliente"
          value={costPerClient != null ? `$${costPerClient.toFixed(4)}` : "—"}
          hint="Estimado"
        />
      </div>
    </div>
  );
}

export default function Revenue() {
  const { data: summary, isLoading: loadingSummary } = useQuery({
    queryKey: ["revenue", "summary"],
    queryFn: () => apiFetch<RevenueSummary>("/revenue/summary"),
  });

  const { data: intelligence, isLoading: loadingIntelligence } = useQuery({
    queryKey: ["revenue", "intelligence"],
    queryFn: () => apiFetch<RevenueIntelligence>("/revenue/intelligence"),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Revenue" description="Sales dashboard y revenue intelligence" />

      <AiRevenuePanel />

      <h2 className="text-sm font-semibold text-muted-foreground">Operaciones comerciales</h2>

      {loadingSummary || !summary ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatCard icon={Users} label="Leads nuevos" value={summary.newLeadsThisWeek.toString()} hint="Últimos 7 días" />
            <StatCard icon={Building2} label="Contactadas" value={summary.companiesContacted.toString()} hint="Últimos 30 días" />
            <StatCard icon={ListTodo} label="Follow-ups" value={summary.pendingFollowUps.toString()} hint="Pendientes" />
            <StatCard
              icon={Briefcase}
              label="Oport. abiertas"
              value={summary.openOpportunities.toString()}
              hint={`$${Number(summary.pipelineValue).toLocaleString()} en pipeline`}
            />
            <StatCard icon={CalendarClock} label="Reuniones" value={summary.scheduledMeetings.toString()} hint="Programadas" />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="card-hover">
              <CardHeader>
                <CardTitle>Clientes por industria</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {summary.companiesByIndustry.map((i) => (
                  <div key={i.industryName} className="flex items-center justify-between">
                    <span>{i.industryName}</span>
                    <span className="font-medium">{i.count}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card className="card-hover">
              <CardHeader>
                <CardTitle>Clientes por estado</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {summary.companiesByState.length ? (
                  summary.companiesByState.map((s) => (
                    <div key={s.state} className="flex items-center justify-between">
                      <span>{s.state}</span>
                      <span className="font-medium">{s.count}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground">Sin datos de estado todavía.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <div className="flex items-center gap-2 pt-2">
        <TrendingUp className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Revenue Intelligence</h2>
      </div>

      {loadingIntelligence || !intelligence ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="card-hover">
            <CardHeader>
              <CardTitle>Pipeline por etapa</CardTitle>
            </CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={intelligence.pipelineByStage.map((s) => ({
                    stage: s.stage,
                    totalValue: Number(s.totalValue),
                    weightedValue: Number(s.weightedValue),
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                  <XAxis
                    dataKey="stage"
                    tickFormatter={(v: string) => formatStatusLabel(v)}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={48}
                    tickFormatter={(v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)}
                  />
                  <RechartsTooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(value: number) => `$${value.toLocaleString()}`}
                  />
                  <Bar dataKey="totalValue" name="Valor total" fill="hsl(255 92% 62%)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="weightedValue" name="Valor ponderado" fill="hsl(255 92% 62% / 0.4)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="card-hover">
            <CardHeader>
              <CardTitle>Oportunidades más grandes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {intelligence.biggestOpportunities.length ? (
                intelligence.biggestOpportunities.map((o) => (
                  <div key={o.id} className="flex items-center justify-between border-b border-border pb-2 last:border-0">
                    <div>
                      <div className="font-medium">{o.title}</div>
                      <div className="text-xs text-muted-foreground">{o.companyName}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">{o.estimatedRevenue ? `$${Number(o.estimatedRevenue).toLocaleString()}` : "—"}</div>
                      <Badge variant={statusVariant(o.stage)}>{formatStatusLabel(o.stage)}</Badge>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">Sin oportunidades abiertas.</p>
              )}
            </CardContent>
          </Card>

          <Card className="card-hover">
            <CardHeader>
              <CardTitle>Mejores industrias (won)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {intelligence.topIndustries.length ? (
                intelligence.topIndustries.map((i) => (
                  <div key={i.industryName} className="flex items-center justify-between">
                    <span>{i.industryName}</span>
                    <span className="font-medium">${Number(i.wonRevenue).toLocaleString()}</span>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">Sin oportunidades ganadas todavía.</p>
              )}
            </CardContent>
          </Card>

          <Card className="card-hover">
            <CardHeader>
              <CardTitle>Mejores estados (won)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {intelligence.topStates.length ? (
                intelligence.topStates.map((s) => (
                  <div key={s.state} className="flex items-center justify-between">
                    <span>{s.state}</span>
                    <span className="font-medium">${Number(s.wonRevenue).toLocaleString()}</span>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">Sin oportunidades ganadas todavía.</p>
              )}
            </CardContent>
          </Card>

          <Card className="card-hover">
            <CardHeader>
              <CardTitle>Leads sin seguimiento</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {intelligence.leadsWithoutFollowUp.length ? (
                intelligence.leadsWithoutFollowUp.map((l) => (
                  <div key={l.id} className="flex items-center justify-between">
                    <span>{l.companyName ?? "Sin empresa"}</span>
                    <Badge variant="warning">{l.daysSinceLastActivity}d</Badge>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">Todos los leads tienen seguimiento.</p>
              )}
            </CardContent>
          </Card>

          <Card className="card-hover">
            <CardHeader>
              <CardTitle>Clientes dormidos</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {intelligence.dormantClients.length ? (
                intelligence.dormantClients.map((c) => (
                  <div key={c.id} className="flex items-center justify-between">
                    <span>{c.name}</span>
                    <Badge variant="danger">{c.daysSinceLastActivity}d sin contacto</Badge>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">Ningún cliente dormido.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
