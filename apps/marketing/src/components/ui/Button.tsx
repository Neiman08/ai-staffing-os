import { forwardRef } from "react";
import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

const VARIANT_CLASSES: Record<string, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-hover glow-primary",
  outline: "border border-border bg-transparent hover:bg-muted",
  ghost: "bg-transparent hover:bg-muted",
  inverse: "bg-white text-ink hover:bg-white/90",
};

const SIZE_CLASSES: Record<string, string> = {
  md: "h-11 px-5 text-sm",
  lg: "h-13 px-7 text-base",
};

const base = "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-all duration-200 disabled:pointer-events-none disabled:opacity-50";

interface CommonProps {
  variant?: keyof typeof VARIANT_CLASSES;
  size?: keyof typeof SIZE_CLASSES;
  children: ReactNode;
  className?: string;
}

export const Button = forwardRef<HTMLButtonElement, CommonProps & ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ variant = "primary", size = "md", className, children, ...props }, ref) => (
    <button ref={ref} className={cn(base, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)} {...props}>
      {children}
    </button>
  ),
);
Button.displayName = "Button";

export function ButtonLink({
  to,
  variant = "primary",
  size = "md",
  className,
  children,
  external,
  ...props
}: CommonProps & AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; external?: boolean }) {
  const classes = cn(base, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className);
  if (external) {
    return (
      <a href={to} className={classes} {...props}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to} className={classes} {...props}>
      {children}
    </Link>
  );
}
