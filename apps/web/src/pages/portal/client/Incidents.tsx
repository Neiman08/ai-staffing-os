import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { ClientIncidentListItem } from "./types";

export default function ClientIncidents() {
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);

  const { data, isLoading } = useQuery({
    queryKey: ["portal-client-incidents", cursor],
    queryFn: () => apiFetch<{ items: ClientIncidentListItem[]; nextCursor: string | null }>(`/portal/client/incidents?${params.toString()}`),
  });

  return (
    <div>
      <PageHeader title="Incidents" description="Eventos operativos reportados relacionados con tu cuenta." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium">{formatStatusLabel(i.type)}</TableCell>
                  <TableCell className="text-muted-foreground">{i.workerName ?? "—"}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground" title={i.description}>
                    {i.description}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{new Date(i.occurredAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(i.status)}>{formatStatusLabel(i.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin incidentes reportados.</p>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>
    </div>
  );
}
