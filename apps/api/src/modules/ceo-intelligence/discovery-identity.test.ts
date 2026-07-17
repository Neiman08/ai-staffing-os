import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCompanyName,
  normalizeDomain,
  normalizePhone,
  extractProviderPlaceId,
  buildCompanyIdentityKeys,
  deduplicateDiscoveryCandidates,
  type DiscoveryCandidateLike,
} from "./discovery-identity";

// ---------- normalizeCompanyName ----------

test("normalizeCompanyName minusculas, sin acentos, sin sufijo corporativo, espacios colapsados", () => {
  assert.equal(normalizeCompanyName("Prairie Manufacturing Co."), "prairie manufacturing");
  assert.equal(normalizeCompanyName("Acme Logistics, LLC"), "acme logistics");
  assert.equal(normalizeCompanyName("Café Naïve Corp"), "cafe naive");
  assert.equal(normalizeCompanyName("  Multi   Space   Inc  "), "multi space");
});

test("normalizeCompanyName vacio para null/undefined/string vacio", () => {
  assert.equal(normalizeCompanyName(null), "");
  assert.equal(normalizeCompanyName(undefined), "");
  assert.equal(normalizeCompanyName(""), "");
});

// ---------- normalizeDomain ----------

test("normalizeDomain quita www. y usa minusculas", () => {
  assert.equal(normalizeDomain("https://www.Example.com/path"), "example.com");
  assert.equal(normalizeDomain("http://sub.example.com"), "sub.example.com");
});

test("normalizeDomain devuelve null para input invalido o vacio", () => {
  assert.equal(normalizeDomain(null), null);
  assert.equal(normalizeDomain(""), null);
  assert.equal(normalizeDomain("not a url"), null);
});

// ---------- normalizePhone ----------

test("normalizePhone acepta 10 digitos y 11 con prefijo 1", () => {
  assert.equal(normalizePhone("(312) 555-0100"), "+13125550100");
  assert.equal(normalizePhone("1-312-555-0100"), "+13125550100");
});

test("normalizePhone null para longitudes invalidas", () => {
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone("555-0100"), null);
  assert.equal(normalizePhone("2-312-555-0100"), null);
});

// ---------- extractProviderPlaceId ----------

test("extractProviderPlaceId extrae el id del formato de respaldo de google-places.ts", () => {
  assert.equal(
    extractProviderPlaceId("https://www.google.com/maps/place/?q=place_id:ChIJabc123"),
    "ChIJabc123",
  );
});

test("extractProviderPlaceId devuelve null cuando sourceUrl es un googleMapsUri real sin el patron", () => {
  assert.equal(extractProviderPlaceId("https://maps.google.com/?cid=12345"), null);
  assert.equal(extractProviderPlaceId(null), null);
});

// ---------- buildCompanyIdentityKeys ----------

test("buildCompanyIdentityKeys arma las 4 claves en el shape esperado", () => {
  const keys = buildCompanyIdentityKeys({
    name: "Acme Manufacturing LLC",
    website: "https://www.acme.com",
    phone: "(312) 555-0100",
    city: "Chicago",
    state: "IL",
    sourceUrl: "https://www.google.com/maps/place/?q=place_id:XYZ",
  });
  assert.deepEqual(keys, {
    providerPlaceId: "XYZ",
    canonicalDomain: "acme.com",
    normalizedPhone: "+13125550100",
    normalizedNameCityState: "acme manufacturing|chicago|il",
  });
});

test("buildCompanyIdentityKeys normalizedNameCityState nunca es null, incluso sin ciudad/estado", () => {
  const keys = buildCompanyIdentityKeys({
    name: "Acme",
    website: null,
    phone: null,
    city: null,
    state: null,
    sourceUrl: null,
  });
  assert.equal(keys.normalizedNameCityState, "acme||");
  assert.equal(keys.providerPlaceId, null);
  assert.equal(keys.canonicalDomain, null);
  assert.equal(keys.normalizedPhone, null);
});

// ---------- deduplicateDiscoveryCandidates ----------

function candidate(identity: {
  providerPlaceId?: string | null;
  canonicalDomain?: string | null;
  normalizedPhone?: string | null;
  normalizedNameCityState?: string;
}): DiscoveryCandidateLike {
  return {
    identity: {
      providerPlaceId: null,
      canonicalDomain: null,
      normalizedPhone: null,
      normalizedNameCityState: "x|x|x",
      ...identity,
    },
  };
}

