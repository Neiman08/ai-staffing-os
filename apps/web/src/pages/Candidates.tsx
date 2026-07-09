import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CandidateListItem, Paginated } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { NewButton } from "@/components/shared/NewButton";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";

export default function Candidates() {
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading } = useQuery({
    queryKey: ["candidates", cursor],
    queryFn: () =>
      apiFetch<Paginated<CandidateListItem>>(
        `/candidates?limit=20${cursor ? `&cursor=${cursor}` : ""}`,
      ),
  });

  return (
    <div>
      <PageHeader
        title="Candidates"
        description="Talento en proceso de selección"
        action={<NewButton label="New Candidate" />}
      />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Ubicación</TableHead>
                <TableHead>Categorías</TableHead>
                <TableHead>Idiomas</TableHead>
                <TableHead>AI Score</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((candidate) => (
                <TableRow key={candidate.id}>
                  <TableCell className="font-medium">
                    {candidate.firstName} {candidate.lastName}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {candidate.city && candidate.state ? `${candidate.city}, ${candidate.state}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {candidate.categoryNames.join(", ") || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {candidate.languages.join(", ").toUpperCase() || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {candidate.aiScore != null ? candidate.aiScore.toFixed(1) : "—"}
                  </TableCell>
                  <TableCell>
                    {candidate.isWorker ? (
                      <Badge variant="success">Worker</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(candidate.status)}>{formatStatusLabel(candidate.status)}</Badge>
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
