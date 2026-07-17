import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { createAndRunTaskSync } from "./task-executor";
import { computeContactConfidenceScore, mapTitleToDecisionRole } from "./tools/contact-intelligence-tools.impl";
import { extractFieldsFromPdlPerson } from "./tools/contact-providers/people-data-labs";
import { extractFromPage, findTargetLinks } from "./tools/website-intelligence/extract";
import { mapStatusToVerificationStatus } from "./tools/email-verification-providers/hunter";
import { REAL_PROVIDER_TESTS_ENABLED, REAL_PROVIDER_TEST_SKIP_REASON } from "../../test-helpers/real-provider-tests";

const createdContactIds: string[] = [];

after(async () => {
  for (const id of createdContactIds) {
    await prisma.contact.delete({ where: { id } }).catch(() => {});
  }
});

// ============================================================
// Unidad: mapeo de un person crudo de People Data Labs (sin red) — mismo
// principio "nunca inventar" que Discovery: cada campo CONFIRMED solo si
// vino literal de la respuesta, NOT_FOUND en cualquier otro caso.
// ============================================================

test("extractFieldsFromPdlPerson: person completo queda CONFIRMED, nunca inventa un valor", () => {
  const { firstName, lastName, title, fields } = extractFieldsFromPdlPerson({
    first_name: "Jane",
    last_name: "Doe",
    job_title: "HR Manager",
    job_company_name: "Acme Manufacturing",
    linkedin_url: "https://linkedin.com/in/janedoe",
    work_email: "jane.doe@acme-mfg.example.com",
    mobile_phone: "+1 555-0100",
  });
  assert.equal(firstName, "Jane");
  assert.equal(lastName, "Doe");
  assert.equal(title, "HR Manager");
  assert.deepEqual(fields.firstName, { status: "CONFIRMED", value: "Jane" });
  assert.deepEqual(fields.linkedinUrl, { status: "CONFIRMED", value: "https://linkedin.com/in/janedoe" });
  assert.equal(fields.email!.status, "CONFIRMED");
  assert.equal(fields.phone!.status, "CONFIRMED");
});

test("extractFieldsFromPdlPerson: campos ausentes o inválidos quedan NOT_FOUND, nunca se inventa un valor de reemplazo", () => {
  const { fields } = extractFieldsFromPdlPerson({
    first_name: "Bad",
    last_name: "Data",
    linkedin_url: "not a url",
    work_email: "not-an-email",
  });
  assert.deepEqual(fields.linkedinUrl, { status: "NOT_FOUND", value: null });
  assert.deepEqual(fields.email, { status: "NOT_FOUND", value: null });
  assert.deepEqual(fields.phone, { status: "NOT_FOUND", value: null });
  assert.deepEqual(fields.title, { status: "NOT_FOUND", value: null });
});

test("extractFieldsFromPdlPerson: sin first_name/last_name, quedan null (no se crea Contact sin nombre real)", () => {
  const { firstName, lastName } = extractFieldsFromPdlPerson({ job_title: "Recruiter" });
  assert.equal(firstName, null);
  assert.equal(lastName, null);
});

test("computeContactConfidenceScore: base 0.5 solo con nombre, sube con cada campo confirmado, nunca supera 1", () => {
  const onlyName = extractFieldsFromPdlPerson({ first_name: "X", last_name: "Y" }).fields;
  assert.equal(computeContactConfidenceScore(onlyName), 0.5);

  const full = extractFieldsFromPdlPerson({
    first_name: "X",
    last_name: "Y",
    job_title: "Owner",
    linkedin_url: "https://linkedin.com/in/xy",
    work_email: "x@y.example.com",
    mobile_phone: "555-0100",
  }).fields;
  assert.equal(computeContactConfidenceScore(full), 1);
});

test("mapTitleToDecisionRole: clasifica cargos prioritarios reales, nunca inventa uno si no matchea", () => {
  assert.equal(mapTitleToDecisionRole("HR Manager"), "HR");
  assert.equal(mapTitleToDecisionRole("Talent Acquisition Specialist"), "TALENT_ACQUISITION");
  assert.equal(mapTitleToDecisionRole("Senior Recruiter"), "RECRUITER");
  assert.equal(mapTitleToDecisionRole("Warehouse Manager"), "WAREHOUSE_MANAGER");
  assert.equal(mapTitleToDecisionRole("Plant Manager"), "PLANT_MANAGER");
  assert.equal(mapTitleToDecisionRole("Director of Operations"), "DIRECTOR_OF_OPERATIONS");
  assert.equal(mapTitleToDecisionRole("Operations Manager"), "OPERATIONS_MANAGER");
  assert.equal(mapTitleToDecisionRole("General Manager"), "GENERAL_MANAGER");
  assert.equal(mapTitleToDecisionRole("Purchasing Manager"), "PURCHASING_MANAGER");
  assert.equal(mapTitleToDecisionRole("Owner"), "OWNER");
  assert.equal(mapTitleToDecisionRole("Software Engineer"), null);
  assert.equal(mapTitleToDecisionRole(null), null);
});

