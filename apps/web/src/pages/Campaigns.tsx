import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CampaignListItem,
  CreateCampaignInput,
  IndustryListItem,
  JobCategoryListItem,
  Paginated,
} from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { CampaignCard } from "@/components/shared/CampaignCard";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatStatusLabel } from "@/lib/status";
import { Plus } from "lucide-react";

const COMPANY_SIZES = ["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"];

function CreateCampaignForm({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: industries } = useQuery({
    queryKey: ["industries"],
    queryFn: () => apiFetch<IndustryListItem[]>("/industries"),
  });
  const { data: categories } = useQuery({
    queryKey: ["job-categories"],
    queryFn: () => apiFetch<JobCategoryListItem[]>("/job-categories"),
  });

  const [form, setForm] = useState<CreateCampaignInput>({ name: "" });
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);

  const createMutation = useMutation({
    mutationFn: (input: CreateCampaignInput) =>
      apiFetch<{ campaignId: string; reused: boolean }>("/campaigns", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (result) => {
      toast({
        title: result.reused ? "Se reutilizó una campaña existente con criterios equivalentes" : "Campaña creada",
        variant: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      onCreated();
    },
    onError: (err) => toast({ title: "No se pudo crear la campaña", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate({ ...form, targetCategoryIds: selectedCategoryIds });
      }}
    >
      <div>
        <Label htmlFor="name">Nombre</Label>
        <Input
          id="name"
          required
          placeholder="Construction Illinois"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor="industryId">Industria</Label>
        <Select
          id="industryId"
          value={form.industryId ?? ""}
          onChange={(e) => setForm({ ...form, industryId: e.target.value || undefined })}
        >
          <option value="">Cualquier industria</option>
          {industries?.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="state">Estado</Label>
          <Input
            id="state"
            placeholder="IL"
            value={form.state ?? ""}
            onChange={(e) => setForm({ ...form, state: e.target.value || undefined })}
          />
        </div>
        <div>
          <Label htmlFor="city">Ciudad</Label>
          <Input
            id="city"
            value={form.city ?? ""}
            onChange={(e) => setForm({ ...form, city: e.target.value || undefined })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="minCompanySize">Tamaño mínimo</Label>
          <Select
            id="minCompanySize"
            value={form.minCompanySize ?? ""}
            onChange={(e) => setForm({ ...form, minCompanySize: (e.target.value || undefined) as never })}
          >
            <option value="">—</option>
            {COMPANY_SIZES.map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="minScore">Score mínimo</Label>
          <Input
            id="minScore"
            type="number"
            min={0}
            max={100}
            value={form.minScore ?? ""}
            onChange={(e) => setForm({ ...form, minScore: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="priority">Prioridad</Label>
        <Select
          id="priority"
          value={form.priority ?? "MEDIUM"}
          onChange={(e) => setForm({ ...form, priority: e.target.value as CreateCampaignInput["priority"] })}
        >
          {["LOW", "MEDIUM", "HIGH"].map((p) => (
            <option key={p} value={p}>
              {formatStatusLabel(p)}
            </option>
          ))}
        </Select>
      </div>
      {categories && categories.length > 0 && (
        <div>
          <Label>Categorías de trabajo objetivo</Label>
          <div className="mt-1 flex max-h-32 flex-wrap gap-2 overflow-y-auto rounded-md border border-border p-2">
            {categories.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={selectedCategoryIds.includes(c.id)}
                  onChange={(e) =>
                    setSelectedCategoryIds((prev) =>
                      e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                    )
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <Button type="submit" className="w-full" disabled={createMutation.isPending}>
        {createMutation.isPending ? "Creando…" : "Crear campaña"}
      </Button>
    </form>
  );
}

export default function Campaigns() {
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading } = useQuery({
    queryKey: ["campaigns", cursor],
    queryFn: () => apiFetch<Paginated<CampaignListItem>>(`/campaigns?limit=20${cursor ? `&cursor=${cursor}` : ""}`),
  });

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="Campañas comerciales del Campaign Agent — segmentación, secuencias y resultados"
        action={
          <Button onClick={() => setDrawerOpen(true)}>
            <Plus className="h-4 w-4" />
            Nueva campaña
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-52" />
          ))}
        </div>
      ) : data?.items.length ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((campaign) => (
            <CampaignCard key={campaign.id} campaign={campaign} />
          ))}
        </div>
      ) : (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Sin campañas todavía. Creá una manualmente o lanzá una Daily Revenue Mission desde el Dashboard.
        </Card>
      )}

      <Card className="mt-4">
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Nueva campaña">
        <CreateCampaignForm onCreated={() => setDrawerOpen(false)} />
      </Drawer>
    </div>
  );
}
