import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { createAndRunTaskSync } from "../agents/task-executor";
import { extractFields, computeConfidenceScore } from "../agents/tools/discovery-tools.impl";
import { extractFieldsFromGooglePlace } from "../agents/tools/discovery-providers/google-places";
import { REAL_PROVIDER_TESTS_ENABLED, REAL_PROVIDER_TEST_SKIP_REASON } from "../../test-helpers/real-provider-tests";

const createdCompanyIds: string[] = [];

async function cleanupCompany(companyId: string): Promise<void> {
  await prisma.followUp.deleteMany({ where: { entityType: "company", entityId: companyId } });
  await prisma.activity.deleteMany({ where: { entityType: "company", entityId: companyId } });
  await prisma.opportunity.deleteMany({ where: { companyId } });
  await prisma.lead.deleteMany({ where: { companyId } });
  await prisma.contact.deleteMany({ where: { companyId } });
  await prisma.auditLog.deleteMany({ where: { entityType: "company", entityId: companyId } });
  await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
}

after(async () => {
  for (const id of createdCompanyIds) {
    await cleanupCompany(id).catch((err) => console.error(`cleanup failed for company ${id}:`, err));
  }
});

// ============================================================
// Unidad: clasificación de campos determinista, sin red — la regla
// "nunca inventar" (CONFIRMED/INFERRED/NOT_FOUND) se prueba acá sin
// depender de la disponibilidad en tiempo real de la fuente externa.
//
// El flujo completo (misión -> useExternalDiscovery -> discover_companies
// -> sin outreach) se verifica en un navegador real como parte del DoD de
// F4.5A, no acá: una prueba automatizada que lanza una misión completa
// hace demasiadas llamadas reales encadenadas (OpenAI + Overpass con
// reintentos) y compite por rate limits reales con missions.test.ts si
// corre en la misma tanda — se prefirió mantener el suite automatizado
// rápido y no tocar el archivo de tests de F4.
// ============================================================

test("extractFields: tags completos y válidos quedan CONFIRMED, nunca inventa un valor", () => {
  const { name, fields } = extractFields(
    {
      name: "Acme Manufacturing",
      website: "https://acme-mfg.example.com",
      phone: "+1 555-0100",
      email: "info@acme-mfg.example.com",
      "addr:housenumber": "100",
      "addr:street": "Main St",
      "addr:city": "Chicago",
      "addr:postcode": "60601",
    },
    "IL",
  );
  assert.equal(name, "Acme Manufacturing");
  assert.deepEqual(fields.name, { status: "CONFIRMED", value: "Acme Manufacturing" });
  assert.deepEqual(fields.website, { status: "CONFIRMED", value: "https://acme-mfg.example.com" });
  assert.equal(fields.phone!.status, "CONFIRMED");
  assert.equal(fields.email!.status, "CONFIRMED");
  assert.equal(fields.address!.status, "CONFIRMED");
  // OSM nunca da esto — siempre NOT_FOUND, nunca inferido de la nada.
  assert.deepEqual(fields.hiringSignals, { status: "NOT_FOUND", value: null });
  assert.deepEqual(fields.contactName, { status: "NOT_FOUND", value: null });
  assert.deepEqual(fields.visiblePositions, { status: "NOT_FOUND", value: null });
});

test("extractFields: tags ausentes o con formato inválido quedan NOT_FOUND, nunca se inventa un valor de reemplazo", () => {
  const { name, fields } = extractFields(
    { name: "Bad Data Co", website: "not a url", email: "not-an-email" },
    "IL",
  );
  assert.equal(name, "Bad Data Co");
  assert.deepEqual(fields.website, { status: "NOT_FOUND", value: null });
  assert.deepEqual(fields.email, { status: "NOT_FOUND", value: null });
  assert.deepEqual(fields.phone, { status: "NOT_FOUND", value: null });
  assert.deepEqual(fields.address, { status: "NOT_FOUND", value: null });
});

test("extractFields: sin tag name ni operator, name es null (no se crea Company sin nombre real)", () => {
  const { name } = extractFields({ website: "https://example.com" }, "IL");
  assert.equal(name, null);
});

test("extractFields: usa operator como fallback de name cuando no hay tag name", () => {
  const { name, fields } = extractFields({ operator: "AmeriCold Logistics" }, "IL");
  assert.equal(name, "AmeriCold Logistics");
  assert.equal(fields.name!.status, "CONFIRMED");
});

