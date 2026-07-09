import type { Paginated, PaginationQuery, PricingScenarioListItem } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";

export async function listPricingScenarios(
  query: PaginationQuery,
): Promise<Paginated<PricingScenarioListItem>> {
  const rows = await scopedDb.pricingScenario.findMany({
    ...buildCursorArgs(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { jobOrder: true, opportunity: true },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);

  return {
    items: items.map((scenario) => ({
      id: scenario.id,
      label: scenario.jobOrder?.title ?? scenario.opportunity?.title ?? "Escenario general",
      recommendedPayMin: scenario.recommendedPayMin.toString(),
      recommendedPayMax: scenario.recommendedPayMax.toString(),
      recommendedBillMin: scenario.recommendedBillMin.toString(),
      recommendedBillMax: scenario.recommendedBillMax.toString(),
      grossMarginPerHour: scenario.grossMarginPerHour.toString(),
      netMarginPerHour: scenario.netMarginPerHour?.toString() ?? null,
      hiringRisk: scenario.hiringRisk,
      dataConfidence: scenario.dataConfidence,
      status: scenario.status,
      rationale: scenario.rationale,
      createdAt: scenario.createdAt.toISOString(),
    })),
    nextCursor,
  };
}
