// F4.8: el sitio público SOLO habla con /api/v1/public/* — nunca con
// las rutas internas del CRM (esas exigen tenancyMiddleware/RBAC, ni
// siquiera responderían sin sesión). Desacoplado a propósito, ver
// docs/F4_8_PUBLIC_WEBSITE_PLAN.md.
//
// Render prep (2026-07-19): en dev local esto funciona por el proxy de
// Vite (vite.config.ts reenvía /api -> localhost:4000). En Render,
// apps/marketing se despliega como sitio ESTÁTICO (sin proceso Node que
// pueda proxyear) — sin esto, un fetch relativo a "/api/v1/public/..."
// pegaría contra el propio dominio estático del marketing (404), nunca
// contra ai-staffing-os-api real. Mismo patrón ya usado por apps/web
// (VITE_API_URL) — vacío en dev (usa el proxy relativo), URL absoluta
// real del API en producción.
const PUBLIC_API_BASE = `${import.meta.env.VITE_API_URL ?? ""}/api/v1/public`;

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
