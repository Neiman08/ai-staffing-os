import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { ClientJobOrderListItem } from "./types";

export default function ClientJobOrders() {
  const navigate = useNavigate();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);

  const { data, isLoading } = useQuery({
    queryKey: ["portal-client-job-orders", cursor],
    queryFn: () => apiFetch<{ items: ClientJobOrderListItem[]; nextCursor: string | null }>(`/portal/client/job-orders?${params.toString()}`),
  });

  return (
    <div>
      <PageHeader title="Job Orders" description="Tus solicitudes de personal activas y su estado real." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Workers</TableHead>
                <TableHead>Inicio</TableHead>
                <TableHead>Fin</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((jo) => (
                <TableRow key={jo.id} className="cursor-pointer" onClick={() => navigate(`/portal/client/job-orders/${jo.id}`)}>
                  <TableCell className="font-medium">{jo.title}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {jo.workersFilled} / {jo.workersNeeded}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{new Date(jo.startDate).toLocaleDateString()}</TableCell>
                  <TableCell className="text-muted-foreground">{jo.endDate ? new Date(jo.endDate).toLocaleDateString() : "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(jo.status)}>{formatStatusLabel(jo.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin Job Orders todavía.</p>
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
