/**
 * Contexto de ejecución inyectado a cada AgentTask (Architecture §6.1/§6.2).
 * La memoria nunca sustituye un query — es siempre contexto adicional.
 */
export interface AgentContext {
  tenantId: string;
  agentInstanceId: string;
  taskId: string;
  triggeredBy: "USER" | "EVENT" | "AGENT" | "SCHEDULE";
}
