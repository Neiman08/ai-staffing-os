// F14: la URL del software real (botón Login y cualquier otro enlace de
// acceso) viene de VITE_APP_URL -- variable pública de build-time, mismo
// patrón que VITE_API_URL en lib/api.ts. Nunca hardcodeada. Reemplaza al
// mecanismo anterior (F4.9, derivar la URL de branding.appDomain en
// runtime vía GET /public/branding) porque ese dependía de APP_DOMAIN
// del backend, que por default apunta al dominio propio
// (app.dreistaff.com) -- un dominio que todavía no está conectado a
// ningún deploy real. Con VITE_APP_URL configurable directamente en el
// dashboard de Render, el botón puede apuntar al deploy real que exista
// hoy (ej. https://ai-staffing-os-web.onrender.com) y cambiar más
// adelante a app.dreistaff.com sin tocar código ni depender de que el
// backend/branding esté sincronizado.
export const APP_URL = import.meta.env.VITE_APP_URL as string | undefined;
