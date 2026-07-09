import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bot } from "lucide-react";
import type { AgentInstanceListItem, CompanyDetail } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { AgentTaskAction } from "@/components/shared/AgentTaskAction";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";

function SearchCompaniesResults({ companyIds }: { companyIds: string[] }) {
  const results = useQueries({
    queries: companyIds.map((id) => ({
      queryKey: ["company", id],
      queryFn: () => apiFetch<CompanyDetail>(`/companies/${id}`),
    })),
  });

  if (companyIds.length === 0) {
    return <p className="mt-2 text-xs text-muted-foreground">No se encontraron empresas nuevas para prospectar.</p>;
  }

  return (
    <div className="mt-3 space-y-2">
      {companyIds.map((id, i) => {
        const company = results[i]?.data;
        return (
          <div key={id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
            <div>
              <Link to={`/companies/${id}`} className="font-medium text-primary hover:underline">
                {company?.name ?? "Cargando…"}
              </Link>
              <p className="text-xs text-muted-foreground">
                {company?.industryName ?? "—"}
                {company?.city && company?.state ? ` · ${company.city}, ${company.state}` : ""}
              </p>
            </div>
            <CreateLeadQuickAction companyId={id} />
          </div>
        );
      })}
    </div>
  );
}

function CreateLeadQuickAction({ companyId }: { companyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return (
    <AgentTaskAction
      label="Crear lead"
      runningLabel="Creando…"
      input={{ type: "create_lead", input: { companyId, source: "ai-search" } }}
      onSettled={(task) => {
        if (task.status === "DONE") {
          toast({ title: "Lead creado por el Sales Agent", variant: "success" });
          queryClient.invalidateQueries({ queryKey: ["leads"] });
        }
      }}
      renderResult={() => <span className="text-xs text-emerald-600 dark:text-emerald-400">Lead creado ✓</span>}
    />
  );
}

export default function AgentsCenter() {
  const { data, isLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiFetch<AgentInstanceListItem[]>("/agents"),
  });

  return (
    <div>
      <PageHeader title="AI Agents Center" description="Agentes activos para este tenant" />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando agentes…</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data?.map((agent) => {
            const metrics = agent.metrics as { tasksCompleted?: number; costUsdThisMonth?: number; budgetExceeded?: boolean };
            const tasksCompleted = metrics?.tasksCompleted ?? 0;
            return (
              <Card key={agent.id}>
                <CardHeader className="flex-row items-start justify-between space-y-0">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary">
                      <Bot className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-foreground">{agent.name}</div>
                      <div className="text-xs text-muted-foreground">{agent.key}</div>
                    </div>
                  </div>
                  <Badge variant={agent.isActive ? "success" : "neutral"}>
                    {agent.isActive ? "Activo" : "Inactivo"}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">{agent.description}</p>
                  <div className="flex items-center justify-between border-t border-border pt-3 text-xs">
                    <span className="text-muted-foreground">Autonomía</span>
                    <Badge variant={statusVariant(agent.autonomyLevel)}>
                      {formatStatusLabel(agent.autonomyLevel)}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Tareas completadas</span>
                    <span className="font-medium">{tasksCompleted}</span>
                  </div>
                  {metrics?.costUsdThisMonth != null && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Costo IA este mes</span>
                      <span className={metrics.budgetExceeded ? "font-medium text-red-500" : "font-medium"}>
                        ${metrics.costUsdThisMonth.toFixed(4)}
                        {metrics.budgetExceeded && " · presupuesto excedido"}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {data?.some((a) => a.key === "sales") && (
        <Card className="mt-6">
          <CardHeader>
            <div className="text-sm font-semibold">Prospectar con IA</div>
          </CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground">
              Busca empresas del CRM sin trabajar todavía (datos internos + carga manual — sin scraping, sin fuentes
              pagas). Cada resultado se puede convertir en un lead con un clic.
            </p>
            <AgentTaskAction
              label="Buscar empresas nuevas"
              runningLabel="Buscando…"
              input={{ type: "search_companies", input: {} }}
              renderResult={(output) => <SearchCompaniesResults companyIds={(output as { companyIds: string[] }).companyIds} />}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
