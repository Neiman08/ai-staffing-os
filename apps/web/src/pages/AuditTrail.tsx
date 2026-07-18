// F10.9: Portal Audit Trail -- página compartida entre el shell
// interno (`/audit-log`) y los 3 portales (`/portal/{client,worker,
// candidate}/audit-log`), parametrizada por `endpoint`. El scoping
// real (tenant completo vs. company vs. propio historial) ocurre
// siempre en el backend -- este componente nunca decide qué mostrar,
// solo renderiza lo que el endpoint ya devolvió correctamente filtrado.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel } from "@/lib/status";

interface AuditLogEntry {
  id: string;
  actorType: string;
  actorId: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

export default function AuditTrail({ endpoint, description }: { endpoint: string; description: string }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const params = new URLSearchParams({ limit: "25" });
  if (cursor) params.set("cursor", cursor);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  if (entityType) params.set("entityType", entityType);
  if (action) params.set("action", action);

  const { data, isLoading } = useQuery({
    queryKey: [endpoint, cursor, dateFrom, dateTo, entityType, action],
    queryFn: () => apiFetch<{ items: AuditLogEntry[]; nextCursor: string | null }>(`${endpoint}?${params.toString()}`),
  });

  function resetAndFilter(fn: () => void) {
    fn();
    setCursorStack([undefined]);
  }

  return (
    <div>
      <PageHeader title="Audit Trail" description={description} />

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-3">
        <div>
          <Label htmlFor="audit-date-from">Desde</Label>
          <Input id="audit-date-from" type="date" value={dateFrom} onChange={(e) => resetAndFilter(() => setDateFrom(e.target.value))} />
        </div>
        <div>
          <Label htmlFor="audit-date-to">Hasta</Label>
          <Input id="audit-date-to" type="date" value={dateTo} onChange={(e) => resetAndFilter(() => setDateTo(e.target.value))} />
        </div>
        <div>
          <Label htmlFor="audit-entity-type">Recurso</Label>
          <Input id="audit-entity-type" placeholder="ej. timeEntry" value={entityType} onChange={(e) => resetAndFilter(() => setEntityType(e.target.value))} />
        </div>
        <div>
          <Label htmlFor="audit-action">Acción</Label>
          <Input id="audit-action" placeholder="ej. approved" value={action} onChange={(e) => resetAndFilter(() => setAction(e.target.value))} />
        </div>
      </Card>

      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Actor</TableHead>
                <TableHead>Acción</TableHead>
                <TableHead>Recurso</TableHead>
                <TableHead>Fecha</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">
                    {e.actorLabel}
                    <span className="ml-1 text-xs text-muted-foreground">({formatStatusLabel(e.actorType)})</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{e.action}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatStatusLabel(e.entityType)} · {e.entityId}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">No hay actividad registrada todavía.</p>
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
