import { getAuthToken } from "./auth-token";

// F4.9-D5: por default, ruta relativa — funciona en dev local vía el
// proxy de Vite (ver vite.config.ts) y en cualquier despliegue donde
// un mismo origen sirva front y back detrás de un reverse proxy.
// VITE_API_URL permite apuntar a un origen absoluto distinto (ej.
// Render, con apps/web y apps/api como servicios separados) sin tocar
// código — solo configurar la variable en el build del frontend.
const API_BASE = `${import.meta.env.VITE_API_URL ?? ""}/api/v1`;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  code: string;
  details?: unknown;

  constructor(body: ApiErrorBody["error"]) {
    super(body.message);
    this.code = body.code;
    this.details = body.details;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // F4.9: Bearer token de Clerk, nunca desde localStorage — se pide
  // fresco a cada request vía el bridge de auth-token.ts. En dev-bypass
  // (Clerk no configurado) esto resuelve a null y el header simplemente
  // no se agrega.
  const token = await getAuthToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    if (body?.error) throw new ApiError(body.error);
    throw new Error(`Request failed with status ${res.status}`);
  }

  return res.json() as Promise<T>;
}
