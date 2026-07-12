// F4.9: el botón Login construye la URL del portal privado a partir de
// branding.appDomain (nunca hardcodeado — viene de GET /public/branding,
// que a su vez lee APP_DOMAIN). En producción appDomain es
// "app.dreistaff.com" → https. En local, si se configura
// APP_DOMAIN=localhost:5173 para probar el flujo completo, "https://localhost:5173"
// no existe — localhost siempre sirve por http.
export function resolveAppUrl(appDomain: string | undefined): string | undefined {
  if (!appDomain) return undefined;
  const protocol = appDomain.startsWith("localhost") ? "http" : "https";
  return `${protocol}://${appDomain}`;
}
