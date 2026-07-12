// F4.9: Vite solo expone al bundle las variables con prefijo VITE_ — es
// la misma clave pública que CLERK_PUBLISHABLE_KEY del backend (no es
// secreta, está diseñada para vivir en el navegador). Sin ella, el
// portal sigue funcionando en dev-bypass (ver RequireAuth.tsx) — nunca
// se rompe la app local por no tener Clerk configurado todavía.
export const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
export const CLERK_CONFIGURED = Boolean(CLERK_PUBLISHABLE_KEY);
