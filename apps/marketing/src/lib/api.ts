// F4.8: el sitio público SOLO habla con /api/v1/public/* — nunca con
// las rutas internas del CRM (esas exigen tenancyMiddleware/RBAC, ni
// siquiera responderían sin sesión). Desacoplado a propósito, ver
// docs/F4_8_PUBLIC_WEBSITE_PLAN.md.
const PUBLIC_API_BASE = "/api/v1/public";

export class PublicApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function publicApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PUBLIC_API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new PublicApiError(res.status, body?.error?.message ?? `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}
