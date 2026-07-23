import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBestContactChannel, isEmailCapableChannel, type ContactChannelInput } from "./contact-channel";

function baseInput(overrides: Partial<ContactChannelInput> = {}): ContactChannelInput {
  return {
    contacts: [],
    contactPoints: [],
    companyEmail: null,
    companyPhone: null,
    careersPageUrl: null,
    contactFormUrl: null,
    companyLinkedinUrl: null,
    ...overrides,
  };
}

test("tier 1: contacto personal con email VERIFIED gana sobre cualquier otro canal", () => {
  const r = resolveBestContactChannel(
    baseInput({
      contacts: [{ email: "jane@acme.com", emailVerificationStatus: "VERIFIED", linkedinUrl: null }],
      contactPoints: [{ email: "info@acme.com", verificationStatus: "VERIFIED" }],
      companyPhone: "555-0100",
    }),
  );
  assert.equal(r.channel, "VERIFIED_PERSON_EMAIL");
  assert.equal(r.value, "jane@acme.com");
  assert.equal(r.isEmailCapable, true);
});

test("tier 2: sin contacto personal verificado, email organizacional VERIFIED gana", () => {
  const r = resolveBestContactChannel(
    baseInput({
      contacts: [{ email: "jane@acme.com", emailVerificationStatus: "RISKY", linkedinUrl: null }],
      contactPoints: [{ email: "info@acme.com", verificationStatus: "VERIFIED" }],
    }),
  );
  assert.equal(r.channel, "VERIFIED_ORG_EMAIL");
  assert.equal(r.value, "info@acme.com");
  assert.equal(r.isEmailCapable, true);
});

test("tier 3: email organizacional sin verificar (encontrado en el sitio) sigue siendo email-capable", () => {
  const r = resolveBestContactChannel(
    baseInput({ contactPoints: [{ email: "hr@acme.com", verificationStatus: "UNKNOWN" }] }),
  );
  assert.equal(r.channel, "WEBSITE_ORG_EMAIL");
  assert.equal(r.value, "hr@acme.com");
  assert.equal(r.isEmailCapable, true);
});

test("tier 3 (fallback): sin CompanyContactPoint pero con Company.email, también cuenta como WEBSITE_ORG_EMAIL", () => {
  const r = resolveBestContactChannel(baseInput({ companyEmail: "contact@acme.com" }));
  assert.equal(r.channel, "WEBSITE_ORG_EMAIL");
  assert.equal(r.value, "contact@acme.com");
});

test("tier 4: sin ningún email, formulario de contacto real gana -- nunca email-capable", () => {
  const r = resolveBestContactChannel(baseInput({ contactFormUrl: "https://acme.com/contact" }));
  assert.equal(r.channel, "CONTACT_FORM");
  assert.equal(r.value, "https://acme.com/contact");
  assert.equal(r.isEmailCapable, false);
});

test("tier 5: sin email ni formulario, careers page real gana", () => {
  const r = resolveBestContactChannel(baseInput({ careersPageUrl: "https://acme.com/careers" }));
  assert.equal(r.channel, "CAREERS_PAGE");
  assert.equal(r.isEmailCapable, false);
});

test("tier 6: sin email/formulario/careers, LinkedIn real de un contacto gana", () => {
  const r = resolveBestContactChannel(
    baseInput({ contacts: [{ email: null, emailVerificationStatus: null, linkedinUrl: "https://linkedin.com/company/acme" }] }),
  );
  assert.equal(r.channel, "LINKEDIN");
  assert.equal(r.isEmailCapable, false);
});

test("tier 6 (F22): LinkedIn CORPORATIVO del sitio oficial (sin ningún Contact) también gana el tier LINKEDIN", () => {
  const r = resolveBestContactChannel(baseInput({ companyLinkedinUrl: "https://www.linkedin.com/company/acme-corp" }));
  assert.equal(r.channel, "LINKEDIN");
  assert.equal(r.value, "https://www.linkedin.com/company/acme-corp");
  assert.equal(r.isEmailCapable, false);
});

test("tier 7: solo queda el teléfono principal", () => {
  const r = resolveBestContactChannel(baseInput({ companyPhone: "555-0100" }));
  assert.equal(r.channel, "PHONE");
  assert.equal(r.value, "555-0100");
  assert.equal(r.isEmailCapable, false);
});

test("NONE: sin ningún canal real -- nunca inventa un email/nombre/canal, la Company sigue siendo válida", () => {
  const r = resolveBestContactChannel(baseInput());
  assert.equal(r.channel, "NONE");
  assert.equal(r.value, null);
  assert.equal(r.isEmailCapable, false);
});

