import { useQuery } from "@tanstack/react-query";
import type {
  DocumentTypeListItem,
  IndustryListItem,
  JobCategoryListItem,
  RoleListItem,
  UserListItem,
} from "@ai-staffing-os/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function SectionError({ error }: { error: unknown }) {
  const message = error instanceof ApiError ? error.message : "No se pudo cargar esta sección.";
  return <p className="p-4 text-sm text-muted-foreground">{message}</p>;
}

export default function Settings() {
  const users = useQuery({
    queryKey: ["settings", "users"],
    queryFn: () => apiFetch<UserListItem[]>("/auth/users"),
  });
  const roles = useQuery({
    queryKey: ["settings", "roles"],
    queryFn: () => apiFetch<RoleListItem[]>("/auth/roles"),
  });
  const industries = useQuery({
    queryKey: ["settings", "industries"],
    queryFn: () => apiFetch<IndustryListItem[]>("/industries"),
  });
  const categories = useQuery({
    queryKey: ["settings", "job-categories"],
    queryFn: () => apiFetch<JobCategoryListItem[]>("/job-categories"),
  });
  const documentTypes = useQuery({
    queryKey: ["settings", "document-types"],
    queryFn: () => apiFetch<DocumentTypeListItem[]>("/compliance/document-types"),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Usuarios, roles y catálogos configurables del tenant" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Usuarios</CardTitle>
          </CardHeader>
          {users.error ? (
            <SectionError error={users.error} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Rol</TableHead>
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
                      <Badge variant="neutral">{u.role.name}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Roles</CardTitle>
          </CardHeader>
          {roles.error ? (
            <SectionError error={roles.error} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rol</TableHead>
                  <TableHead>Permisos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.data?.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-muted-foreground">{r.permissionCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Industries</CardTitle>
          </CardHeader>
          {industries.error ? (
            <SectionError error={industries.error} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Alcance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {industries.data?.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-medium">{i.name}</TableCell>
                    <TableCell>
                      <Badge variant={i.isGlobal ? "info" : "neutral"}>{i.isGlobal ? "Global" : "Tenant"}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Job Categories</CardTitle>
          </CardHeader>
          {categories.error ? (
            <SectionError error={categories.error} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Industria</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.data?.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">{c.industryName ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Document Types</CardTitle>
          </CardHeader>
          {documentTypes.error ? (
            <SectionError error={documentTypes.error} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Categoría</TableHead>
                  <TableHead>Requiere vencimiento</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documentTypes.data?.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell className="text-muted-foreground">{d.category}</TableCell>
                    <TableCell className="text-muted-foreground">{d.requiresExpiration ? "Sí" : "No"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
