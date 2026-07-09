import type { CompanyListItem, Paginated, PaginationQuery } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";

export async function listCompanies(query: PaginationQuery): Promise<Paginated<CompanyListItem>> {
  const rows = await scopedDb.company.findMany({
    ...buildCursorArgs(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      industry: true,
      _count: { select: { contacts: true } },
    },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);

  return {
    items: items.map((company) => {
      const address = company.address as { city?: string; state?: string } | null;
      return {
        id: company.id,
        name: company.name,
        status: company.status,
        industryName: company.industry.name,
        city: address?.city ?? null,
        state: address?.state ?? null,
        contactCount: company._count.contacts,
        createdAt: company.createdAt.toISOString(),
      };
    }),
    nextCursor,
  };
}
