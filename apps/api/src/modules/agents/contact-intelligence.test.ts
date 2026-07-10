import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { createAndRunTaskSync } from "./task-executor";
import { computeContactConfidenceScore, mapTitleToDecisionRole } from "./tools/contact-intelligence-tools.impl";
import { extractFieldsFromPdlPerson } from "./tools/contact-providers/people-data-labs";

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

test("findContacts (llamada real al proveedor configurado o ausencia honesta): siempre termina DONE, nunca inventa datos", async () => {
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
});
