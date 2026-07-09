import {
  AgentRuntime,
  InMemoryToolRegistry,
  OpenAIProvider,
  requiresApproval,
  type AgentContext,
  type AgentTool,
  type LLMCompletionResult,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import { getTenancyContext, runWithTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";
import { createSalesTools } from "./tools/sales-tools.impl";
import { createMarketIntelligenceTools } from "./tools/market-intelligence-tools.impl";
import { createProspectingTools, type RunChildTask } from "./tools/prospecting-tools.impl";
import { UsageAccumulator } from "./usage";
import { getMonthlyBudgetStatus } from "./budget";

/**
 * F3: generalización de task-runner.ts (F2). F2 solo sabía ejecutar tools
 * del Sales Agent disparadas por HTTP; F3 necesita que el mismo mecanismo
 * (crear AgentTask, chequear presupuesto, correr el tool, persistir) lo
 * puedan usar también el orquestador del Prospecting Agent (que necesita
 * el resultado de cada paso para decidir el siguiente, síncrono) y el
 * scheduler — sin duplicar la lógica tres veces.
 */
const TASK_TYPE_TO_TOOL_NAME: Record<string, string> = {
  search_companies: "searchCompanies",
  detect_hiring_signals: "detectHiringSignals",
  identify_contacts: "identifyContacts",
  create_lead: "createLead",
  score_company: "scoreCompany",
  draft_outreach: "draftOutreach",
  suggest_follow_up: "suggestFollowUp",
  create_opportunity: "createOpportunity", // F3
  create_follow_up: "createFollowUp", // F3
  analyze_industry: "analyzeIndustry", // F3
  process_company_pipeline: "processCompanyPipeline", // F3
};

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

/**
 * F3: registro de tools por agente. La rama "prospecting" inyecta
 * runChildTask (en vez de importar createAndRunTaskSync directamente
 * desde prospecting-tools.impl.ts) para evitar un import circular entre
 * este archivo y ese — ver RunChildTask en prospecting-tools.impl.ts.
 */
function buildToolRegistry(
  agentKey: string,
  common: { taskId: string; agentInstanceId: string; llmProvider: LLMProvider; usage: UsageAccumulator },
): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  let tools: AgentTool[] = [];

  if (agentKey === "sales") {
    tools = createSalesTools(common);
  } else if (agentKey === "market_intelligence") {
    tools = createMarketIntelligenceTools(common);
  } else if (agentKey === "prospecting") {
    const runChildTask: RunChildTask = async ({ agentKey: childAgentKey, type, input }) => {
      const ctx = getTenancyContext();
      if (!ctx) throw AppError.unauthorized();

      const settled = await createAndRunTaskSync(ctx.tenantId, ctx.userId, {
        agentKey: childAgentKey,
        type,
        input,
        triggeredBy: "AGENT",
        parentTaskId: common.taskId,
      });
      const approval = await scopedDb.approvalRequest.findFirst({ where: { agentTaskId: settled.id } });

      return {
        id: settled.id,
        status: settled.status,
        output: settled.output,
        errorMessage: settled.errorMessage,
        approvalRequestId: approval?.id ?? null,
      };
    };
    tools = createProspectingTools({ taskId: common.taskId, agentInstanceId: common.agentInstanceId, runChildTask });
  } else {
    throw new Error(`buildToolRegistry: no tool factory registered for agent key "${agentKey}"`);
  }

  for (const tool of tools) registry.register(tool);
  return registry;
}

async function executeTaskById(taskId: string, agentInstanceId: string, agentKey: string): Promise<void> {
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
  const registry = buildToolRegistry(agentKey, { taskId, agentInstanceId, llmProvider, usage });
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

async function resolveAgentInstance(agentKey: string) {
  const agentInstance = await scopedDb.agentInstance.findFirst({ where: { definition: { key: agentKey } } });
  if (!agentInstance) throw AppError.internal(`No AgentInstance found for agent key "${agentKey}"`);
  return agentInstance;
}

export interface CreateTaskParams {
  agentKey: string;
  type: string;
  input: unknown;
  triggeredBy: "USER" | "AGENT" | "SCHEDULE";
  parentTaskId?: string;
}

/**
 * Crea el AgentTask en QUEUED. Debe llamarse dentro de un contexto de
 * tenancy ya establecido (la ruta HTTP ya tiene uno vía tenancyMiddleware;
 * el orquestador/scheduler lo establecen ellos mismos antes de llamar).
 */
export async function createQueuedTask(params: CreateTaskParams) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const agentInstance = await resolveAgentInstance(params.agentKey);

  return scopedDb.agentTask.create({
    data: {
      tenantId: ctx.tenantId,
      agentInstanceId: agentInstance.id,
      type: params.type,
      input: params.input as never,
      status: "QUEUED",
      triggeredBy: params.triggeredBy,
      parentTaskId: params.parentTaskId,
    },
  });
}

async function runTaskInner(taskId: string): Promise<void> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const task = await scopedDb.agentTask.findUnique({ where: { id: taskId } });
  if (!task) return;
  const agentInstance = await scopedDb.agentInstance.findUnique({
    where: { id: task.agentInstanceId },
    include: { definition: true },
  });
  if (!agentInstance) return;

  await runWithTenancyContext(
    { tenantId: ctx.tenantId, userId: ctx.userId, permissions: [], actor: { type: "AGENT", agentInstanceId: agentInstance.id } },
    () => executeTaskById(taskId, agentInstance.id, agentInstance.definition.key),
  );
}

/**
 * Fire-and-forget: para rutas HTTP que ya devolvieron un 202 con la tarea
 * en QUEUED (F2 §2 — sin cola, el frontend hace polling). Nunca lanza.
 */
export function runTaskAsync(taskId: string, tenantId: string, operatorUserId: string): void {
  runWithTenancyContext({ tenantId, userId: operatorUserId, permissions: [] }, () => runTaskInner(taskId)).catch(
    (err) => {
      console.error(`[task-executor] unhandled error running AgentTask ${taskId}:`, err);
    },
  );
}

/** Esperado: para el orquestador/scheduler, que necesitan el resultado antes de seguir. */
export async function runTaskSync(taskId: string, tenantId: string, operatorUserId: string) {
  await runWithTenancyContext({ tenantId, userId: operatorUserId, permissions: [] }, () => runTaskInner(taskId));
  return scopedDb.agentTask.findUniqueOrThrow({ where: { id: taskId } });
}

/**
 * Crear + correr + esperar, en una sola llamada — lo que usa el
 * orquestador del Prospecting Agent para cada paso hijo (parentTaskId).
 */
export async function createAndRunTaskSync(tenantId: string, operatorUserId: string, params: CreateTaskParams) {
  return runWithTenancyContext({ tenantId, userId: operatorUserId, permissions: [] }, async () => {
    const task = await createQueuedTask(params);
    await runTaskInner(task.id);
    return scopedDb.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  });
}
