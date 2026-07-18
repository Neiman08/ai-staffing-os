import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { WorkerTimeEntryItem } from "./types";

// F10.4: solo lectura -- el flujo de crear/enviar horas propias llega
// en F10.7 (Time Entry UX), subfase dedicada.
export default function WorkerTimeEntriesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-worker-time-entries"],
    queryFn: () => apiFetch<{ items: WorkerTimeEntryItem[]; nextCursor: string | null }>("/portal/worker/time-entries?limit=50"),
  });

  return (
    <div>
      <PageHeader title="Time Entries" description="Tus horas registradas." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job Order</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Reg / OT / Doble</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(t.date).toLocaleDateString()}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {t.regularHours} / {t.overtimeHours} / {t.doubleHours}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(t.status)}>{formatStatusLabel(t.status)}</Badge>
                    {t.rejectionReason && <p className="mt-1 text-xs text-destructive">{t.rejectionReason}</p>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin horas registradas todavía.</p>
        )}
      </Card>
    </div>
  );
}
