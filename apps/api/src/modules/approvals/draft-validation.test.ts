import { test } from "node:test";
import assert from "node:assert/strict";
import { findKnownPlaceholders } from "@ai-staffing-os/shared";

/**
 * F24 (auditoría de producción): findKnownPlaceholders solo cubría
 * placeholders en inglés -- producción ya tenía 9+ borradores con
 * placeholders reales en español que ese detector nunca bloqueaba.
 */

test("detecta placeholders en inglés (comportamiento preexistente)", () => {
  const matches = findKnownPlaceholders("Best regards,\n\n[Your Name]\n[Your Position]\n[Company Name]");
  assert.ok(matches.some((m) => /your name/i.test(m)));
  assert.ok(matches.some((m) => /your position/i.test(m)));
  assert.ok(matches.some((m) => /company name/i.test(m)));
});

test("detecta el caso real exacto de producción: [Tu Nombre] + [Tu Posición] + [Nombre de la Agencia de Staffing] + [Tu Información de Contacto]", () => {
  const body =
    "Saludos cordiales,\n\n[Tu Nombre]\n[Tu Posición]\n[Nombre de la Agencia de Staffing]\n[Tu Información de Contacto]";
  const matches = findKnownPlaceholders(body);
  assert.ok(matches.some((m) => /tu nombre/i.test(m)), "debería detectar [Tu Nombre]");
  assert.ok(matches.some((m) => /tu posici[oó]n/i.test(m)), "debería detectar [Tu Posición] (con acento)");
  assert.ok(matches.some((m) => /nombre de la agencia/i.test(m)), "debería detectar [Nombre de la Agencia de Staffing]");
  assert.ok(matches.some((m) => /tu informaci[oó]n de contacto/i.test(m)), "debería detectar [Tu Información de Contacto]");
});

test("detecta variantes razonables en español: [Tu Empresa], [Tu Agencia], [Tu Cargo], [Tu Teléfono], [Tu Email]", () => {
  for (const placeholder of ["[Tu Empresa]", "[Tu Agencia]", "[Tu Cargo]", "[Tu Teléfono]", "[Tu Email]"]) {
    const matches = findKnownPlaceholders(`Saludos,\n\n${placeholder}`);
    assert.ok(matches.length > 0, `debería detectar ${placeholder}`);
  }
});

test("detecta [Nombre de tu Agencia] e [Inserta tu nombre aquí]", () => {
  assert.ok(findKnownPlaceholders("[Nombre de tu Agencia]").length > 0);
  assert.ok(findKnownPlaceholders("[Insertar nombre]").length > 0);
});

test("nunca marca contenido real (sin corchetes, o corchetes sin placeholder conocido) como placeholder", () => {
  assert.deepEqual(findKnownPlaceholders("Best regards,\n\nThe DreiStaff Team\nsales@dreistaff.com"), []);
  assert.deepEqual(findKnownPlaceholders("Contactame [aquí] para más info"), []);
  assert.deepEqual(findKnownPlaceholders(null), []);
  assert.deepEqual(findKnownPlaceholders(""), []);
});

test("deduplica placeholders repetidos", () => {
  const matches = findKnownPlaceholders("[Your Name] ... más adelante otra vez [Your Name]");
  const count = matches.filter((m) => /your name/i.test(m)).length;
  assert.equal(count, 1);
});
