/** @type {import('tailwindcss').Config} */
// F4.8: mismo primary (HSL 255 92% 62%) que apps/web — la marca es UNA
// sola entre el sitio público y el portal privado, nunca dos paletas
// distintas. El resto del sistema (ink/slate profundo, acentos) es
// nuevo, pensado para un sitio de marketing premium — no reutiliza el
// look utilitario del dashboard interno.
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        border: "hsl(var(--border))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        ink: {
          DEFAULT: "hsl(var(--ink))",
          foreground: "hsl(var(--ink-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 4px)",
        sm: "calc(var(--radius) - 8px)",
      },
      backgroundImage: {
        "grid-fade": "radial-gradient(hsl(var(--foreground) / 0.08) 1px, transparent 1px)",
      },
    },
  },
  plugins: [],
};
