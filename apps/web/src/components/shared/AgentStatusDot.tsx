import { cn } from "@/lib/utils";

/**
 * F3.5: indicador de "vivo" — un agente con una tarea QUEUED/RUNNING real
 * (derivado de /agents/tasks, nunca simulado) muestra el punto animado.
 */
export function AgentStatusDot({ active, className }: { active: boolean; className?: string }) {
  return (
    <span className={cn("relative flex h-2.5 w-2.5", className)}>
      {active && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
      )}
      <span
        className={cn(
          "relative inline-flex h-2.5 w-2.5 rounded-full",
          active ? "bg-emerald-500" : "bg-muted-foreground/40",
        )}
      />
    </span>
  );
}
