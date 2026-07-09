import { useQueries, useQuery } from "@tanstack/react-query";
import type { AgentTaskListItem } from "@ai-staffing-os/shared";
import { apiFetch } from "./api";

/**
 * F3.5: feed global — las N tareas más recientes de TODO el tenant, sin
 * filtrar por agente. Correcto para timelines/feeds cross-agente (quién
 * hizo qué recientemente), pero NO sirve para stats por agente: si un
 * agente es mucho más activo que otros, su actividad histórica queda
 * diluida fuera de una ventana global de tamaño fijo (ver
 * useAgentTasksByInstance para eso).
 */
export function useAgentTaskStats(limit = 100) {
  return useQuery({
    queryKey: ["agents", "tasks", "recent", limit],
    queryFn: () => apiFetch<AgentTaskListItem[]>(`/agents/tasks?limit=${limit}`),
    refetchInterval: 5000,
  });
}

/**
 * F3.5: una consulta por agente (mismo GET /agents/tasks existente,
 * filtrado server-side por agentInstanceId) — así las stats de un agente
 * muy activo (ej. Sales con cientos de tareas) no se diluyen dentro de
 * una ventana global compartida con el resto de los agentes.
 */
export function useAgentTasksByInstance(agentInstanceIds: string[], limit = 100) {
  const results = useQueries({
    queries: agentInstanceIds.map((id) => ({
      queryKey: ["agents", "tasks", "by-instance", id, limit],
      queryFn: () => apiFetch<AgentTaskListItem[]>(`/agents/tasks?agentInstanceId=${id}&limit=${limit}`),
      refetchInterval: 5000,
    })),
  });

  const byInstance = new Map<string, AgentTaskListItem[]>();
  agentInstanceIds.forEach((id, i) => {
    byInstance.set(id, results[i]?.data ?? []);
  });
  return byInstance;
}
