import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail, normalizeWebsiteDomain, classifyContactPointType, validateEmailTrust } from "./email-trust";

// ---------- normalizeEmail ----------

test("normalizeEmail: mismo email, distintos formatos, se normalizan al mismo valor", () => {
  assert.equal(normalizeEmail("Info@Acme.COM").value, "info@acme.com");
  assert.equal(normalizeEmail("  info@acme.com  ").value, "info@acme.com");
});

test("normalizeEmail: mailto: se elimina", () => {
  assert.equal(normalizeEmail("mailto:info@acme.com").value, "info@acme.com");
  assert.equal(normalizeEmail("MAILTO:info@acme.com").value, "info@acme.com");
});

test("normalizeEmail: parámetros después de ? se eliminan", () => {
  assert.equal(normalizeEmail("info@acme.com?subject=Hello%20there").value, "info@acme.com");
  assert.equal(normalizeEmail("mailto:info@acme.com?subject=Hi").value, "info@acme.com");
});

test("normalizeEmail: espacios internos se eliminan", () => {
  assert.equal(normalizeEmail("in fo@acme.com").value, "info@acme.com");
});

test("normalizeEmail: URL-encoded se decodifica de forma segura", () => {
  const result = normalizeEmail("%20press@equinix.com");
  assert.equal(result.value, "press@equinix.com");
  assert.equal(result.wasUrlEncoded, true);
});

test("normalizeEmail: decode inválido no revienta, sigue con el crudo", () => {
  const result = normalizeEmail("%zzinvalid@example.org");
  assert.equal(result.valid, false);
});

test("normalizeEmail: placeholder conocido -> invalid con reason placeholder_domain", () => {
  const result = normalizeEmail("test@example.com");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "placeholder_domain");
});

test("normalizeEmail: sintaxis inválida -> invalid con reason invalid_syntax", () => {
  const result = normalizeEmail("not-an-email");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid_syntax");
});

test("normalizeEmail: vacío/null -> invalid con reason empty", () => {
  assert.equal(normalizeEmail(null).reason, "empty");
  assert.equal(normalizeEmail("").reason, "empty");
  assert.equal(normalizeEmail("   ").reason, "empty");
});

test("normalizeEmail: extrae el dominio correctamente", () => {
  assert.equal(normalizeEmail("sales@generalmanufacturing.net").domain, "generalmanufacturing.net");
});

// ---------- normalizeWebsiteDomain ----------

test("normalizeWebsiteDomain: quita www. y usa minúsculas", () => {
  assert.equal(normalizeWebsiteDomain("https://www.GeneralManufacturing.net"), "generalmanufacturing.net");
  assert.equal(normalizeWebsiteDomain("generalmanufacturing.net"), "generalmanufacturing.net");
});

test("normalizeWebsiteDomain: null para input vacío/inválido", () => {
  assert.equal(normalizeWebsiteDomain(null), null);
  assert.equal(normalizeWebsiteDomain(""), null);
});

// ---------- classifyContactPointType ----------

test("classifyContactPointType: mapea local-parts conocidos", () => {
  assert.equal(classifyContactPointType("info@acme.com"), "INFO");
  assert.equal(classifyContactPointType("sales@acme.com"), "SALES");
  assert.equal(classifyContactPointType("hr@acme.com"), "HR");
  assert.equal(classifyContactPointType("careers@acme.com"), "CAREERS");
  assert.equal(classifyContactPointType("recruiting@acme.com"), "RECRUITING");
  assert.equal(classifyContactPointType("support@acme.com"), "SUPPORT");
  assert.equal(classifyContactPointType("press@acme.com"), "PRESS");
  assert.equal(classifyContactPointType("billing@acme.com"), "BILLING");
  assert.equal(classifyContactPointType("procurement@acme.com"), "PROCUREMENT");
});

test("classifyContactPointType: local-part desconocido -> OTHER, nunca inventa un rol", () => {
  assert.equal(classifyContactPointType("jsmith@acme.com"), "OTHER");
});

// ---------- validateEmailTrust: reglas de dominio ----------

