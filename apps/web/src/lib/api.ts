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
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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
