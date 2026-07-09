import type { Paginated, PaginationQuery, TimeEntryListItem } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";

export async function listTimeEntries(query: PaginationQuery): Promise<Paginated<TimeEntryListItem>> {
  const rows = await scopedDb.timeEntry.findMany({
    ...buildCursorArgs(query),
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: {
      assignment: {
        include: {
          worker: { include: { candidate: true } },
          jobOrder: true,
        },
      },
    },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);

  return {
    items: items.map((entry) => {
      const totalHours =
        Number(entry.regularHours) + Number(entry.overtimeHours) + Number(entry.doubleHours);
      const billRate = Number(entry.assignment.billRate);
      const payRate = Number(entry.assignment.payRate);
      const billAmount = totalHours * billRate;
      const payAmount = totalHours * payRate;

      return {
        id: entry.id,
        workerName: `${entry.assignment.worker.candidate.firstName} ${entry.assignment.worker.candidate.lastName}`,
        jobOrderTitle: entry.assignment.jobOrder.title,
        date: entry.date.toISOString(),
        regularHours: entry.regularHours.toString(),
        overtimeHours: entry.overtimeHours.toString(),
        doubleHours: entry.doubleHours.toString(),
        status: entry.status,
        source: entry.source,
        billAmount: billAmount.toFixed(2),
        payAmount: payAmount.toFixed(2),
        margin: (billAmount - payAmount).toFixed(2),
      };
    }),
    nextCursor,
  };
}
