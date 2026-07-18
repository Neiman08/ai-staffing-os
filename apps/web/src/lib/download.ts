import { getAuthToken } from "./auth-token";
import { ApiError, type ApiErrorBody } from "./api";

const API_BASE = `${import.meta.env.VITE_API_URL ?? ""}/api/v1`;

/**
 * F11.8/F11.9: mismo criterio de auth que apiFetch (lib/api.ts) -- pide
 * el token de Clerk fresco si existe, no agrega header en dev-bypass --
 * pero en vez de `res.json()` arma un Blob y dispara la descarga real
 * del navegador (createObjectURL + <a download> + click programático,
 * el único mecanismo que funciona igual con o sin Authorization header,
 * a diferencia de un <a href> plano que no podría llevar el Bearer token
 * en producción).
 */
export async function downloadFile(path: string, fallbackFilename: string): Promise<void> {
  const token = await getAuthToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    if (body?.error) throw new ApiError(body.error);
    throw new Error(`Request failed with status ${res.status}`);
  }

  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? fallbackFilename;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
