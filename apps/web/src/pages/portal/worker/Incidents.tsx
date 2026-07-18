import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { WorkerIncidentItem } from "./types";

export default function WorkerIncidentsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-worker-incidents"],
    queryFn: () => apiFetch<WorkerIncidentItem[]>("/portal/worker/incidents"),
  });

  return (
    <div>
      <PageHeader title="Incidents" description="Eventos operativos reportados relacionados contigo." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data && data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium">{formatStatusLabel(i.type)}</TableCell>
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
      </Card>
    </div>
  );
}
