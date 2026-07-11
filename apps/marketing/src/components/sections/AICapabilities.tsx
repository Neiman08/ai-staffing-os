import { AI_CAPABILITIES } from "@/lib/content";

export function AICapabilities() {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      {AI_CAPABILITIES.map((cap) => {
        const Icon = cap.icon;
        return (
          <div key={cap.title} className="flex gap-4 rounded-xl border border-border bg-card p-6">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <h3 className="font-semibold">{cap.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{cap.description}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
