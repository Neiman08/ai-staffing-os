// F10.8: campana funcional real -- reemplaza el widget decorativo de
// F0/F1 (`/dashboard/notifications`, sin mark-as-read ni navegación).
// Compartida entre el shell interno (Topbar) y los 3 shells de portal
// (PortalTopbar) -- los mismos endpoints `/notifications*` sirven a los
// 15 roles (F10.1), el scoping real ocurre en el backend.
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { formatStatusLabel } from "@/lib/status";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  priority: string;
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

const PORTAL_PREFIXES = ["/portal/client", "/portal/worker", "/portal/candidate"];

export function NotificationBell() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // F10.8: "Ver todas" navega al Notifications Center del shell ACTUAL
  // -- deriva el prefijo de la URL en vez de recibir un prop fijo por
  // Topbar, así funciona igual dentro de los 3 portales sin triplicar
  // el componente.
  const portalPrefix = PORTAL_PREFIXES.find((p) => location.pathname.startsWith(p));
  const notificationsHref = portalPrefix ? `${portalPrefix}/notifications` : "/notifications";

  const { data: unread } = useQuery({
    queryKey: ["notifications-unread-count"],
    queryFn: () => apiFetch<{ count: number }>("/notifications/unread-count"),
    refetchInterval: 30_000,
  });

  const { data: recent } = useQuery({
    queryKey: ["notifications-recent"],
    queryFn: () => apiFetch<{ items: NotificationItem[]; nextCursor: string | null }>("/notifications?limit=8"),
    enabled: open,
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/notifications/${id}/read`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications-unread-count"] });
      queryClient.invalidateQueries({ queryKey: ["notifications-recent"] });
    },
  });

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function handleItemClick(item: NotificationItem) {
    if (!item.readAt) markReadMutation.mutate(item.id);
    setOpen(false);
    if (item.actionUrl) navigate(item.actionUrl);
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label="Notificaciones"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Bell className="h-4 w-4" />
        {!!unread?.count && (
          <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
            {unread.count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-50 w-80 rounded-md border border-border bg-card shadow-lg" role="menu">
          <div className="border-b border-border px-3 py-2 text-sm font-semibold">Notifications</div>
          <div className="max-h-96 overflow-y-auto">
            {recent?.items.length ? (
              recent.items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => handleItemClick(n)}
                  className="flex w-full flex-col items-start gap-0.5 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
                >
                  <div className="flex w-full items-center gap-2">
                    {!n.readAt && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
                    <span className={n.readAt ? "font-normal text-muted-foreground" : "font-medium"}>{n.title}</span>
                  </div>
                  {n.body && <span className="text-xs text-muted-foreground">{n.body}</span>}
                  <span className="text-[10px] uppercase text-muted-foreground">{formatStatusLabel(n.type)}</span>
                </button>
              ))
            ) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No notifications yet.</p>
            )}
          </div>
          <button
            type="button"
            className="block w-full border-t border-border px-3 py-2 text-center text-xs font-medium text-primary hover:bg-accent"
            onClick={() => {
              setOpen(false);
              navigate(notificationsHref);
            }}
          >
            View all
          </button>
        </div>
      )}
    </div>
  );
}