test("deduplicateDiscoveryCandidates: mismo providerPlaceId es duplicado (prioridad maxima)", () => {
  const a = candidate({ providerPlaceId: "P1", canonicalDomain: "a.com" });
  const b = candidate({ providerPlaceId: "P1", canonicalDomain: "b.com" }); // dominio distinto, mismo place id
  const { unique, duplicates } = deduplicateDiscoveryCandidates([a, b]);
  assert.equal(unique.length, 1);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]!.matchedOn, "providerPlaceId");
});

test("deduplicateDiscoveryCandidates: mismo canonicalDomain es duplicado cuando no hay providerPlaceId", () => {
  const a = candidate({ canonicalDomain: "acme.com" });
  const b = candidate({ canonicalDomain: "acme.com" });
  const { unique, duplicates } = deduplicateDiscoveryCandidates([a, b]);
  assert.equal(unique.length, 1);
  assert.equal(duplicates[0]!.matchedOn, "canonicalDomain");
});

test("deduplicateDiscoveryCandidates: mismo normalizedPhone es duplicado cuando no hay placeId/dominio", () => {
  const a = candidate({ normalizedPhone: "+13125550100" });
  const b = candidate({ normalizedPhone: "+13125550100" });
  const { duplicates } = deduplicateDiscoveryCandidates([a, b]);
  assert.equal(duplicates[0]!.matchedOn, "normalizedPhone");
});

test("deduplicateDiscoveryCandidates: mismo nombre+ciudad+estado es la ultima red de seguridad", () => {
  const a = candidate({ normalizedNameCityState: "acme manufacturing|chicago|il" });
  const b = candidate({ normalizedNameCityState: "acme manufacturing|chicago|il" });
  const { duplicates } = deduplicateDiscoveryCandidates([a, b]);
  assert.equal(duplicates[0]!.matchedOn, "normalizedNameCityState");
});

test("deduplicateDiscoveryCandidates: distingue misma empresa en industrias distintas — sigue siendo duplicado (no se crea 2 veces)", () => {
  // Simula el caso explicito del plan: "no considerar una Company nueva
  // si ya existe bajo otra industria" — el executor pasa el mismo
  // candidato aunque la query que lo encontro pertenezca a otra
  // categoria de taxonomia; la identidad (dominio) es la que manda.
  const a = candidate({ canonicalDomain: "acme.com" });
  const b = candidate({ canonicalDomain: "acme.com" });
  const { unique, duplicates } = deduplicateDiscoveryCandidates([a, b]);
  assert.equal(unique.length, 1);
  assert.equal(duplicates.length, 1);
});

test("deduplicateDiscoveryCandidates: duplicado contra Companies ya existentes en el CRM via existingKeys", () => {
  const a = candidate({ canonicalDomain: "already-in-crm.com" });
  const { unique, duplicates } = deduplicateDiscoveryCandidates([a], {
    canonicalDomain: new Set(["already-in-crm.com"]),
  });
  assert.equal(unique.length, 0);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]!.matchedOn, "canonicalDomain");
});

test("deduplicateDiscoveryCandidates: sin ninguna clave en comun, ambos son unicos", () => {
  const a = candidate({ canonicalDomain: "a.com", normalizedNameCityState: "a|chicago|il" });
  const b = candidate({ canonicalDomain: "b.com", normalizedNameCityState: "b|chicago|il" });
  const { unique, duplicates } = deduplicateDiscoveryCandidates([a, b]);
  assert.equal(unique.length, 2);
  assert.equal(duplicates.length, 0);
});

test("deduplicateDiscoveryCandidates: preserva el orden y se queda con la PRIMERA aparicion", () => {
  const a = candidate({ canonicalDomain: "acme.com", normalizedNameCityState: "acme|chicago|il" });
  const b = candidate({ canonicalDomain: "other.com", normalizedNameCityState: "other|chicago|il" });
  const c = candidate({ canonicalDomain: "acme.com", normalizedNameCityState: "acme dup|chicago|il" });
  const { unique, duplicates } = deduplicateDiscoveryCandidates([a, b, c]);
  assert.equal(unique.length, 2);
  assert.equal(unique[0], a);
  assert.equal(unique[1], b);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]!.candidate, c);
});
