import type { Router, RequestHandler } from "express";

/**
 * F12.11: hallazgo real durante la verificación de F12.11 -- las
 * pruebas de "wiring" de F12.4 (¿el rate limiter real está montado en
 * la ruta real?) disparaban un request HTTP real y comprobaban el
 * header RateLimit-Limit de la respuesta. Eso consumía el mismo store
 * en memoria que usa la ruta en producción, y como toda la suite corre
 * en un único proceso de Node, el cupo se acumulaba entre archivos de
 * test sin relación entre sí -- con suficientes archivos, tests
 * completamente ajenos a rate limiting empezaban a fallar según el
 * orden de ejecución.
 *
 * Esta función prueba lo mismo (el middleware real está de verdad
 * registrado en esa ruta) sin disparar ningún request: recorre el
 * stack real de Express en busca de la capa que matchea method+path y
 * confirma por identidad de referencia que el middleware exacto está
 * en su cadena. Determinístico, no consume ningún cupo compartido.
 */
export function routeHasMiddleware(
  router: Router,
  method: "get" | "post" | "patch" | "put" | "delete",
  path: string,
  middleware: RequestHandler,
): boolean {
  for (const layer of router.stack) {
    const route = layer.route;
    if (!route || route.path !== path) continue;
    // .methods existe en el objeto Route real de Express en runtime pero
    // no está en los tipos de @types/express-serve-static-core.
    const methods = (route as unknown as { methods: Record<string, boolean> }).methods;
    if (!methods[method]) continue;
    for (const routeLayer of route.stack) {
      if (routeLayer.handle === middleware) return true;
    }
  }
  return false;
}