test("computeConfidenceScore: base 0.5 solo con nombre, sube con cada campo confirmado, nunca supera 1", () => {
  const onlyName = extractFields({ name: "X" }, "IL").fields;
  assert.equal(computeConfidenceScore(onlyName), 0.5);

  const full = extractFields(
    {
      name: "X",
      website: "https://x.example.com",
      phone: "555-0100",
      email: "a@x.example.com",
      "addr:housenumber": "1",
      "addr:street": "Main St",
      "addr:city": "Chicago",
    },
    "IL",
  ).fields;
  assert.equal(computeConfidenceScore(full), 1);
});

// ============================================================
// Unidad: mapeo de un Place crudo de Google (sin red) — mismo principio
// "nunca inventar" que Overpass, pero con el shape distinto de la API.
// ============================================================

test("extractFieldsFromGooglePlace: place completo queda CONFIRMED, nunca inventa un valor", () => {
  const { name, fields } = extractFieldsFromGooglePlace(
    {
      id: "place-1",
      displayName: { text: "Acme Manufacturing" },
      formattedAddress: "100 Main St, Chicago, IL 60601, USA",
      websiteUri: "https://acme-mfg.example.com",
      internationalPhoneNumber: "+1 555-0100",
      googleMapsUri: "https://maps.google.com/?cid=123",
      addressComponents: [
        { longText: "Chicago", shortText: "Chicago", types: ["locality"] },
        { longText: "Illinois", shortText: "IL", types: ["administrative_area_level_1"] },
      ],
    },
    "IL",
  );
  assert.equal(name, "Acme Manufacturing");
  assert.deepEqual(fields.name, { status: "CONFIRMED", value: "Acme Manufacturing" });
  assert.deepEqual(fields.website, { status: "CONFIRMED", value: "https://acme-mfg.example.com" });
  assert.equal(fields.phone!.status, "CONFIRMED");
  assert.equal(fields.address!.status, "CONFIRMED");
  assert.deepEqual(fields.city, { status: "CONFIRMED", value: "Chicago" });
  // Google Places nunca da esto — siempre NOT_FOUND, nunca inferido.
  assert.deepEqual(fields.email, { status: "NOT_FOUND", value: null });
  assert.deepEqual(fields.hiringSignals, { status: "NOT_FOUND", value: null });
  assert.deepEqual(fields.contactName, { status: "NOT_FOUND", value: null });
  assert.deepEqual(fields.visiblePositions, { status: "NOT_FOUND", value: null });
});

test("extractFieldsFromGooglePlace: sin displayName, name es null (no se crea Company sin nombre real)", () => {
  const { name } = extractFieldsFromGooglePlace({ id: "place-2", websiteUri: "https://example.com" }, "IL");
  assert.equal(name, null);
});

test("extractFieldsFromGooglePlace: websiteUri inválido queda NOT_FOUND, nunca se inventa un valor de reemplazo", () => {
  const { fields } = extractFieldsFromGooglePlace({ id: "place-3", displayName: { text: "X" }, websiteUri: "not a url" }, "IL");
  assert.deepEqual(fields.website, { status: "NOT_FOUND", value: null });
});

// ============================================================
// Integración real: una llamada real y acotada al proveedor de
// descubrimiento configurado. A partir de F4.5, Google Places es
// primario (si GOOGLE_PLACES_API_KEY está configurada) y Overpass queda
// de respaldo — el test no asume cuál de los dos respondió, solo que el
// AgentTask SIEMPRE termina DONE con una forma de salida honesta (nunca
// FAILED por una fuente caída, nunca inventa resultados), y que
// CUALQUIER empresa creada tiene procedencia completa y ningún Contact
// inventado.
// ============================================================

