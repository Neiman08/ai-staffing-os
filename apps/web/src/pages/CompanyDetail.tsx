import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityItem, CompanyDetail, ContactInput } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Timeline } from "@/components/shared/Timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatStatusLabel, statusVariant } from "@/lib/status";

const TABS = ["overview", "contacts", "opportunities", "followups", "activity"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  contacts: "Contacts",
  opportunities: "Opportunities",
  followups: "Follow-ups",
  activity: "Activity",
};

const DECISION_ROLES = ["OWNER", "HR", "OPERATIONS_MANAGER", "PROJECT_MANAGER", "PLANT_MANAGER", "RECRUITER", "OTHER"];

function AddContactForm({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ContactInput>({ firstName: "", lastName: "" });

  const mutation = useMutation({
    mutationFn: (input: ContactInput) =>
      apiFetch(`/companies/${companyId}/contacts`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Contact added", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["company", companyId] });
      onDone();
    },
    onError: (err) => toast({ title: "Could not add contact", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="grid grid-cols-2 gap-3 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(form);
      }}
    >
      <div>
        <Label>First name</Label>
        <Input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
      </div>
      <div>
        <Label>Last name</Label>
        <Input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
      </div>
      <div>
        <Label>Title</Label>
        <Input value={form.title ?? ""} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div>
        <Label>Decision role</Label>
        <Select
          value={form.decisionRole ?? ""}
          onChange={(e) => setForm({ ...form, decisionRole: (e.target.value || undefined) as never })}
        >
          <option value="">—</option>
          {DECISION_ROLES.map((r) => (
            <option key={r} value={r}>
              {formatStatusLabel(r)}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Email</Label>
        <Input type="email" value={form.email ?? ""} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </div>
      <div>
        <Label>Phone</Label>
        <Input value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </div>
      <div className="col-span-2">
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          {mutation.isPending ? "Adding…" : "Add contact"}
        </Button>
      </div>
    </form>
  );
}

function LogActivityForm({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState("");
  const [type, setType] = useState("NOTE");

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<ActivityItem>("/activities", {
        method: "POST",
        body: JSON.stringify({ entityType: "company", entityId: companyId, type, subject }),
      }),
    onSuccess: () => {
      toast({ title: "Activity logged", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["company", companyId] });
      setSubject("");
      onDone();
    },
    onError: (err) => toast({ title: "Could not log activity", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (subject.trim()) mutation.mutate();
      }}
    >
      <Select className="w-32 shrink-0" value={type} onChange={(e) => setType(e.target.value)}>
        {["NOTE", "CALL", "EMAIL", "MEETING"].map((t) => (
          <option key={t} value={t}>
            {formatStatusLabel(t)}
          </option>
        ))}
      </Select>
      <Input placeholder="What happened?" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <Button type="submit" size="sm" disabled={mutation.isPending}>
        Log
      </Button>
    </form>
  );
}

export default function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>("overview");

  const { data: company, isLoading } = useQuery({
    queryKey: ["company", id],
    queryFn: () => apiFetch<CompanyDetail>(`/companies/${id}`),
    enabled: !!id,
  });

  if (isLoading || !company) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div>
      <PageHeader
        title={company.name}
        description={`${company.industryName}${company.city && company.state ? ` · ${company.city}, ${company.state}` : ""}`}
        action={<Badge variant={statusVariant(company.status)}>{formatStatusLabel(company.status)}</Badge>}
      />

      <div className="mb-4 flex gap-1 rounded-md border border-border bg-secondary/40 p-1 w-fit">
        {TABS.map((t) => (
          <Button
            key={t}
            variant={tab === t ? "default" : "ghost"}
            size="sm"
            onClick={() => setTab(t)}
            className={cn(tab !== t && "text-muted-foreground")}
          >
            {TAB_LABELS[t]}
          </Button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Website</span>
                <span>{company.website ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Phone</span>
                <span>{company.phone ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Estimated size</span>
                <span>{company.estimatedSize ? formatStatusLabel(company.estimatedSize) : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Commercial score</span>
                <span>{company.commercialScore ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Possible needs</span>
                <span>{company.possibleCategoryNames.join(", ") || "—"}</span>
              </div>
              <div className="pt-2">
                <span className="text-muted-foreground">Notes</span>
                <p className="mt-1">{company.notes ?? "—"}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Upcoming follow-ups</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {company.upcomingFollowUps.length ? (
                company.upcomingFollowUps.map((f) => (
                  <div key={f.id} className="flex justify-between border-b border-border pb-2 last:border-0">
                    <span>{formatStatusLabel(f.type)}</span>
                    <span className="text-muted-foreground">{new Date(f.dueDate).toLocaleDateString()}</span>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">No pending follow-ups.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "contacts" && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <AddContactForm companyId={company.id} onDone={() => {}} />
            <div className="space-y-2">
              {company.contacts.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                  <div>
                    <div className="font-medium">
                      {c.firstName} {c.lastName} {c.isPrimary && <Badge variant="primary">Primary</Badge>}
                    </div>
                    <div className="text-muted-foreground">
                      {c.title ?? "—"} {c.decisionRole ? `· ${formatStatusLabel(c.decisionRole)}` : ""}
                    </div>
                  </div>
                  <div className="text-right text-muted-foreground">
                    <div>{c.email ?? "—"}</div>
                    <div>{c.phone ?? "—"}</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "opportunities" && (
        <Card>
          <CardContent className="space-y-2 p-4">
            {company.opportunities.length ? (
              company.opportunities.map((o) => (
                <div key={o.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                  <span className="font-medium">{o.title}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">{o.estimatedRevenue ? `$${o.estimatedRevenue}` : "—"}</span>
                    <Badge variant={statusVariant(o.stage)}>{formatStatusLabel(o.stage)}</Badge>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No opportunities yet.</p>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "followups" && (
        <Card>
          <CardContent className="space-y-2 p-4">
            {company.upcomingFollowUps.length ? (
              company.upcomingFollowUps.map((f) => (
                <div key={f.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                  <span>{formatStatusLabel(f.type)}</span>
                  <span className="text-muted-foreground">{f.notes}</span>
                  <span className="text-muted-foreground">{new Date(f.dueDate).toLocaleDateString()}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No pending follow-ups.</p>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "activity" && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <LogActivityForm companyId={company.id} onDone={() => {}} />
            <Timeline items={company.recentActivity} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
