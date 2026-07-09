import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Paginated, TimeEntryListItem } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";

export default function Payroll() {
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading } = useQuery({
    queryKey: ["time-entries", cursor],
    queryFn: () =>
      apiFetch<Paginated<TimeEntryListItem>>(
        `/time-entries?limit=20${cursor ? `&cursor=${cursor}` : ""}`,
      ),
  });

  return (
    <div>
      <PageHeader title="Payroll" description="Horas registradas y márgenes por asignación (solo lectura en F0)" />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Trabajador</TableHead>
                <TableHead>Job Order</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Reg / OT / Doble</TableHead>
                <TableHead>Bill</TableHead>
                <TableHead>Pay</TableHead>
                <TableHead>Margen</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-medium">{entry.workerName}</TableCell>
                  <TableCell className="text-muted-foreground">{entry.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(entry.date).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {entry.regularHours} / {entry.overtimeHours} / {entry.doubleHours}
                  </TableCell>
                  <TableCell className="text-muted-foreground">${entry.billAmount}</TableCell>
                  <TableCell className="text-muted-foreground">${entry.payAmount}</TableCell>
                  <TableCell className="font-medium text-emerald-600 dark:text-emerald-400">
                    ${entry.margin}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(entry.status)}>{formatStatusLabel(entry.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
