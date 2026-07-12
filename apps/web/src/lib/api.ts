import { getAuthToken } from "./auth-token";

const API_BASE = "/api/v1";

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
