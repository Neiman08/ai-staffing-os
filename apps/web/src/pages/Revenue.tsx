import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { Briefcase, Building2, CalendarClock, ListTodo, TrendingUp, Users } from "lucide-react";
import type { RevenueIntelligence, RevenueSummary } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatCard } from "@/components/shared/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";

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

      {loadingSummary || !summary ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatCard icon={Users} label="Leads nuevos (7 días)" value={summary.newLeadsThisWeek.toString()} />
            <StatCard icon={Building2} label="Empresas contactadas" value={summary.companiesContacted.toString()} hint="Últimos 30 días" />
            <StatCard icon={ListTodo} label="Follow-ups pendientes" value={summary.pendingFollowUps.toString()} />
            <StatCard
              icon={Briefcase}
              label="Oportunidades abiertas"
              value={summary.openOpportunities.toString()}
              hint={`$${Number(summary.pipelineValue).toLocaleString()} en pipeline`}
            />
            <StatCard icon={CalendarClock} label="Reuniones programadas" value={summary.scheduledMeetings.toString()} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
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
            <Card>
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
          <Card>
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

          <Card>
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

          <Card>
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

          <Card>
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

          <Card>
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

          <Card>
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
