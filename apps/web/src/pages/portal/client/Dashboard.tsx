import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClientDashboardSummary } from "./types";

function MetricCard({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold">{value ?? "…"}</p>
      </CardContent>
    </Card>
  );
}

export default function ClientDashboard() {
  const { data } = useQuery({
    queryKey: ["portal-client-dashboard"],
    queryFn: () => apiFetch<ClientDashboardSummary>("/portal/client/dashboard"),
  });

  return (
    <div>
      <PageHeader title="Dashboard" description="Resumen en vivo de tu cuenta -- solo tus Job Orders, Workers e incidentes." />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Open Job Orders" value={data?.openJobOrders} />
        <MetricCard label="Active Assignments" value={data?.activeAssignments} />
        <MetricCard label="Pending Time Entries" value={data?.pendingTimeEntries} />
        <MetricCard label="Open Incidents" value={data?.openIncidents} />
      </div>
    </div>
  );
}
