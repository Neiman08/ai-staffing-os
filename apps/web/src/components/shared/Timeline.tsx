import { Bot, Calendar, FileText, Mail, MessageSquare, Phone, Settings } from "lucide-react";
import type { ActivityItem } from "@ai-staffing-os/shared";

const TYPE_ICON: Record<string, typeof Phone> = {
  CALL: Phone,
  EMAIL: Mail,
  MEETING: Calendar,
  NOTE: MessageSquare,
  TASK: FileText,
  SYSTEM: Settings,
};

export function Timeline({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin actividad todavía.</p>;
  }

  return (
    <ol className="space-y-4">
      {items.map((item) => {
        const Icon = TYPE_ICON[item.type] ?? MessageSquare;
        const isAgent = item.performedByLabel.toLowerCase().includes("agent");
        return (
          <li key={item.id} className="flex gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              {isAgent ? <Bot className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
            </div>
            <div className="min-w-0 flex-1 border-b border-border pb-4 last:border-0 last:pb-0">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{item.subject}</p>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </div>
              {item.body && <p className="mt-0.5 text-sm text-muted-foreground">{item.body}</p>}
              <p className="mt-1 text-xs text-muted-foreground">{item.performedByLabel}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
