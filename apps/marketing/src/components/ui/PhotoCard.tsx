import type { LucideIcon } from "lucide-react";
import { Photo } from "./Photo";

interface PhotoCardProps {
  photo: { src: string; alt: string };
  icon: LucideIcon;
  title: string;
  description: string;
}

export function PhotoCard({ photo, icon: Icon, title, description }: PhotoCardProps) {
  return (
    <div className="group overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-xl">
      <div className="relative">
        <Photo src={photo.src} alt={photo.alt} className="aspect-[4/3] transition-transform duration-500 group-hover:scale-105" />
        <span className="absolute -bottom-5 left-5 flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg ring-4 ring-card">
          <Icon className="h-5 w-5" />
        </span>
      </div>
      <div className="px-5 pb-6 pt-8">
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
