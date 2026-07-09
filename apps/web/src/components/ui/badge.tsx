import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "border-border bg-secondary text-secondary-foreground",
        success: "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        warning: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
        danger: "border-transparent bg-red-500/15 text-red-600 dark:text-red-400",
        info: "border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400",
        primary: "border-transparent bg-primary/15 text-primary",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
