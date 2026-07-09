import { useQuery } from "@tanstack/react-query";
import type { AgentTaskListItem } from "@ai-staffing-os/shared";
import { apiFetch } from "./api";

/**
 * F3.5: una sola fuente para la sensación de "tiempo real" en toda la
 * app — poll cada 5s sobre el endpoint ya existente GET /agents/tasks
 * (sin nuevo backend). Reutilizado por Dashboard, AgentsCenter y AI
 * Dashboard para no repetir el fetch.
 */
export function useAgentTaskStats(limit = 100) {
  return useQuery({
    queryKey: ["agents", "tasks", "recent", limit],
    queryFn: () => apiFetch<AgentTaskListItem[]>(`/agents/tasks?limit=${limit}`),
    refetchInterval: 5000,
  });
}
