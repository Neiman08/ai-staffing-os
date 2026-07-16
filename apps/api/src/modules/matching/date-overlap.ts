// F6.2: solapamiento de rangos de fechas — función pura, sin
// dependencias (no importa Prisma ni nada del resto del proyecto), para
// que sea trivialmente testeable y reutilizable.
//
// Semántica de `endDate = null`: un rango "abierto" que se extiende
// indefinidamente hacia adelante (igual que un Job Order sin endDate o
// una Assignment sin endDate en el schema real) — nunca se trata como
// "sin fecha" o "ya terminado". Con esa única regla (null = sin límite
// superior), la fórmula estándar de solapamiento de intervalos cerrados
// ya cubre los 4 casos pedidos (ambos con fin, uno sin fin, el otro sin
// fin, ambos sin fin) sin necesidad de ramas especiales:
//
//   aStart <= (bEnd ?? +infinito)  Y  (aEnd ?? +infinito) >= bStart
//
// Ejemplo Job Order sin endDate (bEnd=null): la condición de la
// izquierda es siempre verdadera, así que solapa si y solo si
// (aEnd ?? +infinito) >= bStart — exactamente "la Assignment no tiene
// endDate, o termina en/tras el startDate del Job Order".
//
// Ejemplo Assignment sin endDate (aEnd=null): la condición de la
// derecha es siempre verdadera, así que solapa si y solo si
// aStart <= (bEnd ?? +infinito) — exactamente "bloquea salvo que el Job
// Order termine antes de que empiece la Assignment".
export function doDateRangesOverlap(aStart: Date, aEnd: Date | null, bStart: Date, bEnd: Date | null): boolean {
  const aStartsBeforeOrOnBEnd = bEnd === null || aStart.getTime() <= bEnd.getTime();
  const aEndsAfterOrOnBStart = aEnd === null || aEnd.getTime() >= bStart.getTime();
  return aStartsBeforeOrOnBEnd && aEndsAfterOrOnBStart;
}
