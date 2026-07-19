import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { ClerkProvider } from "@clerk/clerk-react";
import { ThemeProvider } from "@/lib/theme";
import { ToastProvider } from "@/components/ui/toast";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { CLERK_CONFIGURED, CLERK_PUBLISHABLE_KEY } from "@/lib/auth-config";
import { router } from "./router";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const app = (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

// F4.9: sin VITE_CLERK_PUBLISHABLE_KEY (dev-bypass local, sin
// credenciales de Clerk todavía) el árbol se renderiza sin
// <ClerkProvider> — RequireAuth.tsx ya elige la variante que no
// depende de sus hooks en ese caso. Nunca se monta ClerkProvider con
// una key vacía (lanzaría en runtime).
//
// F12.10: ErrorBoundary como el nodo MÁS externo -- antes, un error de
// render en cualquier punto del árbol (incluido dentro de ClerkProvider)
// tumbaba toda la app a una pantalla en blanco sin ningún mensaje.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {CLERK_CONFIGURED ? <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY!}>{app}</ClerkProvider> : app}
    </ErrorBoundary>
  </React.StrictMode>,
);
