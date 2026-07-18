import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { CandidateApplicationItem } from "./types";

// F10.4: nunca muestra rank/score/reasons/gaps/risks -- solo el estado
// de calificación y de shortlist, sin exponer lógica interna de
// recruiting ni tu posición frente a otros candidatos.
export default function CandidateApplicationsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-candidate-applications"],
    queryFn: () => apiFetch<CandidateApplicationItem[]>("/portal/candidate/applications"),
  });

  return (
    <div>
      <PageHeader title="Applications" description="Job Orders donde estás calificado." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data && data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job Order</TableHead>
                <TableHead>Calificación</TableHead>
                <TableHead>Shortlist</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((a) => (
                <TableRow key={a.jobOrderId}>
                  <TableCell className="font-medium">{a.jobOrderTitle}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(a.qualificationStatus)}>{formatStatusLabel(a.qualificationStatus)}</Badge>
                  </TableCell>
                  <TableCell>
                    {a.shortlistReviewStatus ? (
                      <Badge variant={statusVariant(a.shortlistReviewStatus)}>{formatStatusLabel(a.shortlistReviewStatus)}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin postulaciones calificadas todavía.</p>
        )}
      </Card>
    </div>
  );
}