// ============================================================
// Integración real: una llamada real y acotada al proveedor configurado
// (People Data Labs). Si PEOPLEDATALABS_API_KEY no está configurada,
// el tool no debe inventar nada — debe terminar DONE con 0 contactos y
// el motivo real en patternsFailed. Si está configurada, cualquier
// Contact creado debe tener procedencia completa y ningún dato inventado.
// ============================================================

test(
  "findContacts (llamada real al proveedor configurado o ausencia honesta): siempre termina DONE, nunca inventa datos",
  { skip: REAL_PROVIDER_TESTS_ENABLED ? false : REAL_PROVIDER_TEST_SKIP_REASON },
  async () => {
  const salesUser = await prisma.user.findFirstOrThrow({ where: { email: "sales@titan.dev" } });
  const company = await prisma.company.findFirstOrThrow({ where: { tenantId: salesUser.tenantId } });

  const task = await createAndRunTaskSync(salesUser.tenantId, salesUser.id, {
    agentKey: "contact_intelligence",
    type: "find_contacts",
    input: { companyId: company.id, limit: 3 },
    triggeredBy: "USER",
  });

  assert.equal(task.status, "DONE", `find_contacts nunca debe FAILED por un proveedor caído/sin configurar: ${task.errorMessage}`);
  const output = task.output as {
    contactsCreated: Array<{ contactId: string; firstName: string; lastName: string; fields: Record<string, { status: string; value: unknown }> }>;
    candidatesFound: number;
    duplicatesSkipped: number;
    insufficientDataSkipped: number;
    sourcesUsed: string[];
    patternsFailed: string[];
  };
  assert.ok(Array.isArray(output.contactsCreated));
  assert.ok(Array.isArray(output.patternsFailed));

  for (const created of output.contactsCreated) {
    createdContactIds.push(created.contactId);
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: created.contactId } });
    assert.equal(contact.verificationStatus, "CONFIRMED");
    assert.equal(contact.source, "People Data Labs");
    assert.ok(contact.confidenceScore != null && contact.confidenceScore >= 0.5 && contact.confidenceScore <= 1);
    assert.equal(contact.discoveredByAgentTaskId, task.id);
    assert.equal(contact.companyId, company.id);

    for (const [key, f] of Object.entries(created.fields)) {
      assert.ok(["CONFIRMED", "INFERRED", "NOT_FOUND"].includes(f.status), `campo ${key} tiene un status fuera del vocabulario cerrado`);
      if (f.status === "NOT_FOUND") assert.equal(f.value, null);
    }
  }
  },
);

// ============================================================
// F4.7: Website Intelligence — extracción pura de HTML (sin red). Mismo
// principio "nunca inventar": un email/tarjeta de persona solo cuenta si
// está literal en el HTML, nunca por inferencia.
// ============================================================

test("extractFromPage: mailto: real con nombre+cargo en el mismo bloque arma una tarjeta de persona", () => {
  const html = `
    <html><body>
      <div class="team-card">
        <h3>Jane Doe</h3>
        <p>HR Manager</p>
        <a href="mailto:jane.doe@acme-mfg.example.com">Email Jane</a>
      </div>
    </body></html>`;
  const result = extractFromPage(html, "https://acme-mfg.example.com/team");
  assert.equal(result.namedPeople.length, 1);
  assert.deepEqual(result.namedPeople[0], {
    firstName: "Jane",
    lastName: "Doe",
    title: "HR Manager",
    email: "jane.doe@acme-mfg.example.com",
    sourceUrl: "https://acme-mfg.example.com/team",
  });
  assert.equal(result.genericEmails.length, 1);
});

test("extractFromPage: mailto: sin nombre/cargo cerca queda como email genérico, nunca se inventa una persona", () => {
  const html = `<html><body><footer>Contactanos: <a href="mailto:info@acme-mfg.example.com">info@acme-mfg.example.com</a></footer></body></html>`;
  const result = extractFromPage(html, "https://acme-mfg.example.com/contact");
  assert.equal(result.namedPeople.length, 0);
  assert.deepEqual(result.genericEmails, [{ email: "info@acme-mfg.example.com", sourceUrl: "https://acme-mfg.example.com/contact" }]);
});

