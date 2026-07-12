import { AsyncLocalStorage } from "node:async_hooks";

export interface TenancyContext {
  tenantId: string;
  userId: string;
  permissions: string[];
  // F2: set when the current context is executing on behalf of an AI
  // agent task (task-runner), not a human HTTP request. Consumers that
  // attribute actions (activity-log, audit-log) check this before
  // falling back to `userId`.
  actor?: { type: "AGENT"; agentInstanceId: string };
  // F4.9 §6: ver ResolvedIdentity en modules/auth/auth-provider.ts —
  // mismo significado, requirePermission los lee de acá. Default true
  // para contextos que no pasan por un AuthProvider real (scheduler,
  // task-runner de agentes) — un AgentTask nunca es una "sesión humana
  // sin MFA", el gate de MFA no aplica a ese actor.
  mfaVerified?: boolean;
  mfaEnforced?: boolean;
}

const storage = new AsyncLocalStorage<TenancyContext>();

export function runWithTenancyContext<T>(context: TenancyContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getTenancyContext(): TenancyContext | undefined {
  return storage.getStore();
}

export function requireTenancyContext(): TenancyContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "Tenancy context missing: this query ran outside of runWithTenancyContext(). Refusing to execute unscoped query on a tenant-scoped model.",
    );
  }
  return ctx;
}
