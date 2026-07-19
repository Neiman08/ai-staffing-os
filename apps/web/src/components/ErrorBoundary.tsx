import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * F12.10: red de seguridad real contra una pantalla en blanco -- un
 * error de render en cualquier parte del árbol (antes de esto) no
 * quedaba atrapado por nada, el usuario solo veía una página vacía sin
 * ninguna explicación. Los error boundaries de React solo pueden ser
 * class components (no existe un hook equivalente todavía) -- esta es
 * la única razón real de que este archivo no sea una función.
 *
 * Nunca oculta el error real del desarrollador (console.error sigue
 * mostrando el stack completo), pero el usuario final ve un mensaje
 * claro y una forma real de recuperarse (recargar), nunca un loader
 * infinito ni una pantalla muerta.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary] uncaught render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive" aria-hidden="true" />
          <h1 className="text-xl font-semibold">Algo salió mal</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Ocurrió un error inesperado. Podés intentar recargar la página.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Recargar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
