import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ContactListItem, IndustryListItem, Paginated } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatStatusLabel } from "@/lib/status";

const DECISION_ROLES = [
  "HR",
  "TALENT_ACQUISITION",
  "RECRUITER",
  "OPERATIONS_MANAGER",
  "PLANT_MANAGER",
  "WAREHOUSE_MANAGER",
  "GENERAL_MANAGER",
  "PURCHASING_MANAGER",
  "DIRECTOR_OF_OPERATIONS",
  "OWNER",
  "PROJECT_MANAGER",
  "OTHER",
];
const VERIFICATION_STATUSES = ["UNVERIFIED", "CONFIRMED", "INFERRED"];
// F4.7: entregabilidad del email — distinto de VERIFICATION_STATUSES
// (que es la procedencia del contacto como registro completo).
const EMAIL_VERIFICATION_STATUSES = ["NOT_VERIFIED", "VERIFIED", "RISKY", "INVALID", "UNKNOWN"];
const CONFIDENCE_FLOORS = [
  { label: "Cualquiera", value: "" },
  { label: "≥ 50%", value: "0.5" },
  { label: "≥ 70%", value: "0.7" },
  { label: "≥ 90%", value: "0.9" },
];

function emailVerificationBadgeVariant(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "VERIFIED") return "success";
  if (status === "RISKY" || status === "UNKNOWN") return "warning";
  if (status === "INVALID") return "danger";
  return "neutral";
}

interface ContactFilters {
  industryName: string;
  companyState: string;
  decisionRole: string;
  verificationStatus: string;
  emailVerificationStatus: string;
  minConfidence: string;
  companyName: string;
}

const EMPTY_FILTERS: ContactFilters = {
  industryName: "",
  companyState: "",
  decisionRole: "",
  verificationStatus: "",
  emailVerificationStatus: "",
  minConfidence: "",
  companyName: "",
};

export default function Contacts() {
  const navigate = useNavigate();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [filters, setFilters] = useState<ContactFilters>(EMPTY_FILTERS);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data: industries } = useQuery({
    queryKey: ["industries"],
    queryFn: () => apiFetch<IndustryListItem[]>("/industries"),
  });

  const queryParams = new URLSearchParams();
  queryParams.set("limit", "20");
  if (cursor) queryParams.set("cursor", cursor);
  if (filters.industryName) queryParams.set("industryName", filters.industryName);
  if (filters.companyState) queryParams.set("companyState", filters.companyState);
  if (filters.decisionRole) queryParams.set("decisionRole", filters.decisionRole);
  if (filters.verificationStatus) queryParams.set("verificationStatus", filters.verificationStatus);
  if (filters.emailVerificationStatus) queryParams.set("emailVerificationStatus", filters.emailVerificationStatus);
  if (filters.minConfidence) queryParams.set("minConfidence", filters.minConfidence);
  if (filters.companyName) queryParams.set("companyName", filters.companyName);

  const { data, isLoading } = useQuery({
    queryKey: ["contacts", cursor, filters],
    queryFn: () => apiFetch<Paginated<ContactListItem>>(`/contacts?${queryParams.toString()}`),
  });

  function updateFilter<K extends keyof ContactFilters>(key: K, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
    setCursorStack([undefined]); // cambiar un filtro reinicia la paginación
  }

  return (
    <div>
      <PageHeader title="Contacts" description="Contactos de todas las empresas, reales o encontrados por el Contact Intelligence Agent" />

      <Card className="mb-4">
        <CardContent className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-7">
          <div>
            <Label>Industria</Label>
            <Select value={filters.industryName} onChange={(e) => updateFilter("industryName", e.target.value)}>
              <option value="">Todas</option>
              {industries?.map((i) => (
                <option key={i.id} value={i.name}>
                  {i.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Estado</Label>
            <Input
              placeholder="ej. IL"
              value={filters.companyState}
              onChange={(e) => updateFilter("companyState", e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <Label>Cargo</Label>
            <Select value={filters.decisionRole} onChange={(e) => updateFilter("decisionRole", e.target.value)}>
              <option value="">Todos</option>
              {DECISION_ROLES.map((r) => (
                <option key={r} value={r}>
                  {formatStatusLabel(r)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Confidence</Label>
            <Select value={filters.minConfidence} onChange={(e) => updateFilter("minConfidence", e.target.value)}>
              {CONFIDENCE_FLOORS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Verificado</Label>
            <Select value={filters.verificationStatus} onChange={(e) => updateFilter("verificationStatus", e.target.value)}>
              <option value="">Todos</option>
              {VERIFICATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {formatStatusLabel(s)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Email verificado</Label>
            <Select
              value={filters.emailVerificationStatus}
              onChange={(e) => updateFilter("emailVerificationStatus", e.target.value)}
            >
              <option value="">Todos</option>
              {EMAIL_VERIFICATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {formatStatusLabel(s)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Empresa</Label>
            <Input
              placeholder="Buscar empresa…"
              value={filters.companyName}
              onChange={(e) => updateFilter("companyName", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Cargo</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Email verificado</TableHead>
                <TableHead>Teléfono</TableHead>
                <TableHead>LinkedIn</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Fuente</TableHead>
                <TableHead>Fecha</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((contact) => (
                <TableRow
                  key={contact.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/companies/${contact.companyId}`)}
                >
                  <TableCell className="font-medium">
                    {contact.firstName} {contact.lastName}
                    {contact.isPrimary && (
                      <Badge variant="primary" className="ml-2">
                        Primary
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {contact.title ?? "No disponible"}
                    {contact.decisionRole && (
                      <span className="ml-1 text-xs">({formatStatusLabel(contact.decisionRole)})</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {contact.companyName} <span className="text-xs">· {contact.industryName}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {contact.email ?? "No disponible"}
                    {contact.emailSource && <div className="text-xs">{contact.emailSource}</div>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={emailVerificationBadgeVariant(contact.emailVerificationStatus)}>
                      {formatStatusLabel(contact.emailVerificationStatus)}
                    </Badge>
                    {contact.doNotContact && (
                      <Badge variant="danger" className="ml-1">
                        No contactar
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{contact.phone ?? "No disponible"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {contact.linkedinUrl ? (
                      <a
                        href={contact.linkedinUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-primary underline"
                      >
                        Perfil
                      </a>
                    ) : (
                      "No disponible"
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {contact.confidenceScore != null ? `${Math.round(contact.confidenceScore * 100)}%` : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={contact.verificationStatus === "CONFIRMED" ? "success" : "neutral"}>
                      {formatStatusLabel(contact.verificationStatus)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{contact.source ?? "Manual"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {contact.discoveredAt ? new Date(contact.discoveredAt).toLocaleDateString() : "—"}
                  </TableCell>
                </TableRow>
              ))}
              {data?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-sm text-muted-foreground">
                    Sin contactos que coincidan con estos filtros.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
