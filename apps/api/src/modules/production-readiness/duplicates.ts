import { scopedDb } from "../../core/tenancy/prisma-extension";

export interface DuplicateGroup {
  matchType: "name+state" | "website" | "email" | "linkedin" | "name+company";
  key: string; // valor normalizado que causó el match — nunca inventado, literal del dato real
  ids: string[];
  count: number;
}

export interface DuplicatesReport {
  generatedAt: string;
  companies: { byNameState: DuplicateGroup[]; byWebsite: DuplicateGroup[] };
  contacts: { byEmail: DuplicateGroup[]; byLinkedin: DuplicateGroup[]; byNameCompany: DuplicateGroup[] };
  summary: { totalDuplicateGroups: number; totalAffectedRecords: number };
}

function normalizeText(v: string): string {
  return v.trim().toLowerCase();
}

/** Quita protocolo/www/slash final — para que "https://acme.com/" y "acme.com" cuenten como el mismo sitio. */
function normalizeWebsite(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

function groupBy<T>(items: T[], keyFn: (item: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
  }
  return map;
}

function toGroups<T extends { id: string }>(
  grouped: Map<string, T[]>,
  matchType: DuplicateGroup["matchType"],
): DuplicateGroup[] {
  return [...grouped.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({ matchType, key, ids: items.map((i) => i.id), count: items.length }));
}

/**
 * F4.7.5 §4: escaneo real de duplicados en TODA la base — de solo
 * lectura, nunca fusiona ni borra nada (eso es merge-plan.ts, §5,
 * tampoco ejecuta). Cubre exactamente lo pedido: empresas duplicadas,
 * contactos duplicados, emails duplicados, LinkedIn duplicados, websites
 * duplicados — cada uno como su propio grupo, para poder revisar antes
 * de decidir qué fusionar.
 */
export async function generateDuplicatesReport(): Promise<DuplicatesReport> {
  const companies = await scopedDb.company.findMany({ select: { id: true, name: true, state: true, website: true } });
  const contacts = await scopedDb.contact.findMany({
    select: { id: true, firstName: true, lastName: true, email: true, linkedinUrl: true, companyId: true },
  });

  const byNameState = toGroups(
    groupBy(companies, (c) => (c.state ? `${normalizeText(c.name)}|${normalizeText(c.state)}` : null)),
    "name+state",
  );
  const byWebsite = toGroups(
    groupBy(companies, (c) => (c.website ? normalizeWebsite(c.website) : null)),
    "website",
  );

  const byEmail = toGroups(
    groupBy(contacts, (c) => (c.email ? normalizeText(c.email) : null)),
    "email",
  );
  const byLinkedin = toGroups(
    groupBy(contacts, (c) => (c.linkedinUrl ? normalizeWebsite(c.linkedinUrl) : null)),
    "linkedin",
  );
  const byNameCompany = toGroups(
    groupBy(contacts, (c) => `${normalizeText(c.firstName)} ${normalizeText(c.lastName)}|${c.companyId}`),
    "name+company",
  );

  const allGroups = [byNameState, byWebsite, byEmail, byLinkedin, byNameCompany];
  const totalDuplicateGroups = allGroups.reduce((sum, g) => sum + g.length, 0);
  const totalAffectedRecords = allGroups.reduce((sum, g) => sum + g.reduce((s, grp) => s + grp.count, 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    companies: { byNameState, byWebsite },
    contacts: { byEmail, byLinkedin, byNameCompany },
    summary: { totalDuplicateGroups, totalAffectedRecords },
  };
}