test("mismo dominio exacto -> VERIFIED", () => {
  const result = validateEmailTrust({ rawEmail: "info@generalmanufacturing.net", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.matchedOfficialDomain, true);
});

test("subdominio real del sitio oficial -> VERIFIED", () => {
  const result = validateEmailTrust({ rawEmail: "hr@mail.generalmanufacturing.net", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(result.status, "VERIFIED");
});

test("website es subdominio del email (relación inversa) -> VERIFIED", () => {
  const result = validateEmailTrust({ rawEmail: "info@generalmanufacturing.net", companyWebsite: "https://careers.generalmanufacturing.net" });
  assert.equal(result.status, "VERIFIED");
});

test("dominio alternativo explícitamente confirmado -> VERIFIED", () => {
  const result = validateEmailTrust({
    rawEmail: "info@generalmfg.com",
    companyWebsite: "https://generalmanufacturing.net",
    knownAlternateDomains: ["generalmfg.com"],
  });
  assert.equal(result.status, "VERIFIED");
});

test("dominio ajeno sin ninguna relación -> INVALID", () => {
  const result = validateEmailTrust({ rawEmail: "info@othercompany.com", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(result.status, "INVALID");
});

test("Gmail/Yahoo (proveedor gratuito) -> RISKY, nunca VERIFIED aunque no haya nada más raro", () => {
  const gmail = validateEmailTrust({ rawEmail: "owner@gmail.com", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(gmail.status, "RISKY");
  assert.equal(gmail.isFreeEmailProvider, true);

  const yahoo = validateEmailTrust({ rawEmail: "owner@yahoo.com", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(yahoo.status, "RISKY");
});

test("catch-all sin verificación dedicada -> RISKY aunque el dominio coincida", () => {
  const result = validateEmailTrust({
    rawEmail: "info@generalmanufacturing.net",
    companyWebsite: "https://generalmanufacturing.net",
    isCatchAll: true,
  });
  assert.equal(result.status, "RISKY");
  assert.equal(result.matchedOfficialDomain, true);
});

test("URL encoded -> se normaliza y luego se evalúa el dominio normalmente", () => {
  const result = validateEmailTrust({ rawEmail: "%20press@generalmanufacturing.net", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.normalizedEmail, "press@generalmanufacturing.net");
});

test("mailto: -> se normaliza y luego se evalúa el dominio normalmente", () => {
  const result = validateEmailTrust({ rawEmail: "mailto:hr@generalmanufacturing.net", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(result.status, "VERIFIED");
});

test("espacios internos -> se normalizan y luego se evalúa el dominio normalmente", () => {
  const result = validateEmailTrust({ rawEmail: " h r@generalmanufacturing.net ", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(result.status, "VERIFIED");
});

test("mayúsculas -> se normalizan y luego se evalúa el dominio normalmente", () => {
  const result = validateEmailTrust({ rawEmail: "HR@GeneralManufacturing.NET", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(result.status, "VERIFIED");
});

test("parámetros (?subject=) -> se eliminan y luego se evalúa el dominio normalmente", () => {
  const result = validateEmailTrust({ rawEmail: "hr@generalmanufacturing.net?subject=Careers", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(result.status, "VERIFIED");
});

test("placeholder -> INVALID, nunca llega a comparar dominio", () => {
  const result = validateEmailTrust({ rawEmail: "test@example.com", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(result.status, "INVALID");
  assert.equal(result.reasons[0], 'Dominio placeholder/de ejemplo: "example.com".');
});

test("sin website conocido de la empresa -> UNKNOWN (no se puede comparar dominio)", () => {
  const result = validateEmailTrust({ rawEmail: "info@somecompany.com", companyWebsite: null });
  assert.equal(result.status, "UNKNOWN");
});

// ---------- Roles organizacionales (type) ----------

for (const [prefix, expected] of [
  ["press", "PRESS"],
  ["hr", "HR"],
  ["careers", "CAREERS"],
  ["sales", "SALES"],
  ["info", "INFO"],
] as const) {
  test(`${prefix}@ se clasifica como ${expected}`, () => {
    const result = validateEmailTrust({ rawEmail: `${prefix}@generalmanufacturing.net`, companyWebsite: "https://generalmanufacturing.net" });
    assert.equal(result.type, expected);
  });
}

// ---------- El caso real reportado por el PO ----------

test("editor@collegefencing360.com contra generalmanufacturing.net -> INVALID (el bug real reportado nunca debe quedar Confirmed)", () => {
  const result = validateEmailTrust({ rawEmail: "editor@collegefencing360.com", companyWebsite: "https://generalmanufacturing.net" });
  assert.equal(result.status, "INVALID");
  assert.equal(result.matchedOfficialDomain, false);
  assert.ok(result.reasons[0]!.includes("collegefencing360.com"));
  assert.ok(result.reasons[0]!.includes("generalmanufacturing.net"));
});

// ---------- Determinismo ----------

test("misma entrada siempre produce el mismo resultado (determinista)", () => {
  const input = { rawEmail: "hr@generalmanufacturing.net", companyWebsite: "https://generalmanufacturing.net" };
  assert.deepEqual(validateEmailTrust(input), validateEmailTrust(input));
});
