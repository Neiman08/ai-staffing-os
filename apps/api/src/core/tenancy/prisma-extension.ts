import { Prisma, prisma as basePrisma } from "@ai-staffing-os/db";
import { requireTenancyContext } from "./context";

/**
 * Models with a required (non-nullable) tenantId column. Every read/write
 * on these models must be scoped to the current tenant, or refused.
 */
const STRICT_TENANT_MODELS = new Set([
  "User",
  "Role",
  "Company",
  "Contact",
  "Lead",
  "Opportunity",
  "Activity",
  "Candidate",
  "Worker",
  "JobOrder",
  "Project",
  "Assignment",
  "Shift",
  "TimeEntry",
  "Document",
  "ComplianceAlert",
  "PayrollRun",
  "PayrollItem",
  "Invoice",
  "Contract",
  "LaborBurdenConfig",
  "PricingScenario",
  "AgentInstance",
  "AgentTask",
  "AgentMemory",
  "ApprovalRequest",
  "AuditLog",
  "DomainEvent",
  "Notification",
]);

/**
 * Models with a nullable tenantId that also hold globally-shared seed rows
 * (tenantId = null). Decision B1 (CHECKPOINT 0): these models must return
 * BOTH the tenant's own rows AND the global rows, never just one or the
 * other, so the extension applies `OR: [{ tenantId }, { tenantId: null }]`
 * instead of a strict equality filter. They are still refused outside of a
 * tenancy context to avoid accidental unscoped access.
 */
const HYBRID_GLOBAL_MODELS = new Set(["Industry", "JobCategory", "DocumentType", "RateBenchmark"]);

const READ_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);
const WRITE_MANY_OPERATIONS = new Set(["updateMany", "deleteMany"]);
const CREATE_OPERATIONS = new Set(["create", "createMany"]);

function withTenantWhere(where: Record<string, unknown> | undefined, tenantId: string) {
  return { AND: [where ?? {}, { tenantId }] };
}

function withHybridWhere(where: Record<string, unknown> | undefined, tenantId: string) {
  return { AND: [where ?? {}, { OR: [{ tenantId }, { tenantId: null }] }] };
}

function injectTenantIntoCreateData(data: unknown, tenantId: string) {
  if (Array.isArray(data)) {
    return data.map((item) => ({ ...item, tenantId }));
  }
  return { ...(data as Record<string, unknown>), tenantId };
}

export function createTenancyScopedClient() {
  return basePrisma.$extends({
    name: "tenancy-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const isStrict = STRICT_TENANT_MODELS.has(model);
          const isHybrid = HYBRID_GLOBAL_MODELS.has(model);

          if (!isStrict && !isHybrid) {
            return query(args);
          }

          const { tenantId } = requireTenancyContext();
          const typedArgs = args as { where?: Record<string, unknown>; data?: unknown };

          if (READ_OPERATIONS.has(operation) || WRITE_MANY_OPERATIONS.has(operation)) {
            typedArgs.where = isHybrid
              ? withHybridWhere(typedArgs.where, tenantId)
              : withTenantWhere(typedArgs.where, tenantId);
          } else if (CREATE_OPERATIONS.has(operation) && isStrict) {
            typedArgs.data = injectTenantIntoCreateData(typedArgs.data, tenantId);
          } else if (operation === "update" || operation === "delete" || operation === "upsert") {
            typedArgs.where = isHybrid
              ? withHybridWhere(typedArgs.where, tenantId)
              : withTenantWhere(typedArgs.where, tenantId);
          }

          return query(typedArgs as typeof args);
        },
      },
    },
  });
}

export type TenancyScopedClient = ReturnType<typeof createTenancyScopedClient>;

/**
 * Single shared instance: the extension reads tenancy context per-call via
 * AsyncLocalStorage, so one client can safely serve every request — there
 * is no per-request state to isolate here.
 */
export const scopedDb = createTenancyScopedClient();

// Re-exported for callers that need the raw Prisma namespace (error types, etc).
export { Prisma };
