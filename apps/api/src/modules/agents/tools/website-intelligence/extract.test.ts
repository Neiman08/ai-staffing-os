import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmailDomain, extractFromPage } from "./extract";

/**
 * F28 (calidad de emails organizacionales, hallazgo real 2026-07-27):
 * "admin@www.advancedroofing.biz" fue extraído y persistido tal cual --
 * "www." es un prefijo de host web, nunca parte de un dominio de correo
 * real. Normalizado en el único punto de entrada real (mailto: o texto
 * plano), antes de deduplicar/persistir.
 */

test("normalizeEmailDomain: quita 'www.' del dominio, conserva el local-part intacto", () => {
  assert.equal(normalizeEmailDomain("admin@www.advancedroofing.biz"), "admin@advancedroofing.biz");
});

test("normalizeEmailDomain: sin 'www.' no cambia nada", () => {
  assert.equal(normalizeEmailDomain("info@realcompany.com"), "info@realcompany.com");
});

test("normalizeEmailDomain: un dominio que arranca con 'www' sin el punto (ej. 'wwwidgets.com') nunca se trunca", () => {
  assert.equal(normalizeEmailDomain("sales@wwwidgets.com"), "sales@wwwidgets.com");
});

test("normalizeEmailDomain: sin '@' devuelve el string tal cual, nunca revienta", () => {
  assert.equal(normalizeEmailDomain("not-an-email"), "not-an-email");
});

test("extractFromPage: mailto real con 'www.' en el dominio -- el email extraído queda SIN 'www.' (caso real reportado, admin@www.advancedroofing.biz)", () => {
  const html = `<html><body><a href="mailto:admin@www.advancedroofing.biz">Email us</a></body></html>`;
  const result = extractFromPage(html, "https://www.advancedroofing.biz/contact");
  const emails = result.genericEmails.map((e) => e.email);
  assert.ok(emails.includes("admin@advancedroofing.biz"), `esperaba admin@advancedroofing.biz, obtuvo: ${JSON.stringify(emails)}`);
  assert.ok(!emails.includes("admin@www.advancedroofing.biz"), "nunca debe persistir la forma con www.");
});

test("extractFromPage: email en texto plano con 'www.' en el dominio también se normaliza", () => {
  const html = `<html><body><p>Contact us at office@www.realbusiness.net for more information.</p></body></html>`;
  const result = extractFromPage(html, "https://www.realbusiness.net/contact");
  const emails = result.genericEmails.map((e) => e.email);
  assert.ok(emails.includes("office@realbusiness.net"));
});

test("extractFromPage: emails sintácticamente inválidos (dominio vacío tras normalizar) nunca se persisten", () => {
  const html = `<html><body><a href="mailto:broken@www.">broken</a> <p>Reach us at real@company.com anytime.</p></body></html>`;
  const result = extractFromPage(html, "https://company.com");
  const emails = result.genericEmails.map((e) => e.email);
  assert.ok(!emails.some((e) => e.startsWith("broken@")), "un dominio vacío tras quitar www. nunca debe persistirse");
  assert.ok(emails.includes("real@company.com"));
});
