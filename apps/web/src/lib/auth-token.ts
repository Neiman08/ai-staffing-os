// F4.9: bridge entre el mundo de hooks de React (useAuth().getToken(),
// solo invocable dentro de un componente) y apiFetch (una función plana
// que no puede llamar hooks). AuthTokenBridge.tsx registra el getter
// real una vez que Clerk está listo; nunca se guarda el token en sí acá
// — solo la función que lo obtiene bajo demanda en cada request, siempre
// fresco. En dev-bypass (Clerk no configurado) queda null y apiFetch
// simplemente no agrega el header — el backend no lo exige en ese modo.
let tokenGetter: (() => Promise<string | null>) | null = null;

export function setAuthTokenGetter(fn: (() => Promise<string | null>) | null): void {
  tokenGetter = fn;
}

export async function getAuthToken(): Promise<string | null> {
  if (!tokenGetter) return null;
  return tokenGetter();
}
