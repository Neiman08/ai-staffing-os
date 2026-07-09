import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentTaskDetail, InvokeSalesAgentInput } from "@ai-staffing-os/shared";
import { apiFetch } from "./api";

const POLLING_STATUSES = new Set(["QUEUED", "RUNNING"]);

/**
 * F2 §2: no queue, no websockets — the backend runs the task in-process
 * and this hook polls GET /agents/tasks/:id every 1.5s while it's
 * QUEUED/RUNNING. `onSettled` fires once, when the task leaves those
 * states (DONE/FAILED/AWAITING_APPROVAL), so callers can invalidate
 * whatever query the tool's side effects touched (e.g. the Company or
 * Lead the task just updated). Uses a ref (not state) to track "already
 * notified" so the effect never needs to setState itself.
 */
export function useAgentTask(onSettled?: (task: AgentTaskDetail) => void) {
  const queryClient = useQueryClient();
  const [taskId, setTaskId] = useState<string | null>(null);
  const notifiedForRef = useRef<string | null>(null);

  const invoke = useMutation({
    mutationFn: (input: InvokeSalesAgentInput) =>
      apiFetch<AgentTaskDetail>("/agents/sales/tasks", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (task) => {
      setTaskId(task.id);
      notifiedForRef.current = null;
    },
  });

  const statusQuery = useQuery({
    queryKey: ["agent-task", taskId],
    queryFn: () => apiFetch<AgentTaskDetail>(`/agents/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (query) => (query.state.data && POLLING_STATUSES.has(query.state.data.status) ? 1500 : false),
  });

  const task = statusQuery.data;
  useEffect(() => {
    if (task && !POLLING_STATUSES.has(task.status) && notifiedForRef.current !== task.id) {
      notifiedForRef.current = task.id;
      onSettled?.(task);
    }
  }, [task, onSettled]);

  return {
    invoke,
    task,
    isRunning: invoke.isPending || (!!task && POLLING_STATUSES.has(task.status)),
    reset: () => {
      setTaskId(null);
      queryClient.removeQueries({ queryKey: ["agent-task"] });
    },
  };
}
