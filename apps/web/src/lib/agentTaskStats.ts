import type { AgentTaskListItem } from "@ai-staffing-os/shared";

/**
 * F3.5: helpers puros para derivar la sensación de "Mission Control" a
 * partir de datos 100% reales de /agents/tasks — nada hardcodeado, nada
 * simulado. Cada número que se muestra en AgentsCenter/Dashboard/AI
 * Dashboard sale de acá.
 */

const TASK_TYPE_LABELS: Record<string, string> = {
  search_companies: "Buscando empresas",
  detect_hiring_signals: "Detectando señales",
  identify_contacts: "Identificando contactos",
  create_lead: "Creando lead",
  score_company: "Generando score",
  draft_outreach: "Preparando outreach",
  suggest_follow_up: "Sugiriendo seguimiento",
  create_opportunity: "Creando oportunidad",
  create_follow_up: "Creando seguimiento",
  analyze_industry: "Analizando industria",
  process_company_pipeline: "Procesando pipeline completo",
};

export function formatTaskType(type: string): string {
  return TASK_TYPE_LABELS[type] ?? type;
}

const RUNNING_STATUSES = new Set(["QUEUED", "RUNNING"]);

export function tasksForAgent(tasks: AgentTaskListItem[], agentInstanceId: string): AgentTaskListItem[] {
  return tasks.filter((t) => t.agentInstanceId === agentInstanceId);
}

export function isAgentWorking(tasks: AgentTaskListItem[]): boolean {
  return tasks.some((t) => RUNNING_STATUSES.has(t.status));
}

export function getRunningTask(tasks: AgentTaskListItem[]): AgentTaskListItem | undefined {
  return tasks.find((t) => RUNNING_STATUSES.has(t.status));
}

export function getLatestTask(tasks: AgentTaskListItem[]): AgentTaskListItem | undefined {
  return [...tasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

export function countByType(tasks: AgentTaskListItem[], type: string): number {
  return tasks.filter((t) => t.type === type && t.status === "DONE").length;
}

export function totalDurationMs(tasks: AgentTaskListItem[]): number {
  return tasks.reduce((sum, t) => {
    if (!t.completedAt) return sum;
    return sum + (new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime());
  }, 0);
}

export function averageDurationMs(tasks: AgentTaskListItem[]): number | null {
  const withDuration = tasks.filter((t) => t.completedAt);
  if (withDuration.length === 0) return null;
  return totalDurationMs(withDuration) / withDuration.length;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export interface DailyCount {
  date: string;
  count: number;
}

export function dailyCounts(tasks: AgentTaskListItem[], days: number): DailyCount[] {
  const buckets = new Map<string, number>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const t of tasks) {
    const key = t.createdAt.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
}

export function totalCostUsd(tasks: AgentTaskListItem[]): number {
  return tasks.reduce((sum, t) => sum + Number(t.costUsd ?? 0), 0);
}

export function totalTokens(tasks: AgentTaskListItem[]): number {
  return tasks.reduce((sum, t) => sum + (t.tokensUsed ?? 0), 0);
}

/**
 * Próxima corrida programada, derivada de al menos 2 tareas reales con
 * triggeredBy "SCHEDULE" (nunca un intervalo inventado) — el gap entre
 * las dos corridas programadas más recientes se usa como estimado del
 * próximo disparo. Con menos de 2 muestras no hay suficiente historia.
 */
export function nextScheduledRun(tasks: AgentTaskListItem[]): Date | null {
  const scheduled = tasks
    .filter((t) => t.triggeredBy === "SCHEDULE")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  if (scheduled.length < 2) return null;
  const last = scheduled[scheduled.length - 1]!;
  const prev = scheduled[scheduled.length - 2]!;
  const intervalMs = new Date(last.createdAt).getTime() - new Date(prev.createdAt).getTime();
  if (intervalMs <= 0) return null;
  return new Date(new Date(last.createdAt).getTime() + intervalMs);
}

export function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return "justo ahora";
  if (diffSec < 60) return `hace ${diffSec}s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return `hace ${diffHours} h`;
  const diffDays = Math.round(diffHours / 24);
  return `hace ${diffDays} d`;
}

export function timeUntil(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "en cualquier momento";
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return `en ${diffMin} min`;
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return `en ${diffHours} h`;
  const diffDays = Math.round(diffHours / 24);
  return `en ${diffDays} d`;
}
