import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { ClientWorkerListItem } from "./types";

export default function ClientWorkers() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-client-workers"],
    queryFn: () => apiFetch<ClientWorkerListItem[]>("/portal/client/workers"),
  });

  return (
    <div>
      <PageHeader title="Workers" description="Personal actualmente asignado a tus Job Orders." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data && data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Job Order</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((w) => (
                <TableRow key={`${w.workerId}-${w.jobOrderTitle}`}>
                  <TableCell className="font-medium">{w.name}</TableCell>
                  <TableCell className="text-muted-foreground">{w.jobOrderTitle}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(w.assignmentStatus)}>{formatStatusLabel(w.assignmentStatus)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin Workers asignados todavía.</p>
        )}
      </Card>
    </div>
  );
}
