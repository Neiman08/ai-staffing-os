import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import type { AgentInstanceListItem } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";

export default function AgentsCenter() {
  const { data, isLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiFetch<AgentInstanceListItem[]>("/agents"),
  });

  return (
    <div>
      <PageHeader title="AI Agents Center" description="Agentes activos para este tenant" />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando agentes…</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data?.map((agent) => {
            const tasksCompleted = (agent.metrics as { tasksCompleted?: number })?.tasksCompleted ?? 0;
            return (
              <Card key={agent.id}>
                <CardHeader className="flex-row items-start justify-between space-y-0">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary">
                      <Bot className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-foreground">{agent.name}</div>
                      <div className="text-xs text-muted-foreground">{agent.key}</div>
                    </div>
                  </div>
                  <Badge variant={agent.isActive ? "success" : "neutral"}>
                    {agent.isActive ? "Activo" : "Inactivo"}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">{agent.description}</p>
                  <div className="flex items-center justify-between border-t border-border pt-3 text-xs">
                    <span className="text-muted-foreground">Autonomía</span>
                    <Badge variant={statusVariant(agent.autonomyLevel)}>
                      {formatStatusLabel(agent.autonomyLevel)}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Tareas completadas</span>
                    <span className="font-medium">{tasksCompleted}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
