import type {
  ComplianceAlertListItem,
  DocumentListItem,
  DocumentTypeListItem,
  Paginated,
  PaginationQuery,
} from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";

export async function listDocuments(query: PaginationQuery): Promise<Paginated<DocumentListItem>> {
  const rows = await scopedDb.document.findMany({
    ...buildCursorArgs(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      documentType: true,
      candidate: true,
      worker: { include: { candidate: true } },
    },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);

  return {
    items: items.map((doc) => {
      const ownerType: "candidate" | "worker" = doc.workerId ? "worker" : "candidate";
      const ownerCandidate = doc.workerId ? doc.worker?.candidate : doc.candidate;
      const ownerLabel = ownerCandidate ? `${ownerCandidate.firstName} ${ownerCandidate.lastName}` : "—";

      return {
        id: doc.id,
        documentTypeName: doc.documentType.name,
        ownerLabel,
        ownerType,
        status: doc.status,
        issuedDate: doc.issuedDate?.toISOString() ?? null,
        expirationDate: doc.expirationDate?.toISOString() ?? null,
        verifiedByAgent: doc.verifiedByAgent,
      };
    }),
    nextCursor,
  };
}

export async function listComplianceAlerts(
  query: PaginationQuery,
): Promise<Paginated<ComplianceAlertListItem>> {
  const rows = await scopedDb.complianceAlert.findMany({
    ...buildCursorArgs(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { worker: { include: { candidate: true } } },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);

  return {
    items: items.map((alert) => ({
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      workerName: alert.worker?.candidate
        ? `${alert.worker.candidate.firstName} ${alert.worker.candidate.lastName}`
        : null,
      resolvedAt: alert.resolvedAt?.toISOString() ?? null,
      createdAt: alert.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function listDocumentTypes(): Promise<DocumentTypeListItem[]> {
  const types = await scopedDb.documentType.findMany({ orderBy: { name: "asc" } });
  return types.map((type) => ({
    id: type.id,
    key: type.key,
    name: type.name,
    category: type.category,
    requiresExpiration: type.requiresExpiration,
  }));
}
