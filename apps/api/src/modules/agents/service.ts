import type {
  AgentInstanceListItem,
  AgentTaskDetail,
  AgentTaskListItem,
  AgentTaskQuery,
  InvokeSalesAgentInput,
} from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { runSalesAgentTask } from "./task-runner";

export async function listAgentInstances(): Promise<AgentInstanceListItem[]> {
  const instances = await scopedDb.agentInstance.findMany({
    include: { definition: true },
    orderBy: { createdAt: "asc" },
  });

  return instances.map((instance) => ({
    id: instance.id,
    key: instance.definition.key,
    name: instance.definition.name,
    description: instance.definition.description,
    autonomyLevel: instance.autonomyLevel,
    isActive: instance.isActive,
    metrics: instance.metrics as Record<string, unknown>,
  }));
}

function toTaskListItem(
  task: Awaited<ReturnType<typeof scopedDb.agentTask.findMany>>[number] & {
    agentInstance: { definition: { key: string } };
  },
): AgentTaskListItem {
  return {
    id: task.id,
    agentInstanceId: task.agentInstanceId,
    agentKey: task.agentInstance.definition.key,
    type: task.type,
    status: task.status,
    triggeredBy: task.triggeredBy,
    tokensUsed: task.tokensUsed,
    costUsd: task.costUsd?.toString() ?? null,
    errorMessage: task.errorMessage,
    parentTaskId: task.parentTaskId,
    createdAt: task.createdAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
  };
}

export async function invokeSalesAgentTask(input: InvokeSalesAgentInput): Promise<AgentTaskDetail> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const agentInstance = await scopedDb.agentInstance.findFirst({
    where: { definition: { key: "sales" } },
    include: { definition: true },
  });
  if (!agentInstance) throw AppError.internal("Sales Agent instance not found for this tenant");

  const task = await scopedDb.agentTask.create({
    data: {
      tenantId: ctx.tenantId,
      agentInstanceId: agentInstance.id,
      type: input.type,
      input: input.input as never,
      status: "QUEUED",
      triggeredBy: "USER",
    },
  });

  runSalesAgentTask(task.id, ctx.tenantId, ctx.userId);

  return {
    id: task.id,
    agentInstanceId: task.agentInstanceId,
    agentKey: agentInstance.definition.key,
    type: task.type,
    status: task.status,
    triggeredBy: task.triggeredBy,
    tokensUsed: task.tokensUsed,
    costUsd: task.costUsd?.toString() ?? null,
    errorMessage: task.errorMessage,
    parentTaskId: task.parentTaskId,
    createdAt: task.createdAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    input: task.input,
    output: task.output,
    approvalRequestId: null,
  };
}

export async function listAgentTasks(query: AgentTaskQuery): Promise<AgentTaskListItem[]> {
  const tasks = await scopedDb.agentTask.findMany({
    where: { agentInstanceId: query.agentInstanceId, status: query.status },
    include: { agentInstance: { include: { definition: true } } },
    orderBy: { createdAt: "desc" },
    take: query.limit,
  });

  return tasks.map(toTaskListItem);
}

export async function getAgentTaskDetail(id: string): Promise<AgentTaskDetail> {
  const task = await scopedDb.agentTask.findUnique({
    where: { id },
    include: { agentInstance: { include: { definition: true } } },
  });
  if (!task) throw AppError.notFound("Agent task not found");

  const approval = await scopedDb.approvalRequest.findFirst({ where: { agentTaskId: id } });

  return {
    ...toTaskListItem(task),
    input: task.input,
    output: task.output,
    approvalRequestId: approval?.id ?? null,
  };
}
