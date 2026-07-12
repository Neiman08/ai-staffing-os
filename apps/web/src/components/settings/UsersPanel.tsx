import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoleListItem, UserListItem } from "@ai-staffing-os/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";

function invitationBadge(status: UserListItem["invitationStatus"]) {
  switch (status) {
    case "PENDING":
      return <Badge variant="warning">Invitation pending</Badge>;
    case "REVOKED":
      return <Badge variant="danger">Invitation revoked</Badge>;
    case "EXPIRED":
      return <Badge variant="danger">Invitation expired</Badge>;
    case "ACCEPTED":
      return <Badge variant="success">Accepted</Badge>;
    default:
      return null; // NOT_INVITED — usuario preexistente, no es parte del flujo de invitación
  }
}

function InviteUserForm({ roles, onDone }: { roles: RoleListItem[]; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const invite = useMutation({
    mutationFn: () => apiFetch("/auth/users/invite", { method: "POST", body: JSON.stringify({ email, roleId }) }),
    onSuccess: () => {
      toast({ title: "Invitation sent", description: `${email} was invited.`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["settings", "users"] });
      onDone();
    },
    onError: (err) => {
      toast({ title: "Could not send invitation", description: err instanceof ApiError ? err.message : undefined, variant: "error" });
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        invite.mutate();
      }}
    >
      <div>
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="invite-role">Role</Label>
        <Select id="invite-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" disabled={invite.isPending || !roleId} className="w-full">
        {invite.isPending ? "Sending…" : "Send invitation"}
      </Button>
    </form>
  );
}

export function UsersPanel({ className }: { className?: string }) {
  const { data: currentUser } = useCurrentUser();
  const canManage = currentUser?.permissions.includes("users.manage") ?? false;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);

  const users = useQuery({
    queryKey: ["settings", "users"],
    queryFn: () => apiFetch<UserListItem[]>("/auth/users"),
  });
  const roles = useQuery({
    queryKey: ["settings", "roles"],
    queryFn: () => apiFetch<RoleListItem[]>("/auth/roles"),
  });

  const toggleStatus = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiFetch(`/auth/users/${id}/status`, { method: "PATCH", body: JSON.stringify({ isActive }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "users"] });
      toast({ title: "User updated", variant: "success" });
    },
    onError: (err) => toast({ title: "Update failed", description: err instanceof ApiError ? err.message : undefined, variant: "error" }),
  });

  const changeRole = useMutation({
    mutationFn: ({ id, roleId }: { id: string; roleId: string }) =>
      apiFetch(`/auth/users/${id}/role`, { method: "PATCH", body: JSON.stringify({ roleId }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "users"] });
      toast({ title: "Role updated", variant: "success" });
    },
    onError: (err) => toast({ title: "Update failed", description: err instanceof ApiError ? err.message : undefined, variant: "error" }),
  });

  const revokeSessions = useMutation({
    mutationFn: (id: string) => apiFetch(`/auth/users/${id}/revoke-sessions`, { method: "POST" }),
    onSuccess: () => toast({ title: "Sessions revoked", variant: "success" }),
    onError: (err) => toast({ title: "Could not revoke sessions", description: err instanceof ApiError ? err.message : undefined, variant: "error" }),
  });

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Usuarios</CardTitle>
        {canManage && (
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            Invite user
          </Button>
        )}
      </CardHeader>
      {users.error ? (
        <p className="p-4 text-sm text-muted-foreground">
          {users.error instanceof ApiError ? users.error.message : "No se pudo cargar esta sección."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Rol</TableHead>
              <TableHead>Estado</TableHead>
              {canManage && <TableHead className="text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.data?.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">
                  {u.firstName} {u.lastName}
                </TableCell>
                <TableCell className="text-muted-foreground">{u.email}</TableCell>
                <TableCell>
                  {canManage && roles.data ? (
                    <Select
                      className="h-8 w-40 text-xs"
                      value={u.role.id}
                      onChange={(e) => changeRole.mutate({ id: u.id, roleId: e.target.value })}
                      disabled={changeRole.isPending}
                    >
                      {roles.data.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Badge variant="neutral">{u.role.name}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={u.isActive ? "success" : "danger"}>{u.isActive ? "Active" : "Disabled"}</Badge>
                    {invitationBadge(u.invitationStatus)}
                  </div>
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={toggleStatus.isPending}
                        onClick={() => toggleStatus.mutate({ id: u.id, isActive: !u.isActive })}
                      >
                        {u.isActive ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={revokeSessions.isPending}
                        onClick={() => revokeSessions.mutate(u.id)}
                      >
                        Revoke sessions
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Drawer open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite user">
        {roles.data && roles.data.length > 0 ? (
          <InviteUserForm roles={roles.data} onDone={() => setInviteOpen(false)} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading roles…</p>
        )}
      </Drawer>
    </Card>
  );
}
