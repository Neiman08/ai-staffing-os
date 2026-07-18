import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { InternalJobRequestListItem } from "./portal-internal-types";

const STATUS_FILTERS = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "NEEDS_INFORMATION", "APPROVED", "CONVERTED_TO_JOB_ORDER", "REJECTED", "CANCELLED"];

/**
 * F10.3: revisión interna de solicitudes de personal originadas por
 * clientes -- nunca las convierte a JobOrder automáticamente, ver
 * ClientJobRequestDetail.tsx.
 */
export default function ClientJobRequests() {
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  if (status) params.set("status", status);

  const { data, isLoading } = useQuery({
    queryKey: ["client-job-requests", cursor, status],
    queryFn: () => apiFetch<{ items: InternalJobRequestListItem[]; nextCursor: string | null }>(`/client-job-requests?${params.toString()}`),
  });

  function resetAndFilter(fn: () => void) {
    fn();
    setCursorStack([undefined]);
  }

  return (
    <div>
      <PageHeader title="Client Job Requests" description="Solicitudes de personal originadas por clientes, pendientes de revisión." />

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="w-56">
          <Label htmlFor="statusFilter">Estado</Label>
          <Select id="statusFilter" value={status} onChange={(e) => resetAndFilter(() => setStatus(e.target.value))}>
            <option value="">Todos</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Empresa</TableHead>
                <TableHead>Puesto</TableHead>
                <TableHead>Cantidad</TableHead>
                <TableHead>Inicio deseado</TableHead>
                <TableHead>Urgencia</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/client-job-requests/${r.id}`)}>
                  <TableCell className="font-medium">{r.companyName}</TableCell>
                  <TableCell className="text-muted-foreground">{r.requestedTitle}</TableCell>
                  <TableCell className="text-muted-foreground">{r.headcount}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(r.desiredStartDate).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(r.urgency)}>{formatStatusLabel(r.urgency)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(r.status)}>{formatStatusLabel(r.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin solicitudes todavía.</p>
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
