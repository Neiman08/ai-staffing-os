import {
  AgentRuntime,
  InMemoryToolRegistry,
  OpenAIProvider,
  requiresApproval,
  type AgentContext,
  type LLMCompletionResult,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";
import { createSalesTools } from "./tools/sales-tools.impl";
import { UsageAccumulator } from "./usage";
import { getMonthlyBudgetStatus } from "./budget";

const TASK_TYPE_TO_TOOL_NAME: Record<string, string> = {
  search_companies: "searchCompanies",
  detect_hiring_signals: "detectHiringSignals",
  identify_contacts: "identifyContacts",
  create_lead: "createLead",
  score_company: "scoreCompany",
  draft_outreach: "draftOutreach",
  suggest_follow_up: "suggestFollowUp",
};

/**
 * Used when OPENAI_API_KEY isn't configured. Deterministic tools (search,
 * detect, identify, suggest) never touch this — only scoreCompany and
 * draftOutreach call complete(), and only then does the task fail with a
 * clear, actionable error instead of an opaque construction-time crash.
 */
class MissingApiKeyProvider implements LLMProvider {
  async complete(): Promise<LLMCompletionResult> {
    throw new AppError(
      500,
      "AI_NOT_CONFIGURED",
      "OPENAI_API_KEY no está configurada en el servidor — no se puede ejecutar esta acción de IA.",
    );
  }
}

function buildLLMProvider(): LLMProvider {
  return env.OPENAI_API_KEY ? new OpenAIProvider(env.OPENAI_API_KEY) : new MissingApiKeyProvider();
}

async function updateAgentInstanceMetrics(
  agentInstanceId: string,
  patch: { tasksCompletedDelta: number; costUsdThisMonth: number; budgetExceeded: boolean },
) {
  const instance = await scopedDb.agentInstance.findUnique({ where: { id: agentInstanceId } });
  if (!instance) return;
  const metrics = (instance.metrics ?? {}) as { tasksCompleted?: number };
  await scopedDb.agentInstance.update({
    where: { id: agentInstanceId },
    data: {
      metrics: {
        tasksCompleted: (metrics.tasksCompleted ?? 0) + patch.tasksCompletedDelta,
        costUsdThisMonth: patch.costUsdThisMonth,
        budgetExceeded: patch.budgetExceeded,
      } as never,
    },
  });
}

async function executeTask(taskId: string, agentInstanceId: string): Promise<void> {
  const task = await scopedDb.agentTask.findUnique({ where: { id: taskId } });
  if (!task) return;

  const budget = await getMonthlyBudgetStatus(task.tenantId);
  if (budget.exceeded) {
    await scopedDb.agentTask.update({
      where: { id: taskId },
      data: {
        status: "FAILED",
        errorMessage: `Presupuesto mensual de IA excedido ($${budget.spentUsd.toFixed(2)} / $${budget.budgetUsd.toFixed(2)}). Aumenta el presupuesto en Configuración o espera al próximo mes.`,
        completedAt: new Date(),
      },
    });
    await updateAgentInstanceMetrics(agentInstanceId, {
      tasksCompletedDelta: 0,
      costUsdThisMonth: budget.spentUsd,
      budgetExceeded: true,
    });
    return;
  }

  await scopedDb.agentTask.update({ where: { id: taskId }, data: { status: "RUNNING" } });

  const usage = new UsageAccumulator();
  const llmProvider = buildLLMProvider();
  const registry = new InMemoryToolRegistry();
  for (const tool of createSalesTools({ taskId, agentInstanceId, llmProvider, usage })) {
    registry.register(tool);
  }
  const runtime = new AgentRuntime(registry);

  const context: AgentContext = {
    tenantId: task.tenantId,
    agentInstanceId,
    taskId,
    triggeredBy: task.triggeredBy,
  };

  const toolName = TASK_TYPE_TO_TOOL_NAME[task.type];

  try {
    if (!toolName) throw new Error(`Unknown AgentTask type: ${task.type}`);

    const output = await runtime.run(context, { toolName, toolInput: task.input });
    const needsApproval = requiresApproval(toolName);

    await scopedDb.agentTask.update({
      where: { id: taskId },
      data: {
        status: needsApproval ? "AWAITING_APPROVAL" : "DONE",
        output: output as never,
        tokensUsed: usage.tokensUsed,
        costUsd: usage.costUsd,
        completedAt: new Date(),
      },
    });

    const newBudget = await getMonthlyBudgetStatus(task.tenantId);
    await updateAgentInstanceMetrics(agentInstanceId, {
      tasksCompletedDelta: 1,
      costUsdThisMonth: newBudget.spentUsd,
      budgetExceeded: newBudget.exceeded,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido ejecutando la tarea";
    await scopedDb.agentTask.update({
      where: { id: taskId },
      data: {
        status: "FAILED",
        errorMessage: message,
        tokensUsed: usage.tokensUsed,
        costUsd: usage.costUsd,
        completedAt: new Date(),
      },
    });

    // Even a failed task may have burned real OpenAI tokens before the
    // failure (e.g. persistence error after a successful completion) —
    // reflect that in the running total regardless of outcome.
    const newBudget = await getMonthlyBudgetStatus(task.tenantId);
    await updateAgentInstanceMetrics(agentInstanceId, {
      tasksCompletedDelta: 0,
      costUsdThisMonth: newBudget.spentUsd,
      budgetExceeded: newBudget.exceeded,
    });
  }
}

/**
 * F2: in-process, no queue (Redis/BullMQ intentionally out of scope — see
 * F2 plan §2). Called fire-and-forget right after the AgentTask row is
 * created so the HTTP request can return immediately; the frontend polls
 * GET /agents/tasks/:id. Never throws — a background task that crashes the
 * process would be worse than one that silently fails and self-reports via
 * AgentTask.status=FAILED.
 */
export function runSalesAgentTask(taskId: string, tenantId: string, triggeredByUserId: string): void {
  runWithTenancyContext({ tenantId, userId: triggeredByUserId, permissions: [] }, async () => {
    const task = await scopedDb.agentTask.findUnique({ where: { id: taskId } });
    if (!task) return;

    await runWithTenancyContext(
      { tenantId, userId: triggeredByUserId, permissions: [], actor: { type: "AGENT", agentInstanceId: task.agentInstanceId } },
      () => executeTask(taskId, task.agentInstanceId),
    );
  }).catch((err) => {
    console.error(`[task-runner] unhandled error running AgentTask ${taskId}:`, err);
  });
}