test(
  "discoverCompanies (llamada real al proveedor configurado): siempre termina DONE, nunca inventa datos, provenance completa si crea algo",
  { skip: REAL_PROVIDER_TESTS_ENABLED ? false : REAL_PROVIDER_TEST_SKIP_REASON },
  async () => {
  const salesUser = await prisma.user.findFirstOrThrow({ where: { email: "sales@titan.dev" } });
  const task = await createAndRunTaskSync(salesUser.tenantId, salesUser.id, {
    agentKey: "discovery",
    type: "discover_companies",
    input: { industryNames: ["Manufacturing"], state: "IL", limit: 2 },
    triggeredBy: "USER",
  });

  assert.equal(task.status, "DONE", `discover_companies nunca debe FAILED por una fuente externa caída: ${task.errorMessage}`);
  const output = task.output as {
    companiesCreated: Array<{ companyId: string; name: string; fields: Record<string, { status: string; value: unknown }>; sourceUrl: string; confidenceScore: number }>;
    candidatesFound: number;
    duplicatesSkipped: number;
    insufficientDataSkipped: number;
    sourcesUsed: string[];
    patternsFailed: string[];
  };
  assert.ok(Array.isArray(output.companiesCreated));
  assert.ok(Array.isArray(output.patternsFailed));
  assert.ok(output.candidatesFound >= 0);

  for (const created of output.companiesCreated) {
    createdCompanyIds.push(created.companyId);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: created.companyId } });
    // Google Places -> API_PROVIDER, Overpass (respaldo) -> EXTERNAL_DISCOVERY.
    assert.ok(["API_PROVIDER", "EXTERNAL_DISCOVERY"].includes(company.origin));
    assert.equal(company.verificationStatus, "CONFIRMED");
    assert.ok(company.sourceUrl, "toda empresa descubierta debe guardar su fuente exacta");
    assert.ok(company.confidenceScore != null && company.confidenceScore >= 0.5 && company.confidenceScore <= 1);
    assert.equal(company.discoveredByAgentTaskId, task.id);

    // Nunca un Contact inventado — ni Google Places ni Overpass dan
    // nombres de personas, este piloto jamás debe crear uno de acá.
    const contacts = await prisma.contact.count({ where: { companyId: created.companyId } });
    assert.equal(contacts, 0);

    for (const [key, f] of Object.entries(created.fields)) {
      assert.ok(["CONFIRMED", "INFERRED", "NOT_FOUND"].includes(f.status), `campo ${key} tiene un status fuera del vocabulario cerrado`);
      if (f.status === "NOT_FOUND") assert.equal(f.value, null);
    }
  }
  },
);

// ============================================================
// Bugfix multi-sector: discover_companies debe soportar N frases de
// búsqueda independientes (searchTerms) archivadas bajo UNA sola
// industria real — cada frase es su propia búsqueda contra el proveedor,
// nunca se colapsan en una sola. searchesExecuted debe reflejar que
// realmente se intentó cada una (aunque el proveedor no devuelva nada
// para alguna), para que mission-orchestrator.ts pueda distinguir "se
// buscó y no había nada" de "nunca se llegó a buscar".
// ============================================================

test(
  "discoverCompanies con searchTerms: corre una búsqueda independiente por frase, nunca inventa datos",
  { skip: REAL_PROVIDER_TESTS_ENABLED ? false : REAL_PROVIDER_TEST_SKIP_REASON },
  async () => {
  const salesUser = await prisma.user.findFirstOrThrow({ where: { email: "sales@titan.dev" } });
  const searchTerms = ["electrical contractor", "low voltage contractor"];
  const task = await createAndRunTaskSync(salesUser.tenantId, salesUser.id, {
    agentKey: "discovery",
    type: "discover_companies",
    input: { industryNames: ["Construction"], searchTerms, state: "IL", limit: 4 },
    triggeredBy: "USER",
  });

  assert.equal(task.status, "DONE", `discover_companies nunca debe FAILED por una fuente externa caída: ${task.errorMessage}`);
  const output = task.output as {
    companiesCreated: Array<{ companyId: string; name: string }>;
    searchesExecuted: number;
    sourcesUsed: string[];
    patternsFailed: string[];
  };
  // Dos frases de búsqueda -> al menos dos intentos reales de proveedor,
  // nunca 0 (eso es exactamente el bug: "0 búsquedas, misión COMPLETED").
  assert.ok(output.searchesExecuted >= searchTerms.length, `se esperaban al menos ${searchTerms.length} búsquedas ejecutadas, hubo ${output.searchesExecuted}`);

  for (const created of output.companiesCreated) {
    createdCompanyIds.push(created.companyId);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: created.companyId } });
    // Ambas frases archivan bajo la MISMA industria real pasada en
    // industryNames — nunca una industria inventada por frase.
    assert.equal(company.industryId, "industry-construction");
  }
  },
);
