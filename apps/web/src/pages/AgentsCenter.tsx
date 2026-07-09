import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bot, Sparkles } from "lucide-react";
import type { AgentInstanceListItem, AgentTaskDetail, AgentTaskListItem, CompanyDetail, LeadDetail } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { AgentTaskAction } from "@/components/shared/AgentTaskAction";
import { AgentStatusDot } from "@/components/shared/AgentStatusDot";
import { useAgentTasksByInstance } from "@/lib/useAgentTaskStats";
import {
  dailyCounts,
  formatDuration,
  formatTaskType,
  getLatestTask,
  getRunningTask,
  isAgentWorking,
  nextScheduledRun,
  timeAgo,
  timeUntil,
  totalDurationMs,
} from "@/lib/agentTaskStats";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { cn } from "@/lib/utils";

interface AgentStatConfig {
  primaryLabel: string;
  primaryType: string;
  secondaryLabel?: string;
  secondaryType?: string;
}

const AGENT_STATS_CONFIG: Record<string, AgentStatConfig> = {
  sales: { primaryLabel: "Empresas analizadas", primaryType: "score_company", secondaryLabel: "Leads creados", secondaryType: "create_lead" },
  prospecting: { primaryLabel: "Empresas procesadas", primaryType: "process_company_pipeline" },
  market_intelligence: { primaryLabel: "Industrias analizadas", primaryType: "analyze_industry" },
};

function countDoneByType(tasks: AgentTaskListItem[], type: string): number {
  return tasks.filter((t) => t.type === type && t.status === "DONE").length;
}

function todayDurationMs(tasks: AgentTaskListItem[]): number {
  const todayKey = new Date().toISOString().slice(0, 10);
  return totalDurationMs(tasks.filter((t) => t.createdAt.slice(0, 10) === todayKey));
}

/** F3.5: mientras el agente tiene una tarea real QUEUED/RUNNING, resuelve
 * qué empresa está analizando (vía la Detail de esa tarea puntual — un
 * solo fetch extra, no N+1 sobre el historial). */
function AgentWorkingBanner({ task }: { task: AgentTaskListItem }) {
  const { data: detail } = useQuery({
    queryKey: ["agent-task", task.id, "running"],
    queryFn: () => apiFetch<AgentTaskDetail>(`/agents/tasks/${task.id}`),
    refetchInterval: 2500,
  });

  const input = (detail?.input ?? {}) as { companyId?: string; leadId?: string };

  const { data: company } = useQuery({
    queryKey: ["company", input.companyId],
    queryFn: () => apiFetch<CompanyDetail>(`/companies/${input.companyId}`),
    enabled: !!input.companyId,
  });
  const { data: lead } = useQuery({
    queryKey: ["lead", input.leadId],
    queryFn: () => apiFetch<LeadDetail>(`/leads/${input.leadId}`),
    enabled: !!input.leadId && !input.companyId,
  });

  const targetLabel = company?.name ?? lead?.companyName ?? lead?.industryName ?? null;

  return (
    <div className="animate-fade-in rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
        <Sparkles className="h-3.5 w-3.5" />
        {targetLabel ? `Analizando: ${targetLabel}` : "Procesando…"}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Paso actual: {formatTaskType(task.type)}…</p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
        <div className="h-full w-2/5 animate-pulse rounded-full bg-primary" />
      </div>
    </div>
  );
}

function ActivityBar({ tasks }: { tasks: AgentTaskListItem[] }) {
  const days = dailyCounts(tasks, 7);
  const max = Math.max(1, ...days.map((d) => d.count));
  return (
    <div className="flex h-8 items-end gap-1">
      {days.map((d) => (
        <div
          key={d.date}
          className="flex-1 rounded-sm bg-primary/70 transition-all"
          style={{ height: `${Math.max(8, (d.count / max) * 100)}%` }}
          title={`${d.date}: ${d.count} tarea(s)`}
        />
      ))}
    </div>
  );
}

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
    refetchInterval: 5000,
  });
  const tasksByAgent = useAgentTasksByInstance((data ?? []).map((a) => a.id));

  const workingCount = data?.filter((a) => isAgentWorking(tasksByAgent.get(a.id) ?? [])).length ?? 0;

  return (
    <div>
      <PageHeader
        title="AI Agents Center"
        description={
          workingCount > 0
            ? `${workingCount} agente(s) trabajando ahora mismo`
            : "Agentes activos para este tenant"
        }
        action={
          workingCount > 0 ? (
            <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <AgentStatusDot active />
              En vivo
            </div>
          ) : undefined
        }
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando agentes…</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data?.map((agent) => {
            const metrics = agent.metrics as { tasksCompleted?: number; costUsdThisMonth?: number; budgetExceeded?: boolean };
            const tasksCompleted = metrics?.tasksCompleted ?? 0;
            const myTasks = tasksByAgent.get(agent.id) ?? [];
            const working = isAgentWorking(myTasks);
            const runningTask = getRunningTask(myTasks);
            const latestTask = getLatestTask(myTasks);
            const statConfig = AGENT_STATS_CONFIG[agent.key];
            const nextRun = nextScheduledRun(myTasks);

            return (
              <Card key={agent.id} className={cn("card-hover", working && "glow-primary")}>
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
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <AgentStatusDot active={working} />
                    <span className={working ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
                      {working ? "Working" : "Idle"}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">{agent.description}</p>

                  {runningTask && <AgentWorkingBanner task={runningTask} />}

                  <div className="flex items-center justify-between border-t border-border pt-3 text-xs">
                    <span className="text-muted-foreground">Autonomía</span>
                    <Badge variant={statusVariant(agent.autonomyLevel)}>{formatStatusLabel(agent.autonomyLevel)}</Badge>
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Última tarea</span>
                    <span className="font-medium">
                      {latestTask ? `${formatTaskType(latestTask.type)} · ${timeAgo(latestTask.createdAt)}` : "Sin actividad"}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Tiempo trabajado hoy</span>
                    <span className="font-medium">{formatDuration(todayDurationMs(myTasks))}</span>
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Tareas completadas</span>
                    <span className="font-medium">{tasksCompleted}</span>
                  </div>

                  {statConfig && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{statConfig.primaryLabel}</span>
                      <span className="font-medium">{countDoneByType(myTasks, statConfig.primaryType)}</span>
                    </div>
                  )}
                  {statConfig?.secondaryLabel && statConfig.secondaryType && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{statConfig.secondaryLabel}</span>
                      <span className="font-medium">{countDoneByType(myTasks, statConfig.secondaryType)}</span>
                    </div>
                  )}

                  {metrics?.costUsdThisMonth != null && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Costo IA este mes</span>
                      <span className={metrics.budgetExceeded ? "font-medium text-red-500" : "font-medium"}>
                        ${metrics.costUsdThisMonth.toFixed(4)}
                        {metrics.budgetExceeded && " · presupuesto excedido"}
                      </span>
                    </div>
                  )}

                  <div className="border-t border-border pt-3">
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Actividad (7 días)</span>
                    </div>
                    <ActivityBar tasks={myTasks} />
                  </div>

                  <div className="flex items-center justify-between border-t border-border pt-3 text-xs">
                    <span className="text-muted-foreground">Próxima ejecución</span>
                    <span className="font-medium">{nextRun ? timeUntil(nextRun) : "Bajo demanda"}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {data?.some((a) => a.key === "sales") && (
        <Card className="mt-6 card-hover">
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
