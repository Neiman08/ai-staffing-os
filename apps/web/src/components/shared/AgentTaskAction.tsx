import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type {
  AgentTaskDetail,
  CampaignCompanyTaskInput,
  CampaignTaskInput,
  InvokeSalesAgentInput,
  ProcessCompanyPipelineInput,
} from "@ai-staffing-os/shared";
import { useAgentTask } from "@/lib/useAgentTask";
import { Button } from "@/components/ui/button";

interface AgentTaskActionProps {
  label: string;
  runningLabel?: string;
  input: InvokeSalesAgentInput | ProcessCompanyPipelineInput | CampaignTaskInput | CampaignCompanyTaskInput;
  /** F3: "/prospecting/tasks" para el pipeline del Prospecting Agent. F4: "/campaigns/:id/tasks" o "/campaign-companies/:id/tasks". */
  endpoint?: string;
  renderResult: (output: unknown) => ReactNode;
  onSettled?: (task: AgentTaskDetail) => void;
}

/**
 * F2 §13: one button that invokes a single Sales Agent tool (or, since
 * F3, the Prospecting Agent's pipeline) and polls it to completion. Every
 * action here is FULL_AUTO-eligible per the approved autonomy matrix
 * (analyze/score/create-internal-record) — nothing behind this button
 * ever contacts anyone outside the tenant.
 */
export function AgentTaskAction({
  label,
  runningLabel = "Ejecutando…",
  input,
  endpoint,
  renderResult,
  onSettled,
}: AgentTaskActionProps) {
  const { invoke, task, isRunning } = useAgentTask(onSettled, endpoint);

  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" disabled={isRunning} onClick={() => invoke.mutate(input)}>
        <Sparkles className="h-4 w-4" />
        {isRunning ? runningLabel : label}
      </Button>
      {task?.status === "FAILED" && <p className="text-xs text-red-500">{task.errorMessage}</p>}
      {task?.status === "DONE" && renderResult(task.output)}
    </div>
  );
}