// ---------- F24 (auditoría de producción): scoring de calidad, casos reales ----------

test("Essence Suites (real): entre 3 variantes VERIFIED del mismo alias, elige la limpia y descarta las contaminadas con teléfono", () => {
  const r = resolveBestContactChannel(
    baseInput({
      contactPoints: [
        { email: "states7084033300romance@essencesuites.com", verificationStatus: "VERIFIED" },
        { email: "7084033300romance@essencesuites.com", verificationStatus: "VERIFIED" },
        { email: "romance@essencesuites.com", verificationStatus: "VERIFIED" },
      ],
    }),
  );
  assert.equal(r.channel, "VERIFIED_ORG_EMAIL");
  assert.equal(r.value, "romance@essencesuites.com");
});

test("The Guesthouse Hotel (real): entre 4 variantes VERIFIED, descarta la contaminada y elige la más corta entre las limpias", () => {
  const r = resolveBestContactChannel(
    baseInput({
      contactPoints: [
        { email: "564-9568stay@theguesthousehotel.com", verificationStatus: "VERIFIED" },
        { email: "eventevents@theguesthousehotel.com", verificationStatus: "VERIFIED" },
        { email: "events@theguesthousehotel.com", verificationStatus: "VERIFIED" },
        { email: "stay@theguesthousehotel.com", verificationStatus: "VERIFIED" },
      ],
    }),
  );
  assert.equal(r.channel, "VERIFIED_ORG_EMAIL");
  assert.equal(r.value, "stay@theguesthousehotel.com");
});

test("Urban Collective Boutique Hotel (real): única variante disponible está contaminada -- se descarta y degrada de tier en vez de usarla", () => {
  const r = resolveBestContactChannel(
    baseInput({
      contactPoints: [{ email: "226.8686bookings@urbancollectivehotel.com", verificationStatus: "VERIFIED" }],
      contactFormUrl: "https://urbancollectivehotel.com/contact",
    }),
  );
  assert.notEqual(r.channel, "VERIFIED_ORG_EMAIL");
  assert.notEqual(r.value, "226.8686bookings@urbancollectivehotel.com");
  assert.equal(r.channel, "CONTACT_FORM");
});

test("Ruebel Hotel (real): dos emails gmail.com RISKY -- ninguno alcanza un tier de email, nunca se usa un proveedor personal como canal organizacional", () => {
  const r = resolveBestContactChannel(
    baseInput({
      contactPoints: [
        { email: "ruebeltl@gmail.com", verificationStatus: "RISKY" },
        { email: "ruebelmo@gmail.com", verificationStatus: "RISKY" },
      ],
      companyPhone: "555-0199",
    }),
  );
  assert.equal(r.isEmailCapable, false);
  assert.equal(r.channel, "PHONE");
});

test("un local-part con pocos dígitos (año, extensión corta) nunca se marca como contaminado", () => {
  const r = resolveBestContactChannel(baseInput({ contactPoints: [{ email: "sales2024@acme.com", verificationStatus: "VERIFIED" }] }));
  assert.equal(r.channel, "VERIFIED_ORG_EMAIL");
  assert.equal(r.value, "sales2024@acme.com");
});

test("contacto personal (tier 1) contaminado con teléfono también se descarta, cae al siguiente tier disponible", () => {
  const r = resolveBestContactChannel(
    baseInput({
      contacts: [{ email: "5551234567jane@acme.com", emailVerificationStatus: "VERIFIED", linkedinUrl: null }],
      contactPoints: [{ email: "info@acme.com", verificationStatus: "VERIFIED" }],
    }),
  );
  assert.equal(r.channel, "VERIFIED_ORG_EMAIL");
  assert.equal(r.value, "info@acme.com");
});

test("isEmailCapableChannel refleja exactamente los 3 primeros tiers, nunca los 4 canales alternativos", () => {
  assert.equal(isEmailCapableChannel("VERIFIED_PERSON_EMAIL"), true);
  assert.equal(isEmailCapableChannel("VERIFIED_ORG_EMAIL"), true);
  assert.equal(isEmailCapableChannel("WEBSITE_ORG_EMAIL"), true);
  assert.equal(isEmailCapableChannel("CONTACT_FORM"), false);
  assert.equal(isEmailCapableChannel("CAREERS_PAGE"), false);
  assert.equal(isEmailCapableChannel("LINKEDIN"), false);
  assert.equal(isEmailCapableChannel("PHONE"), false);
  assert.equal(isEmailCapableChannel("NONE"), false);
});
