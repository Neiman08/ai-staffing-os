import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { WorkerAssignmentItem } from "./types";

export default function WorkerAssignmentsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-worker-assignments"],
    queryFn: () => apiFetch<WorkerAssignmentItem[]>("/portal/worker/assignments"),
  });

  return (
    <div>
      <PageHeader title="Assignments" description="Tus asignaciones actuales e historial." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data && data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job Order</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Inicio</TableHead>
                <TableHead>Fin</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">{a.companyName}</TableCell>
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
      </Card>
    </div>
  );
}
