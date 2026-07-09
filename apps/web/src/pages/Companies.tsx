import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyListItem, Paginated } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { NewButton } from "@/components/shared/NewButton";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";

export default function Companies() {
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading } = useQuery({
    queryKey: ["companies", cursor],
    queryFn: () =>
      apiFetch<Paginated<CompanyListItem>>(
        `/companies?limit=20${cursor ? `&cursor=${cursor}` : ""}`,
      ),
  });

  return (
    <div>
      <PageHeader
        title="Companies"
        description="Clientes y prospectos de la agencia"
        action={<NewButton label="New Company" />}
      />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Industria</TableHead>
                <TableHead>Ubicación</TableHead>
                <TableHead>Contactos</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((company) => (
                <TableRow key={company.id}>
                  <TableCell className="font-medium">{company.name}</TableCell>
                  <TableCell className="text-muted-foreground">{company.industryName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.city && company.state ? `${company.city}, ${company.state}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{company.contactCount}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(company.status)}>{formatStatusLabel(company.status)}</Badge>
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
