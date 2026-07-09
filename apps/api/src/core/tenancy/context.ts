import { AsyncLocalStorage } from "node:async_hooks";

export interface TenancyContext {
  tenantId: string;
  userId: string;
  permissions: string[];
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
