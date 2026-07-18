// F10.8: historial completo -- compartido entre el shell interno y los
// 3 shells de portal (mismos endpoints `/notifications*`, ya
// scope-eados por userId/recipientRole en el backend).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatStatusLabel, statusVariant } from "@/lib/status";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  priority: string;
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

export default function NotificationsCenter() {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  if (unreadOnly) params.set("unreadOnly", "true");

  const { data, isLoading } = useQuery({
    queryKey: ["notifications-center", cursor, unreadOnly],
    queryFn: () => apiFetch<{ items: NotificationItem[]; nextCursor: string | null }>(`/notifications?${params.toString()}`),
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/notifications/${id}/read`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications-center"] });
      queryClient.invalidateQueries({ queryKey: ["notifications-unread-count"] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Tu historial de notificaciones."
        action={
          <Button
            size="sm"
            variant={unreadOnly ? "default" : "outline"}
            onClick={() => {
              setUnreadOnly((v) => !v);
              setCursorStack([undefined]);
            }}
          >
            {unreadOnly ? "Showing unread" : "Show unread only"}
          </Button>
        }
      />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <ul>
            {data.items.map((n) => (
              <li key={n.id} className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0">
                <div className="flex items-start gap-3">
                  {!n.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={n.readAt ? "font-normal text-muted-foreground" : "font-medium"}>{n.title}</span>
                      <Badge variant={statusVariant(n.priority)}>{formatStatusLabel(n.priority)}</Badge>
                    </div>
                    {n.body && <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p>}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatStatusLabel(n.type)} · {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                {!n.readAt && (
                  <Button size="sm" variant="ghost" disabled={markReadMutation.isPending} onClick={() => markReadMutation.mutate(n.id)}>
                    Mark read
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">{unreadOnly ? "No unread notifications." : "No notifications yet."}</p>
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
