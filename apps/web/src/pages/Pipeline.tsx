import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import type { OpportunityListItem, PipelineResponse } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatStatusLabel, statusVariant } from "@/lib/status";

function KanbanCard({ opportunity }: { opportunity: OpportunityListItem }) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: opportunity.id });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => !isDragging && navigate(`/companies/${opportunity.companyId}`)}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 10 }
          : undefined
      }
      className={cn(
        "cursor-grab space-y-1.5 rounded-md border border-border bg-card p-3 text-sm shadow-sm active:cursor-grabbing",
        isDragging && "opacity-50",
      )}
    >
      <div className="font-medium leading-snug">{opportunity.title}</div>
      <div className="text-xs text-muted-foreground">{opportunity.companyName}</div>
      <div className="flex items-center justify-between pt-1">
        <span className="text-xs font-medium">
          {opportunity.estimatedRevenue ? `$${Number(opportunity.estimatedRevenue).toLocaleString()}` : "—"}
        </span>
        {opportunity.probability != null && (
          <Badge variant="neutral" className="text-[10px]">
            {opportunity.probability}%
          </Badge>
        )}
      </div>
    </div>
  );
}

function KanbanColumn({
  stage,
  totalValue,
  opportunities,
}: {
  stage: string;
  totalValue: string;
  opportunities: OpportunityListItem[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-1">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {formatStatusLabel(stage)}
          </div>
          <div className="text-xs text-muted-foreground">${Number(totalValue).toLocaleString()}</div>
        </div>
        <Badge variant={statusVariant(stage)}>{opportunities.length}</Badge>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-[400px] flex-col gap-2 rounded-md border border-dashed border-border p-2 transition-colors",
          isOver && "border-primary bg-primary/5",
        )}
      >
        {opportunities.map((o) => (
          <KanbanCard key={o.id} opportunity={o} />
        ))}
      </div>
    </div>
  );
}

export default function Pipeline() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [optimisticMove, setOptimisticMove] = useState<{ id: string; stage: string } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const { data, isLoading } = useQuery({
    queryKey: ["pipeline"],
    queryFn: () => apiFetch<PipelineResponse>("/pipeline"),
  });

  const stageMutation = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) =>
      apiFetch(`/opportunities/${id}/stage`, { method: "PATCH", body: JSON.stringify({ stage }) }),
    onSuccess: () => {
      toast({ title: "Oportunidad movida", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["pipeline"] });
    },
    onError: (err) => {
      toast({ title: "No se pudo mover la oportunidad", description: String(err), variant: "error" });
      setOptimisticMove(null);
    },
  });

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const opportunityId = String(active.id);
    const targetStage = String(over.id);

    const currentColumn = data?.columns.find((c) => c.opportunities.some((o) => o.id === opportunityId));
    if (!currentColumn || currentColumn.stage === targetStage) return;

    setOptimisticMove({ id: opportunityId, stage: targetStage });
    stageMutation.mutate({ id: opportunityId, stage: targetStage });
  }

  const columns = data?.columns.map((col) => {
    if (!optimisticMove) return col;
    const withoutMoved = col.opportunities.filter((o) => o.id !== optimisticMove.id);
    if (col.stage === optimisticMove.stage) {
      const moved = data?.columns.flatMap((c) => c.opportunities).find((o) => o.id === optimisticMove.id);
      return { ...col, opportunities: moved ? [{ ...moved, stage: col.stage }, ...withoutMoved] : withoutMoved };
    }
    return { ...col, opportunities: withoutMoved };
  });

  return (
    <div>
      <PageHeader title="Pipeline" description="Arrastra una oportunidad para cambiar su etapa" />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div className="flex gap-4 overflow-x-auto pb-4">
            {columns?.map((col) => (
              <KanbanColumn key={col.stage} stage={col.stage} totalValue={col.totalValue} opportunities={col.opportunities} />
            ))}
          </div>
        </DndContext>
      )}
    </div>
  );
}
