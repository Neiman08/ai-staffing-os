import { Prisma, prisma as basePrisma } from "@ai-staffing-os/db";
import { AppError } from "../errors";
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
  "CandidateQualification",
  "CandidateMatch",
  "CandidateShortlistEntry",
  "ScreeningPlan",
  "InterviewPreview",
  "PlacementReadiness",
  "WorkerOnboarding",
  "DocumentChecklistItem",
  "ComplianceRule",
  "ComplianceRuleEvaluation",
  "Placement",
  "Project",
  "Assignment",
  "Shift",
  "TimeEntry",
  "OperationalIncident",
  "ClientJobRequest",
  "Document",
  "ComplianceAlert",
  "PayrollRun",
  "PayrollItem",
  "Invoice",
  "Payment",
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

// findMany/findFirst/count/aggregate/groupBy/updateMany/deleteMany all take
// a plain WhereInput, which supports arbitrary AND/OR nesting.
const MULTI_ROW_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

// findUnique/findUniqueOrThrow require a WhereUniqueInput: Prisma rejects
// extra filters wrapped in AND/OR at runtime (it only accepts the actual
// unique fields — id, or a compound unique — at the top level), even though
// the generated TS types don't catch this. They are redirected below to the
// findFirst equivalent, which has no such restriction.
const UNIQUE_LOOKUP_OPERATIONS = new Set(["findUnique", "findUniqueOrThrow"]);

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

function modelAccessor(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

type Delegate = Record<string, (a: unknown) => unknown>;

function getDelegate(model: string): Delegate {
  return (basePrisma as unknown as Record<string, Delegate>)[modelAccessor(model)]!;
}

/**
 * F1: verify-then-act. update/delete/upsert require a WhereUniqueInput,
 * which — like findUnique (see UNIQUE_LOOKUP_OPERATIONS above) — rejects a
 * tenant filter wrapped in AND/OR at runtime. Instead: look the row up with
 * a tenant-scoped findFirst first: if it doesn't come back, refuse before
 * ever touching the real unique `where`, so a caller can never mutate a row
 * that belongs to another tenant even though the final write itself uses an
 * unscoped, unique `where`.
 */
async function verifyOwnership(
  model: string,
  where: Record<string, unknown>,
  tenantId: string,
  isHybrid: boolean,
): Promise<boolean> {
  const mergeWhere = isHybrid ? withHybridWhere : withTenantWhere;
  const row = await getDelegate(model).findFirst!({ where: mergeWhere(where, tenantId) });
  return !!row;
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
          const mergeWhere = isHybrid ? withHybridWhere : withTenantWhere;

          if (MULTI_ROW_OPERATIONS.has(operation)) {
            typedArgs.where = mergeWhere(typedArgs.where, tenantId);
            return query(typedArgs as typeof args);
          }

          if (UNIQUE_LOOKUP_OPERATIONS.has(operation)) {
            const delegate = (basePrisma as unknown as Record<string, Record<string, (a: unknown) => unknown>>)[
              modelAccessor(model)
            ]!;
            const findMethod = operation === "findUnique" ? "findFirst" : "findFirstOrThrow";
            return delegate[findMethod]!({
              ...typedArgs,
              where: mergeWhere(typedArgs.where, tenantId),
            });
          }

          if (CREATE_OPERATIONS.has(operation) && isStrict) {
            typedArgs.data = injectTenantIntoCreateData(typedArgs.data, tenantId);
            return query(typedArgs as typeof args);
          }

          if (operation === "update" || operation === "delete") {
            const belongs = await verifyOwnership(model, typedArgs.where ?? {}, tenantId, isHybrid);
            if (!belongs) {
              throw AppError.notFound(`${model} not found`);
            }
            // Verified: the original, unwrapped unique `where` is now safe.
            return query(typedArgs as typeof args);
          }

          if (operation === "upsert") {
            const upsertArgs = args as { where: Record<string, unknown>; create: unknown; update: unknown };
            const belongs = await verifyOwnership(model, upsertArgs.where, tenantId, isHybrid);
            const delegate = getDelegate(model);

            if (belongs) {
              return delegate.update!({ where: upsertArgs.where, data: upsertArgs.update });
            }
            const createData = isStrict ? injectTenantIntoCreateData(upsertArgs.create, tenantId) : upsertArgs.create;
            return delegate.create!({ data: createData });
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
