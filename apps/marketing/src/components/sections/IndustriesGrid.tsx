import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { INDUSTRIES } from "@/lib/content";

export function IndustriesGrid({ showDetail = false }: { showDetail?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {INDUSTRIES.map((industry) => {
        const Icon = industry.icon;
        return (
          <Link
            key={industry.slug}
            to="/industries"
            className="card-hover group flex flex-col rounded-xl border border-border bg-card p-6 transition-all"
          >
            <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </span>
            <h3 className="text-lg font-semibold">{industry.name}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{showDetail ? industry.detail : industry.summary}</p>
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
              Learn more <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </Link>
        );
      })}
    </div>
  );
}
