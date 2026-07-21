import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSender, resolveReplyTo, RESERVED_RECRUITING_SENDER, type EmailSenderProfile } from "./sender-profiles";

/**
 * F17 (pedido explícito): "prueba de que los correos comerciales usan
 * sales@dreistaff.com" y "prueba de que nunca se hace fallback
 * silencioso a hello@dreistaff.com". Este archivo es la ÚNICA fuente de
 * verdad de remitentes reales -- estas pruebas son la garantía
 * permanente de que ningún cambio futuro puede desviar el correo
 * comercial a otra dirección.
 */

test("resolveSender('commercial') SIEMPRE devuelve sales@<BUSINESS_DOMAIN> con el nombre visible correcto -- fijo, nunca leído de env", () => {
  const sender = resolveSender("commercial");
  assert.deepEqual(sender, { email: "sales@dreistaff.com", name: "DreiStaff Sales" });
});

test("resolveSender('commercial') es determinista -- llamado 5 veces seguidas devuelve exactamente lo mismo, nunca varía", () => {
  const results = Array.from({ length: 5 }, () => resolveSender("commercial"));
  for (const r of results) assert.deepEqual(r, { email: "sales@dreistaff.com", name: "DreiStaff Sales" });
});

test("resolveSender('commercial') NUNCA devuelve hello@ ni ninguna otra dirección -- nunca un fallback silencioso", () => {
  const sender = resolveSender("commercial");
  assert.notEqual(sender?.email, "hello@dreistaff.com");
  assert.notEqual(sender?.email, process.env.MAIL_FROM);
  assert.equal(sender?.email, "sales@dreistaff.com");
});

test("resolveReplyTo('commercial') SIEMPRE es sales@<BUSINESS_DOMAIN>, igual al remitente -- pedido explícito", () => {
  assert.equal(resolveReplyTo("commercial"), "sales@dreistaff.com");
});

test("RESERVED_RECRUITING_SENDER está documentado con el dominio real pero NUNCA es un EmailSenderProfile invocable -- ver comentario del archivo", () => {
  assert.equal(RESERVED_RECRUITING_SENDER.email, "recruiting@dreistaff.com");
  assert.equal(RESERVED_RECRUITING_SENDER.name, "DreiStaff Recruiting");

  // Garantía en tiempo de compilación: "recruiting" NUNCA debe ser
  // asignable a EmailSenderProfile todavía -- si esta línea llega a
  // compilar, alguien lo activó sin querer y hay que actualizar este test.
  // @ts-expect-error -- "recruiting" no es un EmailSenderProfile activo a propósito (el PO pidió no activarlo todavía).
  const _typeCheck: EmailSenderProfile = "recruiting";
  void _typeCheck;

  // Garantía en tiempo de ejecución -- si alguien bypassea el chequeo de
  // tipos (cast forzado, JS sin tipos, etc.), resolveSender debe seguir
  // rechazándolo explícitamente, nunca devolver un remitente por accidente.
  assert.throws(() => resolveSender("recruiting" as unknown as EmailSenderProfile));
});

test("resolveSender('general') sin MAIL_FROM configurado devuelve null -- nunca cae a otro remitente por defecto", () => {
  // Este proceso de test corre sin MAIL_FROM en el entorno (confirmado:
  // no está en .env) -- si algún día se configura acá por error, este
  // test lo detectaría con un mensaje claro en vez de un false positive silencioso.
  if (process.env.MAIL_FROM) {
    assert.fail("Este test asume MAIL_FROM sin configurar en el entorno de test -- ajustar el test si eso cambió.");
  }
  assert.equal(resolveSender("general"), null);
});
