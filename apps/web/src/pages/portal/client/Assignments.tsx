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
import type { ClientAssignmentListItem } from "./types";

export default function ClientAssignments() {
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);

  const { data, isLoading } = useQuery({
    queryKey: ["portal-client-assignments", cursor],
    queryFn: () => apiFetch<{ items: ClientAssignmentListItem[]; nextCursor: string | null }>(`/portal/client/assignments?${params.toString()}`),
  });

  return (
    <div>
      <PageHeader title="Assignments" description="Historial y estado real de las asignaciones para tu Company." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Job Order</TableHead>
                <TableHead>Inicio</TableHead>
                <TableHead>Fin</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.workerName}</TableCell>
                  <TableCell className="text-muted-foreground">{a.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(a.startDate).toLocaleDateString()}</TableCell>
                  <TableCell className="text-muted-foreground">{a.endDate ? new Date(a.endDate).toLocaleDateString() : "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(a.status)}>{formatStatusLabel(a.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin Assignments todavía.</p>
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