test("extractFromPage: emails placeholder/de ejemplo se descartan, nunca se reportan como reales", () => {
  const html = `<html><body>Contact: you@example.com or support@yourdomain.com</body></html>`;
  const result = extractFromPage(html, "https://acme-mfg.example.com/");
  assert.equal(result.genericEmails.length, 0);
});

test("extractFromPage: detecta formulario de contacto sin interactuar con él", () => {
  const html = `<html><body><form action="/submit"><input name="email" /></form></body></html>`;
  const result = extractFromPage(html, "https://acme-mfg.example.com/contact");
  assert.equal(result.hasContactForm, true);
});

test("findTargetLinks: solo links del MISMO dominio que matchean rutas objetivo (contact/about/team/careers/...)", () => {
  const html = `
    <html><body>
      <a href="/about-us">About</a>
      <a href="/careers">Careers</a>
      <a href="https://otrodominio.example.com/team">Team externo</a>
      <a href="/products">Products</a>
    </body></html>`;
  const links = findTargetLinks(html, "https://acme-mfg.example.com/");
  assert.ok(links.some((l) => l.includes("/about-us")));
  assert.ok(links.some((l) => l.includes("/careers")));
  assert.ok(!links.some((l) => l.includes("otrodominio")), "nunca debe seguir un link a un dominio externo");
  assert.ok(!links.some((l) => l.includes("/products")), "no matchea ninguna ruta objetivo, no debe incluirse");
});

// ============================================================
// F4.7: mapeo del estado real de Hunter.io Email Verifier — confirmado
// contra una llamada real que el campo vigente es `status`, no `result`
// (marcado deprecated por la propia API).
// ============================================================

test("mapStatusToVerificationStatus: clasifica el vocabulario real de Hunter, UNKNOWN si no matchea nada conocido", () => {
  assert.equal(mapStatusToVerificationStatus("valid"), "VERIFIED");
  assert.equal(mapStatusToVerificationStatus("invalid"), "INVALID");
  assert.equal(mapStatusToVerificationStatus("disposable"), "INVALID");
  assert.equal(mapStatusToVerificationStatus("accept_all"), "RISKY");
  assert.equal(mapStatusToVerificationStatus("webmail"), "RISKY");
  assert.equal(mapStatusToVerificationStatus("unknown"), "UNKNOWN");
  assert.equal(mapStatusToVerificationStatus(undefined), "UNKNOWN");
});

// ============================================================
// Integración real: findEmail (Website Intelligence + Hunter.io
// discovery/verification configurados o ausencia honesta). Si
// HUNTER_API_KEY no está configurada, el tool no debe inventar nada —
// debe terminar DONE con 0 emails y el motivo real en patternsFailed.
// ============================================================

test(
  "findEmail (llamada real a Website Intelligence + Hunter.io o ausencia honesta): siempre termina DONE, nunca inventa un email",
  { skip: REAL_PROVIDER_TESTS_ENABLED ? false : REAL_PROVIDER_TEST_SKIP_REASON },
  async () => {
  const salesUser = await prisma.user.findFirstOrThrow({ where: { email: "sales@titan.dev" } });
  const company = await prisma.company.findFirstOrThrow({ where: { tenantId: salesUser.tenantId, website: { not: null } } });

  const task = await createAndRunTaskSync(salesUser.tenantId, salesUser.id, {
    agentKey: "contact_intelligence",
    type: "find_email",
    input: { companyId: company.id },
    triggeredBy: "USER",
  });

  assert.equal(task.status, "DONE", `find_email nunca debe FAILED por un proveedor caído/sin configurar: ${task.errorMessage}`);
  const output = task.output as {
    contactsProcessed: number;
    emailsFound: number;
    emailsVerified: number;
    contactsUpdated: Array<{ contactId: string; email: string | null; emailVerificationStatus: string }>;
    companyEmailUpdated: boolean;
    websitePagesVisited: number;
    sourcesUsed: string[];
    patternsFailed: string[];
  };
  assert.ok(Array.isArray(output.contactsUpdated));
  assert.ok(Array.isArray(output.patternsFailed));
  assert.ok(typeof output.websitePagesVisited === "number");

  for (const updated of output.contactsUpdated) {
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: updated.contactId } });
    assert.ok(
      ["NOT_VERIFIED", "VERIFIED", "RISKY", "INVALID", "UNKNOWN"].includes(contact.emailVerificationStatus),
      "emailVerificationStatus fuera del vocabulario cerrado",
    );
    // Nunca se persiste un email sin al menos una fuente identificable.
    if (contact.email) assert.ok(contact.emailSource, "un Contact con email debe tener emailSource — nunca un email sin procedencia");
  }
  },
);
