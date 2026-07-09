import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ComplianceAlertListItem,
  DocumentListItem,
  Paginated,
} from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatStatusLabel, statusVariant } from "@/lib/status";

type Tab = "documents" | "alerts";

export default function Compliance() {
  const [tab, setTab] = useState<Tab>("documents");
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  function switchTab(next: Tab) {
    setTab(next);
    setCursorStack([undefined]);
  }

  const documentsQuery = useQuery({
    queryKey: ["documents", cursor],
    queryFn: () =>
      apiFetch<Paginated<DocumentListItem>>(`/documents?limit=20${cursor ? `&cursor=${cursor}` : ""}`),
    enabled: tab === "documents",
  });

  const alertsQuery = useQuery({
    queryKey: ["compliance-alerts", cursor],
    queryFn: () =>
      apiFetch<Paginated<ComplianceAlertListItem>>(
        `/compliance/alerts?limit=20${cursor ? `&cursor=${cursor}` : ""}`,
      ),
    enabled: tab === "alerts",
  });

  const activeQuery = tab === "documents" ? documentsQuery : alertsQuery;

  return (
    <div>
      <PageHeader title="Compliance" description="Documentos, verificaciones y alertas de vencimiento" />

      <div className="mb-4 flex gap-1 rounded-md border border-border bg-secondary/40 p-1 w-fit">
        {(["documents", "alerts"] as const).map((t) => (
          <Button
            key={t}
            variant={tab === t ? "default" : "ghost"}
            size="sm"
            onClick={() => switchTab(t)}
            className={cn(tab !== t && "text-muted-foreground")}
          >
            {t === "documents" ? "Documentos" : "Alertas"}
          </Button>
        ))}
      </div>

      <Card>
        {activeQuery.isLoading ? (
          <LoadingTable />
        ) : tab === "documents" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Documento</TableHead>
                <TableHead>Propietario</TableHead>
                <TableHead>Vencimiento</TableHead>
                <TableHead>Verificado por IA</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documentsQuery.data?.items.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium">{doc.documentTypeName}</TableCell>
                  <TableCell className="text-muted-foreground">{doc.ownerLabel}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {doc.expirationDate ? new Date(doc.expirationDate).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{doc.verifiedByAgent ? "Sí" : "No"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(doc.status)}>{formatStatusLabel(doc.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Trabajador</TableHead>
                <TableHead>Mensaje</TableHead>
                <TableHead>Severidad</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {alertsQuery.data?.items.map((alert) => (
                <TableRow key={alert.id}>
                  <TableCell className="font-medium">{formatStatusLabel(alert.type)}</TableCell>
                  <TableCell className="text-muted-foreground">{alert.workerName ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{alert.message}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(alert.severity)}>{formatStatusLabel(alert.severity)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={alert.resolvedAt ? "success" : "warning"}>
                      {alert.resolvedAt ? "Resuelta" : "Pendiente"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!activeQuery.data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() =>
            activeQuery.data?.nextCursor &&
            setCursorStack((stack) => [...stack, activeQuery.data!.nextCursor!])
          }
        />
      </Card>
    </div>
  );
}
