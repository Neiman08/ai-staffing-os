import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCandidateEmail,
  normalizeCandidatePhone,
  buildCandidateIdentityKeys,
  deduplicateCandidates,
  type CandidateIdentityLike,
} from "./candidate-identity";

test("normalizeCandidateEmail trims and lowercases", () => {
  assert.equal(normalizeCandidateEmail("  Foo.Bar@Example.com  "), "foo.bar@example.com");
});

test("normalizeCandidatePhone strips spaces/dashes/parens", () => {
  assert.equal(normalizeCandidatePhone("(555) 123-4567"), "5551234567");
});

test("normalizeCandidatePhone strips US/CA country code when 11 digits starting with 1", () => {
  assert.equal(normalizeCandidatePhone("1-555-123-4567"), "5551234567");
});

test("normalizeCandidatePhone leaves an 11-digit number not starting with 1 untouched", () => {
  assert.equal(normalizeCandidatePhone("25551234567"), "25551234567");
});

test("buildCandidateIdentityKeys: normalizedEmail/normalizedPhone are null when absent", () => {
  const keys = buildCandidateIdentityKeys({ firstName: "Ana", lastName: "Diaz" });
  assert.equal(keys.normalizedEmail, null);
  assert.equal(keys.normalizedPhone, null);
});

test("buildCandidateIdentityKeys: normalizedNameState combines firstName+lastName+state, case/space insensitive", () => {
  const a = buildCandidateIdentityKeys({ firstName: "  Ana  ", lastName: "Diaz", state: "IL" });
  const b = buildCandidateIdentityKeys({ firstName: "ana", lastName: "diaz", state: "il" });
  assert.equal(a.normalizedNameState, b.normalizedNameState);
  assert.equal(a.normalizedNameState, "ana|diaz|il");
});

test("buildCandidateIdentityKeys: normalizedNameState is null when state is missing (no false positives on common names)", () => {
  const keys = buildCandidateIdentityKeys({ firstName: "John", lastName: "Smith" });
  assert.equal(keys.normalizedNameState, null);
});

test("buildCandidateIdentityKeys: normalizedEmail/normalizedPhone reflect the exact same normalization as the standalone functions", () => {
  const keys = buildCandidateIdentityKeys({
    firstName: "Ana",
    lastName: "Diaz",
    email: "  Ana@Example.com ",
    phone: "1 (555) 123-4567",
  });
  assert.equal(keys.normalizedEmail, normalizeCandidateEmail("  Ana@Example.com "));
  assert.equal(keys.normalizedPhone, normalizeCandidatePhone("1 (555) 123-4567"));
});

interface Fixture extends CandidateIdentityLike {
  label: string;
}

function fixture(label: string, input: Parameters<typeof buildCandidateIdentityKeys>[0]): Fixture {
  return { label, identity: buildCandidateIdentityKeys(input) };
}

test("deduplicateCandidates: matches on normalizedEmail first, in fixed order", () => {
  const first = fixture("first", { firstName: "A", lastName: "B", email: "same@x.com" });
  const second = fixture("second", { firstName: "C", lastName: "D", email: "SAME@X.com" });
  const result = deduplicateCandidates([first, second]);
  assert.equal(result.unique.length, 1);
  assert.equal(result.unique[0]!.label, "first");
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0]!.candidate.label, "second");
  assert.equal(result.duplicates[0]!.matchedOn, "normalizedEmail");
});

test("deduplicateCandidates: matches on normalizedPhone when no email match", () => {
  const first = fixture("first", { firstName: "A", lastName: "B", phone: "555-123-4567" });
  const second = fixture("second", { firstName: "C", lastName: "D", phone: "(555) 123-4567" });
  const result = deduplicateCandidates([first, second]);
  assert.equal(result.unique.length, 1);
  assert.equal(result.duplicates[0]!.matchedOn, "normalizedPhone");
});

test("deduplicateCandidates: falls back to normalizedNameState when no email/phone in common", () => {
  const first = fixture("first", { firstName: "Ana", lastName: "Diaz", state: "IL" });
  const second = fixture("second", { firstName: "ana", lastName: "diaz", state: "il" });
  const result = deduplicateCandidates([first, second]);
  assert.equal(result.unique.length, 1);
  assert.equal(result.duplicates[0]!.matchedOn, "normalizedNameState");
});

test("deduplicateCandidates: two candidates with the same common name but no state never match (avoids false positives)", () => {
  const first = fixture("first", { firstName: "John", lastName: "Smith" });
  const second = fixture("second", { firstName: "John", lastName: "Smith" });
  const result = deduplicateCandidates([first, second]);
  assert.equal(result.unique.length, 2);
  assert.equal(result.duplicates.length, 0);
});

test("deduplicateCandidates: distinct candidates on all keys are all unique", () => {
  const first = fixture("first", { firstName: "Ana", lastName: "Diaz", email: "ana@x.com" });
  const second = fixture("second", { firstName: "Bob", lastName: "Lee", email: "bob@x.com" });
  const result = deduplicateCandidates([first, second]);
  assert.equal(result.unique.length, 2);
  assert.equal(result.duplicates.length, 0);
});

test("deduplicateCandidates: respects existingKeys to catch duplicates against records already in DB", () => {
  const incoming = fixture("incoming", { firstName: "Ana", lastName: "Diaz", email: "ana@x.com" });
  const result = deduplicateCandidates([incoming], { normalizedEmail: new Set(["ana@x.com"]) });
  assert.equal(result.unique.length, 0);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0]!.matchedOn, "normalizedEmail");
});

test("deduplicateCandidates: email match takes priority over phone/name-state even if those also match", () => {
  const first = fixture("first", { firstName: "Ana", lastName: "Diaz", email: "ana@x.com", phone: "555-123-4567", state: "IL" });
  const second = fixture("second", { firstName: "ana", lastName: "diaz", email: "ana@x.com", phone: "999-999-9999", state: "IL" });
  const result = deduplicateCandidates([first, second]);
  assert.equal(result.duplicates[0]!.matchedOn, "normalizedEmail");
});
