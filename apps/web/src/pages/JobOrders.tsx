import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { JobOrderListItem, Paginated } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { NewButton } from "@/components/shared/NewButton";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";

export default function JobOrders() {
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading } = useQuery({
    queryKey: ["job-orders", cursor],
    queryFn: () =>
      apiFetch<Paginated<JobOrderListItem>>(
        `/job-orders?limit=20${cursor ? `&cursor=${cursor}` : ""}`,
      ),
  });

  return (
    <div>
      <PageHeader
        title="Job Orders"
        description="Vacantes activas de clientes"
        action={<NewButton label="New Job Order" />}
      />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Categoría</TableHead>
                <TableHead>Fill</TableHead>
                <TableHead>Bill / Pay</TableHead>
                <TableHead>Turno</TableHead>
                <TableHead>Urgencia</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((jobOrder) => (
                <TableRow key={jobOrder.id}>
                  <TableCell className="font-medium">{jobOrder.title}</TableCell>
                  <TableCell className="text-muted-foreground">{jobOrder.companyName}</TableCell>
                  <TableCell className="text-muted-foreground">{jobOrder.categoryName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {jobOrder.workersFilled}/{jobOrder.workersNeeded}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    ${Number(jobOrder.billRate).toFixed(2)} / ${Number(jobOrder.payRate).toFixed(2)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatStatusLabel(jobOrder.shiftType)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(jobOrder.urgency)}>{formatStatusLabel(jobOrder.urgency)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(jobOrder.status)}>{formatStatusLabel(jobOrder.status)}</Badge>
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
