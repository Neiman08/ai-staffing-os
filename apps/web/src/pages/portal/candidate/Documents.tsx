import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { CandidateDocumentItem } from "./types";

export default function CandidateDocumentsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-candidate-documents"],
    queryFn: () => apiFetch<CandidateDocumentItem[]>("/portal/candidate/documents"),
  });

  return (
    <div>
      <PageHeader title="Documents" description="Checklist de documentos requeridos para tu onboarding." />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data && data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Documento</TableHead>
                <TableHead>Vence</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">
                    {d.label}
                    {d.required && <span className="ml-1 text-xs text-destructive">*</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{d.expiresAt ? new Date(d.expiresAt).toLocaleDateString() : "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(d.status)}>{formatStatusLabel(d.status)}</Badge>
                    {d.rejectionReason && <p className="mt-1 text-xs text-destructive">{d.rejectionReason}</p>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin checklist de documentos todavía.</p>
        )}
      </Card>
    </div>
  );
}
