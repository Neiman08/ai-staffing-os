import type {
  CandidateListItem,
  IndustryListItem,
  JobCategoryListItem,
  Paginated,
  PaginationQuery,
} from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";

export async function listCandidates(query: PaginationQuery): Promise<Paginated<CandidateListItem>> {
  const rows = await scopedDb.candidate.findMany({
    ...buildCursorArgs(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      categories: true,
      worker: { select: { id: true } },
    },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);

  return {
    items: items.map((candidate) => ({
      id: candidate.id,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      email: candidate.email,
      phone: candidate.phone,
      city: candidate.city,
      state: candidate.state,
      languages: candidate.languages,
      categoryNames: candidate.categories.map((c) => c.name),
      status: candidate.status,
      aiScore: candidate.aiScore,
      isWorker: !!candidate.worker,
      createdAt: candidate.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function listIndustries(): Promise<IndustryListItem[]> {
  const industries = await scopedDb.industry.findMany({ orderBy: { name: "asc" } });
  return industries.map((industry) => ({
    id: industry.id,
    name: industry.name,
    isGlobal: industry.isGlobal,
  }));
}

export async function listJobCategories(): Promise<JobCategoryListItem[]> {
  const categories = await scopedDb.jobCategory.findMany({
    include: { industry: true },
    orderBy: { name: "asc" },
  });
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    industryName: category.industry?.name ?? null,
    requiredCertifications: (category.requiredCertifications as string[]) ?? [],
  }));
}
