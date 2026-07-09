import type { JobOrderListItem, Paginated, PaginationQuery } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";

export async function listJobOrders(query: PaginationQuery): Promise<Paginated<JobOrderListItem>> {
  const rows = await scopedDb.jobOrder.findMany({
    ...buildCursorArgs(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { company: true, category: true },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);

  return {
    items: items.map((jobOrder) => ({
      id: jobOrder.id,
      title: jobOrder.title,
      companyName: jobOrder.company.name,
      categoryName: jobOrder.category.name,
      status: jobOrder.status,
      workersNeeded: jobOrder.workersNeeded,
      workersFilled: jobOrder.workersFilled,
      billRate: jobOrder.billRate.toString(),
      payRate: jobOrder.payRate.toString(),
      shiftType: jobOrder.shiftType,
      urgency: jobOrder.urgency,
      startDate: jobOrder.startDate.toISOString(),
    })),
    nextCursor,
  };
}
