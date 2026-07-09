import { PrismaClient, Prisma } from "@prisma/client";
import { ALL_PERMISSIONS } from "@ai-staffing-os/shared";

const prisma = new PrismaClient();

// ============================================================
// Helpers
// ============================================================

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}

function businessDaysBack(count: number): Date[] {
  const dates: Date[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  while (dates.length < count) {
    cursor.setDate(cursor.getDate() - 1);
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) dates.push(new Date(cursor));
  }
  return dates.reverse();
}

const decimal = (value: number) => new Prisma.Decimal(value);

// ============================================================
// 1. Tenant
// ============================================================

async function seedTenant() {
  return prisma.tenant.upsert({
    where: { id: "tenant-titan" },
    update: { name: "Titan Staffing Group", slug: "titan", plan: "PRO" },
    create: {
      id: "tenant-titan",
      name: "Titan Staffing Group",
      slug: "titan",
      plan: "PRO",
      settings: {
        branding: { accentColor: "#7C5CFF" },
        timezone: "America/Chicago",
        activeIndustries: ["Construction", "Warehouse/Logistics"],
      },
    },
  });
}

// ============================================================
// 2. Permissions (imported from packages/shared — single source of
// truth; F1 found a real bug where this catalog was duplicated here
// and drifted out of sync with the 12 new leads/opportunities/
// followUps keys added to packages/shared)
// ============================================================

async function seedPermissions() {
  const permissions = await Promise.all(
    ALL_PERMISSIONS.map((p) =>
      prisma.permission.upsert({
        where: { key: p.key },
        update: { label: p.label },
        create: { key: p.key, label: p.label },
      }),
    ),
  );
  return new Map(permissions.map((p) => [p.key, p.id]));
}

// ============================================================
// 3. Roles (11) + permission matrix
// ============================================================

const ALL_KEYS = ALL_PERMISSIONS.map((p) => p.key);

const ROLE_PERMISSIONS: Record<string, string[]> = {
  CEO: ALL_KEYS,
  Admin: ALL_KEYS.filter((k) => k !== "payroll.approve"),
  Recruiter: [
    "candidates.view",
    "candidates.create",
    "candidates.update",
    "candidates.delete",
    "workers.view",
    "workers.update",
    "contacts.view",
    "companies.view",
    "jobOrders.view",
    "documents.view",
    "documents.create",
    "agents.view",
  ],
  Compliance: [
    "candidates.view",
    "documents.view",
    "documents.create",
    "documents.update",
    "documents.delete",
    "compliance.verify",
    "compliance.block",
    "workers.view",
    "workers.update",
    "companies.view",
    "contacts.view",
    "jobOrders.view",
    "agents.view",
  ],
  Payroll: [
    "timeEntries.view",
    "timeEntries.create",
    "timeEntries.update",
    "timeEntries.delete",
    "payroll.approve",
    "workers.view",
    "jobOrders.view",
    "companies.view",
    "pricingScenarios.view",
    "agents.view",
  ],
  Sales: [
    "companies.view",
    "companies.create",
    "companies.update",
    "contacts.view",
    "contacts.create",
    "contacts.update",
    "jobOrders.view",
    "pricingScenarios.view",
    "agents.view",
  ],
  Operations: [
    "jobOrders.view",
    "jobOrders.create",
    "jobOrders.update",
    "workers.view",
    "workers.update",
    "companies.view",
    "contacts.view",
    "timeEntries.view",
    "agents.view",
  ],
  Marketing: ["companies.view", "contacts.view", "candidates.view", "agents.view"],
  HR: ["candidates.view", "workers.view", "documents.view", "documents.create", "documents.update", "agents.view"],
  Accounting: ["timeEntries.view", "pricingScenarios.view", "companies.view", "agents.view"],
  Manager: [
    "companies.view",
    "contacts.view",
    "candidates.view",
    "workers.view",
    "jobOrders.view",
    "documents.view",
    "timeEntries.view",
    "pricingScenarios.view",
    "agents.view",
  ],
};

async function seedRoles(tenantId: string, permissionIds: Map<string, string>) {
  const roleMap = new Map<string, string>();

  for (const [name, keys] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.upsert({
      where: { tenantId_name: { tenantId, name } },
      update: { isSystem: true },
      create: { tenantId, name, isSystem: true, description: `${name} role (seeded)` },
    });
    roleMap.set(name, role.id);

    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: keys.map((key) => ({
        roleId: role.id,
        permissionId: permissionIds.get(key)!,
      })),
      skipDuplicates: true,
    });
  }

  return roleMap;
}

// ============================================================
// 4. Users (11, one per role)
// ============================================================

const USERS: Array<{ role: string; firstName: string; lastName: string }> = [
  { role: "CEO", firstName: "Mariana", lastName: "Solórzano" },
  { role: "Admin", firstName: "Diego", lastName: "Fernández" },
  { role: "Recruiter", firstName: "Camila", lastName: "Torres" },
  { role: "Sales", firstName: "Andrés", lastName: "Beltrán" },
  { role: "Payroll", firstName: "Lucía", lastName: "Ramírez" },
  { role: "Compliance", firstName: "Javier", lastName: "Montoya" },
  { role: "Operations", firstName: "Valentina", lastName: "Rojas" },
  { role: "Marketing", firstName: "Sebastián", lastName: "Cárdenas" },
  { role: "HR", firstName: "Isabela", lastName: "Núñez" },
  { role: "Accounting", firstName: "Mateo", lastName: "Salazar" },
  { role: "Manager", firstName: "Renata", lastName: "Vásquez" },
];

async function seedUsers(tenantId: string, roleMap: Map<string, string>) {
  const userMap = new Map<string, string>();

  for (const u of USERS) {
    const email = `${u.role.toLowerCase()}@titan.dev`;
    const user = await prisma.user.upsert({
      where: { tenantId_email: { tenantId, email } },
      update: { firstName: u.firstName, lastName: u.lastName, roleId: roleMap.get(u.role)! },
      create: {
        tenantId,
        email,
        firstName: u.firstName,
        lastName: u.lastName,
        roleId: roleMap.get(u.role)!,
      },
    });
    userMap.set(u.role, user.id);
  }

  return userMap;
}

// ============================================================
// 5. Industries (4, global)
// ============================================================

const INDUSTRIES = [
  { id: "industry-construction", name: "Construction" },
  { id: "industry-warehouse-logistics", name: "Warehouse/Logistics" },
  { id: "industry-manufacturing", name: "Manufacturing" },
  { id: "industry-general-labor", name: "General Labor" },
];

async function seedIndustries() {
  const map = new Map<string, string>();
  for (const i of INDUSTRIES) {
    const industry = await prisma.industry.upsert({
      where: { id: i.id },
      update: { name: i.name, isGlobal: true, tenantId: null },
      create: { id: i.id, name: i.name, isGlobal: true, tenantId: null },
    });
    map.set(i.name, industry.id);
  }
  return map;
}

// ============================================================
// 6. Job categories (5, global)
// ============================================================

const JOB_CATEGORIES = [
  {
    id: "category-journeyman-electrician",
    name: "Journeyman Electrician",
    industry: "Construction",
    certs: ["electrical_license", "osha30"],
  },
  {
    id: "category-apprentice-electrician",
    name: "Apprentice Electrician",
    industry: "Construction",
    certs: ["osha10"],
  },
  {
    id: "category-general-labor",
    name: "General Labor",
    industry: "General Labor",
    certs: ["drug_test"],
  },
  {
    id: "category-warehouse-worker",
    name: "Warehouse Worker",
    industry: "Warehouse/Logistics",
    certs: ["drug_test", "background_check"],
  },
  {
    id: "category-forklift-operator",
    name: "Forklift Operator",
    industry: "Warehouse/Logistics",
    certs: ["forklift_cert", "drug_test"],
  },
];

async function seedJobCategories(industryMap: Map<string, string>) {
  const map = new Map<string, string>();
  for (const c of JOB_CATEGORIES) {
    const category = await prisma.jobCategory.upsert({
      where: { id: c.id },
      update: {
        name: c.name,
        industryId: industryMap.get(c.industry)!,
        requiredCertifications: c.certs,
        tenantId: null,
      },
      create: {
        id: c.id,
        name: c.name,
        industryId: industryMap.get(c.industry)!,
        requiredCertifications: c.certs,
        tenantId: null,
      },
    });
    map.set(c.name, category.id);
  }
  return map;
}

// ============================================================
// 7. Document types (8, global)
// ============================================================

const DOCUMENT_TYPES = [
  { id: "doctype-i9", key: "i9", name: "I-9", category: "identity", requiresExpiration: false },
  { id: "doctype-w4", key: "w4", name: "W-4", category: "tax", requiresExpiration: false },
  { id: "doctype-osha10", key: "osha10", name: "OSHA 10", category: "safety", requiresExpiration: false },
  { id: "doctype-osha30", key: "osha30", name: "OSHA 30", category: "safety", requiresExpiration: false },
  {
    id: "doctype-forklift-cert",
    key: "forklift_cert",
    name: "Forklift Certification",
    category: "certification",
    requiresExpiration: true,
  },
  { id: "doctype-drug-test", key: "drug_test", name: "Drug Test", category: "screening", requiresExpiration: true },
  {
    id: "doctype-background-check",
    key: "background_check",
    name: "Background Check",
    category: "screening",
    requiresExpiration: true,
  },
  {
    id: "doctype-electrical-license",
    key: "electrical_license",
    name: "Electrical License",
    category: "certification",
    requiresExpiration: true,
  },
];

async function seedDocumentTypes() {
  // Prisma rejects `null` inside a compound-unique WhereUniqueInput at
  // runtime even though tenantId is nullable, so global (tenantId=null)
  // rows are upserted by a fixed id instead of the tenantId_key index.
  const map = new Map<string, string>();
  for (const dt of DOCUMENT_TYPES) {
    const documentType = await prisma.documentType.upsert({
      where: { id: dt.id },
      update: {
        name: dt.name,
        category: dt.category,
        requiresExpiration: dt.requiresExpiration,
      },
      create: {
        id: dt.id,
        tenantId: null,
        key: dt.key,
        name: dt.name,
        category: dt.category,
        requiresExpiration: dt.requiresExpiration,
        appliesTo: {},
      },
    });
    map.set(dt.key, documentType.id);
  }
  return map;
}

// ============================================================
// 8. Companies (8) + Contacts
// ============================================================

const COMPANIES = [
  {
    id: "company-01",
    name: "Midwest Data Center Builders",
    industry: "Construction",
    status: "CLIENT",
    city: "Chicago",
    state: "IL",
    contacts: [{ firstName: "Robert", lastName: "Hayes", title: "Project Director" }],
  },
  {
    id: "company-02",
    name: "Lakeshore Electrical Contractors",
    industry: "Construction",
    status: "CLIENT",
    city: "Aurora",
    state: "IL",
    contacts: [
      { firstName: "Patricia", lastName: "Nguyen", title: "Operations Manager" },
      { firstName: "Tom", lastName: "Iverson", title: "Site Supervisor" },
    ],
  },
  {
    id: "company-03",
    name: "ChiTown Logistics",
    industry: "Warehouse/Logistics",
    status: "CLIENT",
    city: "Cicero",
    state: "IL",
    contacts: [{ firstName: "Angela", lastName: "Marsh", title: "Warehouse Manager" }],
  },
  {
    id: "company-04",
    name: "Hoosier Distribution Partners",
    industry: "Warehouse/Logistics",
    status: "CLIENT",
    city: "Gary",
    state: "IN",
    contacts: [
      { firstName: "Michael", lastName: "Brantley", title: "Distribution Center Manager" },
      { firstName: "Sara", lastName: "Whitfield", title: "HR Coordinator" },
    ],
  },
  {
    id: "company-05",
    name: "Prairie Manufacturing Co.",
    industry: "Manufacturing",
    status: "PROSPECT",
    city: "Elgin",
    state: "IL",
    contacts: [{ firstName: "Daniel", lastName: "Ochoa", title: "Plant Manager" }],
  },
  {
    id: "company-06",
    name: "Summit Warehouse Solutions",
    industry: "Warehouse/Logistics",
    status: "PROSPECT",
    city: "Hammond",
    state: "IN",
    contacts: [{ firstName: "Karen", lastName: "Delgado", title: "Procurement Lead" }],
  },
  {
    id: "company-07",
    name: "Union Build Group",
    industry: "Construction",
    status: "LEAD",
    city: "Joliet",
    state: "IL",
    contacts: [{ firstName: "Brian", lastName: "Kowalski", title: "Superintendent" }],
  },
  {
    id: "company-08",
    name: "Northern Steel Fabricators",
    industry: "Manufacturing",
    status: "LEAD",
    city: "Merrillville",
    state: "IN",
    contacts: [{ firstName: "Elena", lastName: "Ramos", title: "Facilities Manager" }],
  },
];

async function seedCompanies(industryMap: Map<string, string>) {
  const map = new Map<string, string>();
  for (const c of COMPANIES) {
    const company = await prisma.company.upsert({
      where: { id: c.id },
      update: {
        name: c.name,
        industryId: industryMap.get(c.industry)!,
        status: c.status as never,
        address: { city: c.city, state: c.state },
      },
      create: {
        id: c.id,
        tenantId: "tenant-titan",
        name: c.name,
        industryId: industryMap.get(c.industry)!,
        status: c.status as never,
        address: { city: c.city, state: c.state },
      },
    });
    map.set(c.id, company.id);

    for (const [i, contact] of c.contacts.entries()) {
      const contactId = `contact-${c.id}-${i + 1}`;
      await prisma.contact.upsert({
        where: { id: contactId },
        update: {
          firstName: contact.firstName,
          lastName: contact.lastName,
          title: contact.title,
        },
        create: {
          id: contactId,
          tenantId: "tenant-titan",
          companyId: company.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          title: contact.title,
          email: `${contact.firstName.toLowerCase()}.${contact.lastName.toLowerCase()}@${c.name
            .toLowerCase()
            .replace(/[^a-z]+/g, "")}.com`,
          isPrimary: i === 0,
        },
      });
    }
  }
  return map;
}

// ============================================================
// 9. Candidates (40)
// ============================================================

const CITIES: Array<{ city: string; state: string }> = [
  { city: "Chicago", state: "IL" },
  { city: "Palatine", state: "IL" },
  { city: "Cicero", state: "IL" },
  { city: "Aurora", state: "IL" },
  { city: "Elgin", state: "IL" },
  { city: "Gary", state: "IN" },
];

const FIRST_NAMES = [
  "José", "María", "Luis", "Ana", "Carlos", "Sofía", "Miguel", "Elena", "Juan", "Gabriela",
  "David", "Laura", "Antonio", "Patricia", "Francisco", "Carmen", "Manuel", "Rosa", "Pedro", "Alicia",
  "Marcus", "Ashley", "Brandon", "Jasmine", "Tyler", "Destiny", "Kevin", "Brittany", "Jordan", "Megan",
  "Ricardo", "Daniela", "Fernando", "Valeria", "Alejandro", "Paola", "Roberto", "Cristina", "Emilio", "Natalia",
];

const LAST_NAMES = [
  "García", "Martínez", "Rodríguez", "López", "Hernández", "González", "Pérez", "Sánchez", "Ramírez", "Torres",
  "Flores", "Rivera", "Gómez", "Díaz", "Cruz", "Morales", "Reyes", "Jiménez", "Ortiz", "Gutiérrez",
  "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Anderson", "Taylor", "Thomas",
  "Vega", "Castillo", "Aguilar", "Mendoza", "Vargas", "Romero", "Chávez", "Suárez", "Molina", "Delgado",
];

const CANDIDATE_CATEGORY_CYCLE = [
  "General Labor",
  "Warehouse Worker",
  "Forklift Operator",
  "Apprentice Electrician",
  "Journeyman Electrician",
];

interface CandidateSeed {
  id: string;
  firstName: string;
  lastName: string;
  city: string;
  state: string;
  category: string;
  bilingual: boolean;
  status: string;
  aiScore: number | null;
}

function buildCandidateSeeds(): CandidateSeed[] {
  const statuses = [
    ...Array(15).fill("NEW"),
    ...Array(10).fill("SCREENING"),
    ...Array(8).fill("QUALIFIED"),
    ...Array(7).fill("PLACED"),
  ];

  return statuses.map((status, i) => {
    const n = i + 1;
    const city = CITIES[i % CITIES.length]!;
    return {
      id: `candidate-${String(n).padStart(3, "0")}`,
      firstName: FIRST_NAMES[i % FIRST_NAMES.length]!,
      lastName: LAST_NAMES[i % LAST_NAMES.length]!,
      city: city.city,
      state: city.state,
      category: CANDIDATE_CATEGORY_CYCLE[i % CANDIDATE_CATEGORY_CYCLE.length]!,
      bilingual: i % 5 < 3, // exactly 3/5 = 60% (24/40), interleaved across all statuses
      status,
      aiScore: status === "NEW" ? null : Number((6.5 + ((i * 37) % 35) / 10).toFixed(1)),
    };
  });
}

async function seedCandidates(tenantId: string, categoryMap: Map<string, string>) {
  const seeds = buildCandidateSeeds();
  const map = new Map<string, { id: string; status: string }>();

  for (const [i, c] of seeds.entries()) {
    const languages = c.bilingual ? ["es", "en"] : ["en"];

    const candidate = await prisma.candidate.upsert({
      where: { id: c.id },
      update: {
        firstName: c.firstName,
        lastName: c.lastName,
        city: c.city,
        state: c.state,
        status: c.status as never,
        languages,
      },
      create: {
        id: c.id,
        tenantId,
        firstName: c.firstName,
        lastName: c.lastName,
        email: `${c.firstName.toLowerCase()}.${c.lastName.toLowerCase()}${i}@example.com`,
        phone: `312555${String(1000 + i).padStart(4, "0")}`,
        languages,
        city: c.city,
        state: c.state,
        zip: "60601",
        yearsExperience: 1 + (i % 12),
        status: c.status as never,
        source: i % 3 === 0 ? "referral" : i % 3 === 1 ? "indeed" : "web",
        smsOptIn: i % 2 === 0,
        aiScore: c.aiScore,
        aiSummary:
          c.status === "NEW"
            ? null
            : `Candidato con experiencia en ${c.category}. Evaluación preliminar generada por el Recruiter Agent (simulada en F0).`,
        categories: { connect: [{ id: categoryMap.get(c.category)! }] },
      },
    });
    map.set(c.id, { id: candidate.id, status: c.status });
  }

  return { seeds, candidateMap: map };
}

// ============================================================
// 10. Workers (10) — 7 from PLACED + 3 from QUALIFIED
// ============================================================

const CATEGORY_PAY_RANGE: Record<string, [number, number]> = {
  "General Labor": [17, 19],
  "Warehouse Worker": [18, 21],
  "Forklift Operator": [20, 24],
  "Apprentice Electrician": [22, 26],
  "Journeyman Electrician": [32, 38],
};

async function seedWorkers(
  tenantId: string,
  seeds: CandidateSeed[],
): Promise<Array<{ id: string; candidateId: string; category: string; complianceStatus: string }>> {
  const placed = seeds.filter((s) => s.status === "PLACED").slice(0, 7);
  const qualified = seeds.filter((s) => s.status === "QUALIFIED").slice(0, 3);
  const chosen = [...placed, ...qualified];

  const complianceStatuses = [...Array(7).fill("COMPLIANT"), ...Array(2).fill("PENDING"), "BLOCKED"];

  const workers: Array<{ id: string; candidateId: string; category: string; complianceStatus: string }> = [];

  for (const [i, c] of chosen.entries()) {
    const [min, max] = CATEGORY_PAY_RANGE[c.category]!;
    const payRate = min + ((max - min) * (i % 5)) / 4;
    const complianceStatus = complianceStatuses[i]!;

    const worker = await prisma.worker.upsert({
      where: { candidateId: c.id },
      update: { complianceStatus: complianceStatus as never, defaultPayRate: decimal(payRate) },
      create: {
        id: `worker-${String(i + 1).padStart(2, "0")}`,
        tenantId,
        candidateId: c.id,
        employmentType: "W2",
        defaultPayRate: decimal(Number(payRate.toFixed(2))),
        status: i < 8 ? "ASSIGNED" : "AVAILABLE",
        complianceStatus: complianceStatus as never,
        hiredAt: daysFromNow(-30 - i),
      },
    });

    workers.push({ id: worker.id, candidateId: c.id, category: c.category, complianceStatus });
  }

  return workers;
}

// ============================================================
// 11. Documents + Compliance Alerts
// ============================================================

async function seedDocuments(
  tenantId: string,
  workers: Array<{ id: string; candidateId: string; category: string; complianceStatus: string }>,
  documentTypeMap: Map<string, string>,
  categorySeedMap: Map<string, string[]>,
) {
  let docCounter = 0;
  let alertCounter = 0;
  let expiredUsed = 0;
  let expiringUsed = 0;

  for (const [wIdx, worker] of workers.entries()) {
    const requiredKeys = ["i9", "w4", ...categorySeedMap.get(worker.category)!];

    for (const key of requiredKeys) {
      docCounter += 1;
      const docId = `document-${String(docCounter).padStart(3, "0")}`;
      const docType = documentTypeMap.get(key)!;

      let status: string = "VERIFIED";
      let expirationDate: Date | null = null;
      const requiresExpiration = DOCUMENT_TYPES.find((d) => d.key === key)!.requiresExpiration;

      if (requiresExpiration) {
        // Assign EXPIRED/EXPIRING to the first documents encountered
        // (across all workers, in order) so the exact counts required by
        // the spec (2 EXPIRED, 3 EXPIRING) are always hit regardless of
        // which categories/workers happen to carry expiring cert types.
        if (expiredUsed < 2) {
          expirationDate = daysFromNow(-10 - expiredUsed * 5);
          status = "EXPIRED";
          expiredUsed += 1;
        } else if (expiringUsed < 3) {
          expirationDate = daysFromNow(5 + expiringUsed * 7);
          status = "VERIFIED";
          expiringUsed += 1;
        } else {
          expirationDate = daysFromNow(180 + wIdx * 10);
        }
      }

      if (worker.complianceStatus === "PENDING" && key === requiredKeys[requiredKeys.length - 1]) {
        status = "PENDING_REVIEW";
      }
      if (worker.complianceStatus === "BLOCKED" && key === requiredKeys[requiredKeys.length - 1]) {
        status = "REJECTED";
      }

      await prisma.document.upsert({
        where: { id: docId },
        update: { status: status as never, expirationDate },
        create: {
          id: docId,
          tenantId,
          documentTypeId: docType,
          workerId: worker.id,
          fileUrl: `https://files.titan.dev/simulated/${docId}.pdf`,
          issuedDate: daysFromNow(-365),
          expirationDate,
          status: status as never,
          verifiedByAgent: wIdx % 2 === 0,
        },
      });

      if (status === "EXPIRED" || (status === "VERIFIED" && expirationDate && expirationDate <= daysFromNow(30))) {
        alertCounter += 1;
        await prisma.complianceAlert.upsert({
          where: { id: `alert-${String(alertCounter).padStart(3, "0")}` },
          update: {},
          create: {
            id: `alert-${String(alertCounter).padStart(3, "0")}`,
            tenantId,
            workerId: worker.id,
            documentId: docId,
            type: status === "EXPIRED" ? "EXPIRED" : "EXPIRING",
            severity: status === "EXPIRED" ? "HIGH" : "MEDIUM",
            message: `${DOCUMENT_TYPES.find((d) => d.key === key)!.name} ${
              status === "EXPIRED" ? "venció" : "vence pronto"
            } para ${worker.id}.`,
          },
        });
      }
    }

    if (worker.complianceStatus === "BLOCKED") {
      alertCounter += 1;
      await prisma.complianceAlert.upsert({
        where: { id: `alert-${String(alertCounter).padStart(3, "0")}` },
        update: {},
        create: {
          id: `alert-${String(alertCounter).padStart(3, "0")}`,
          tenantId,
          workerId: worker.id,
          type: "FAILED_CHECK",
          severity: "CRITICAL",
          message: `Background check falló para ${worker.id}. Worker bloqueado hasta revisión manual.`,
        },
      });
    }
  }
}

const CATEGORY_SEED_CERTS = new Map(JOB_CATEGORIES.map((c) => [c.name, c.certs]));

// ============================================================
// 12. Job Orders (6)
// ============================================================

interface JobOrderSeed {
  id: string;
  companyId: string;
  category: string;
  title: string;
  status: string;
  workersNeeded: number;
  workersFilled: number;
  payRate: number;
  markup: number;
  shiftType: string;
  urgency: string;
}

const JOB_ORDERS: JobOrderSeed[] = [
  {
    id: "joborder-01",
    companyId: "company-03",
    category: "Forklift Operator",
    title: "Forklift Operators — Night Shift",
    status: "OPEN",
    workersNeeded: 12,
    workersFilled: 6,
    payRate: 21,
    markup: 0.55,
    shiftType: "NIGHT",
    urgency: "HIGH",
  },
  {
    id: "joborder-02",
    companyId: "company-04",
    category: "Warehouse Worker",
    title: "General Warehouse Associates",
    status: "OPEN",
    workersNeeded: 20,
    workersFilled: 5,
    payRate: 19,
    markup: 0.5,
    shiftType: "DAY",
    urgency: "MEDIUM",
  },
  {
    id: "joborder-03",
    companyId: "company-01",
    category: "Journeyman Electrician",
    title: "Journeyman Electricians — Data Center Buildout",
    status: "PARTIALLY_FILLED",
    workersNeeded: 8,
    workersFilled: 4,
    payRate: 36,
    markup: 0.45,
    shiftType: "DAY",
    urgency: "HIGH",
  },
  {
    id: "joborder-04",
    companyId: "company-02",
    category: "Apprentice Electrician",
    title: "Apprentice Electricians — Commercial Build",
    status: "PARTIALLY_FILLED",
    workersNeeded: 6,
    workersFilled: 3,
    payRate: 24,
    markup: 0.5,
    shiftType: "DAY",
    urgency: "MEDIUM",
  },
  {
    id: "joborder-05",
    companyId: "company-03",
    category: "General Labor",
    title: "General Labor — Seasonal Surge",
    status: "FILLED",
    workersNeeded: 4,
    workersFilled: 4,
    payRate: 18,
    markup: 0.6,
    shiftType: "WEEKEND",
    urgency: "MEDIUM",
  },
  {
    id: "joborder-06",
    companyId: "company-06",
    category: "Warehouse Worker",
    title: "Peak Season Warehouse Support",
    status: "CLOSED",
    workersNeeded: 10,
    workersFilled: 10,
    payRate: 19,
    markup: 0.5,
    shiftType: "ROTATING",
    urgency: "LOW",
  },
];

async function seedJobOrders(tenantId: string, categoryMap: Map<string, string>) {
  const map = new Map<string, { id: string; billRate: number; payRate: number; companyId: string; category: string }>();

  for (const jo of JOB_ORDERS) {
    const billRate = Number((jo.payRate * (1 + jo.markup)).toFixed(2));
    await prisma.jobOrder.upsert({
      where: { id: jo.id },
      update: { status: jo.status as never, workersFilled: jo.workersFilled },
      create: {
        id: jo.id,
        tenantId,
        companyId: jo.companyId,
        categoryId: categoryMap.get(jo.category)!,
        title: jo.title,
        workersNeeded: jo.workersNeeded,
        workersFilled: jo.workersFilled,
        billRate: decimal(billRate),
        payRate: decimal(jo.payRate),
        location: { city: "Chicago", state: "IL" },
        shiftType: jo.shiftType as never,
        status: jo.status as never,
        startDate: daysFromNow(-14),
        requirements: CATEGORY_SEED_CERTS.get(jo.category) ?? [],
        urgency: jo.urgency as never,
      },
    });
    map.set(jo.id, { id: jo.id, billRate, payRate: jo.payRate, companyId: jo.companyId, category: jo.category });
  }

  return map;
}

// ============================================================
// 13. Projects (2) + Assignments (8) + TimeEntries
// ============================================================

const PROJECTS = [
  { id: "project-01", companyId: "company-01", name: "Data Center Campus — Phase 2" },
  { id: "project-02", companyId: "company-03", name: "ChiTown DC Expansion" },
];

async function seedProjectsAndAssignments(
  tenantId: string,
  workers: Array<{ id: string; category: string }>,
  jobOrders: Map<string, { id: string; billRate: number; payRate: number; companyId: string; category: string }>,
) {
  for (const p of PROJECTS) {
    await prisma.project.upsert({
      where: { id: p.id },
      update: { name: p.name },
      create: {
        id: p.id,
        tenantId,
        companyId: p.companyId,
        name: p.name,
        location: { city: "Chicago", state: "IL" },
        status: "ACTIVE",
      },
    });
  }

  const assignableJobOrders = Array.from(jobOrders.values()).filter((jo) =>
    ["OPEN", "PARTIALLY_FILLED", "FILLED"].includes(
      JOB_ORDERS.find((seed) => seed.id === jo.id)!.status,
    ),
  );

  const assignments: Array<{ id: string; billRate: number; payRate: number }> = [];
  const businessDays = businessDaysBack(10);

  for (let i = 0; i < 8; i++) {
    const worker = workers[i % workers.length]!;
    const matchingJobOrder =
      assignableJobOrders.find((jo) => jo.category === worker.category) ?? assignableJobOrders[i % assignableJobOrders.length]!;
    const assignmentId = `assignment-${String(i + 1).padStart(2, "0")}`;
    const projectId = i % 2 === 0 ? "project-01" : "project-02";

    await prisma.assignment.upsert({
      where: { id: assignmentId },
      update: {},
      create: {
        id: assignmentId,
        tenantId,
        workerId: worker.id,
        jobOrderId: matchingJobOrder.id,
        projectId,
        payRate: decimal(matchingJobOrder.payRate),
        billRate: decimal(matchingJobOrder.billRate),
        startDate: daysFromNow(-14),
        status: "ACTIVE",
      },
    });
    assignments.push({ id: assignmentId, billRate: matchingJobOrder.billRate, payRate: matchingJobOrder.payRate });

    for (const [dayIdx, date] of businessDays.entries()) {
      const overtime = (i + dayIdx) % 4 === 0 ? 2 : 0;
      await prisma.timeEntry.upsert({
        where: { assignmentId_date: { assignmentId, date } },
        update: {},
        create: {
          tenantId,
          assignmentId,
          date,
          regularHours: decimal(8),
          overtimeHours: decimal(overtime),
          doubleHours: decimal(0),
          status: dayIdx < businessDays.length - 2 ? "APPROVED" : "PENDING",
          source: "MANUAL",
        },
      });
    }
  }

  return assignments;
}

// ============================================================
// 14. Labor burden config
// ============================================================

async function seedLaborBurden(tenantId: string, categoryMap: Map<string, string>) {
  const rows = [
    { id: "burden-il-default", state: "IL", jobCategoryId: null, workersCompRate: 4.5, sutaRate: 3.2 },
    { id: "burden-in-default", state: "IN", jobCategoryId: null, workersCompRate: 4.2, sutaRate: 2.9 },
    {
      id: "burden-il-general-labor-construction",
      state: "IL",
      jobCategoryId: categoryMap.get("General Labor")!,
      workersCompRate: 12.5,
      sutaRate: 3.2,
    },
  ];

  for (const r of rows) {
    await prisma.laborBurdenConfig.upsert({
      where: { id: r.id },
      update: { workersCompRate: decimal(r.workersCompRate) },
      create: {
        id: r.id,
        tenantId,
        state: r.state,
        jobCategoryId: r.jobCategoryId,
        workersCompRate: decimal(r.workersCompRate),
        ficaRate: decimal(7.65),
        futaRate: decimal(0.6),
        sutaRate: decimal(r.sutaRate),
        liabilityRate: decimal(1.1),
        otherCostsPerHour: decimal(0.75),
        effectiveDate: daysFromNow(-180),
      },
    });
  }
}

// ============================================================
// 15. Rate benchmarks (5 categories × 2 states)
// ============================================================

const BENCHMARK_BASE: Record<string, { p25: number; p50: number; p75: number; bill: number }> = {
  "General Labor": { p25: 16.5, p50: 18.5, p75: 21, bill: 29 },
  "Warehouse Worker": { p25: 17.5, p50: 19.5, p75: 22, bill: 30 },
  "Forklift Operator": { p25: 19, p50: 21.5, p75: 24.5, bill: 33 },
  "Apprentice Electrician": { p25: 21, p50: 24, p75: 27, bill: 37 },
  "Journeyman Electrician": { p25: 30, p50: 34, p75: 39, bill: 52 },
};

async function seedRateBenchmarks(tenantId: string, categoryMap: Map<string, string>) {
  let counter = 0;
  for (const category of JOB_CATEGORIES) {
    for (const state of ["IL", "IN"] as const) {
      counter += 1;
      const base = BENCHMARK_BASE[category.name]!;
      const stateFactor = state === "IN" ? 0.95 : 1;
      const id = `benchmark-${counter.toString().padStart(2, "0")}`;

      await prisma.rateBenchmark.upsert({
        where: { id },
        update: {},
        create: {
          id,
          tenantId,
          source: "MANUAL",
          jobCategoryId: categoryMap.get(category.name)!,
          state,
          payRateP25: decimal(Number((base.p25 * stateFactor).toFixed(2))),
          payRateP50: decimal(Number((base.p50 * stateFactor).toFixed(2))),
          payRateP75: decimal(Number((base.p75 * stateFactor).toFixed(2))),
          billRateP50: decimal(Number((base.bill * stateFactor).toFixed(2))),
          sampleSize: 25 + counter,
          capturedAt: daysFromNow(-20),
        },
      });
    }
  }
}

// ============================================================
// 16. Pricing scenarios (3, incl. canonical example)
// ============================================================

async function seedPricingScenarios(tenantId: string, jobOrders: Map<string, { id: string }>) {
  const scenarios = [
    {
      id: "scenario-01",
      jobOrderId: jobOrders.get("joborder-01")!.id,
      inputs: { volume: 50, urgency: "high", shift: "night", difficulty: "medium", duration: "3 months" },
      payMin: 18,
      payMax: 21,
      billMin: 26,
      billMax: 32,
      grossMargin: 9.5,
      netMargin: 6.5,
      hiringRisk: "MEDIUM",
      dataConfidence: "MEDIUM",
      rationale:
        "50 Forklift Operators en turno nocturno, Chicago. P50 interno + benchmark BLS ajustado +12% por turno nocturno " +
        "y +8% por urgencia alta. Escasez de candidatos detectada por el Recruiter Agent (62 disponibles / 18 faltantes) " +
        "sugiere posicionar cerca del extremo superior del rango. Margen neto estimado tras workers' comp (4.5%) y FICA.",
      status: "PRESENTED",
    },
    {
      id: "scenario-02",
      jobOrderId: jobOrders.get("joborder-03")!.id,
      inputs: { volume: 8, urgency: "high", shift: "day", difficulty: "high", duration: "6 months" },
      payMin: 32,
      payMax: 38,
      billMin: 46,
      billMax: 55,
      grossMargin: 15,
      netMargin: 11.2,
      hiringRisk: "LOW",
      dataConfidence: "HIGH",
      rationale:
        "Journeyman Electricians certificados para buildout de data center. Alta demanda pero pool de candidatos " +
        "internos sólido (múltiples colocaciones previas). Riesgo de contratación bajo dada la relación establecida con el cliente.",
      status: "ACCEPTED",
    },
    {
      id: "scenario-03",
      jobOrderId: jobOrders.get("joborder-02")!.id,
      inputs: { volume: 20, urgency: "medium", shift: "day", difficulty: "low", duration: "ongoing" },
      payMin: 18,
      payMax: 20,
      billMin: 27,
      billMax: 30,
      grossMargin: 9,
      netMargin: 6.1,
      hiringRisk: "MEDIUM",
      dataConfidence: "MEDIUM",
      rationale:
        "Warehouse Associates turno diurno, cliente recurrente. Rango basado en benchmark interno de colocaciones " +
        "previas en la misma categoría y área metro.",
      status: "DRAFT",
    },
  ];

  for (const s of scenarios) {
    await prisma.pricingScenario.upsert({
      where: { id: s.id },
      update: {},
      create: {
        id: s.id,
        tenantId,
        jobOrderId: s.jobOrderId,
        inputs: s.inputs,
        recommendedPayMin: decimal(s.payMin),
        recommendedPayMax: decimal(s.payMax),
        recommendedBillMin: decimal(s.billMin),
        recommendedBillMax: decimal(s.billMax),
        grossMarginPerHour: decimal(s.grossMargin),
        netMarginPerHour: decimal(s.netMargin),
        hiringRisk: s.hiringRisk as never,
        dataConfidence: s.dataConfidence as never,
        rationale: s.rationale,
        status: s.status as never,
      },
    });
  }
}

// ============================================================
// 17. Agent definitions (10) + instances (3)
// ============================================================

const AGENT_DEFINITIONS = [
  { key: "recruiter", name: "Recruiter Agent", description: "Screens candidates, scores CVs, and builds shortlists." },
  { key: "compliance", name: "Compliance Agent", description: "Extracts document data and tracks expiration alerts." },
  { key: "assistant", name: "Assistant Agent", description: "Answers questions about company data across modules." },
  { key: "pricing", name: "Pricing Intelligence Agent", description: "Recommends pay/bill rates from benchmarks and burden costs." },
  { key: "sales", name: "Sales Agent", description: "Enriches leads and drafts outreach for the sales pipeline." },
  { key: "operations", name: "Operations Agent", description: "Proposes assignments and schedules for open job orders." },
  { key: "payroll", name: "Payroll Agent", description: "Validates time entries and drafts payroll runs." },
  { key: "marketing", name: "Marketing Agent", description: "Proposes job ad campaigns for talent gaps." },
  { key: "ceo", name: "CEO Agent", description: "Summarizes fill rate, margin, and risk across the tenant." },
  { key: "admin", name: "Admin Agent", description: "Assists with tenant configuration and user management." },
];

async function seedAgents(tenantId: string) {
  const definitionMap = new Map<string, string>();

  for (const def of AGENT_DEFINITIONS) {
    const definition = await prisma.agentDefinition.upsert({
      where: { key: def.key },
      update: { name: def.name, description: def.description },
      create: { key: def.key, name: def.name, description: def.description, systemPromptTemplate: "" },
    });
    definitionMap.set(def.key, definition.id);
  }

  for (const key of ["recruiter", "compliance", "assistant"]) {
    const definitionId = definitionMap.get(key)!;
    await prisma.agentInstance.upsert({
      where: { tenantId_definitionId: { tenantId, definitionId } },
      update: {},
      create: {
        tenantId,
        definitionId,
        autonomyLevel: "ASSISTED",
        isActive: true,
        metrics: { tasksCompleted: 0 },
      },
    });
  }

  return definitionMap;
}

// ============================================================
// 18. Audit log (20) + Notifications (5)
// ============================================================

async function seedAuditLogAndNotifications(
  tenantId: string,
  adminUserId: string,
  agentInstanceId: string | null,
) {
  const actions = [
    "candidate.created",
    "candidate.status_changed",
    "document.verified",
    "document.rejected",
    "complianceAlert.created",
    "jobOrder.created",
    "jobOrder.status_changed",
    "assignment.created",
    "timeEntry.approved",
    "company.created",
    "worker.blocked",
    "pricingScenario.presented",
  ];

  for (let i = 0; i < 20; i++) {
    const isAgent = i % 3 === 0 && agentInstanceId;
    await prisma.auditLog.upsert({
      where: { id: `audit-${String(i + 1).padStart(3, "0")}` },
      update: {},
      create: {
        id: `audit-${String(i + 1).padStart(3, "0")}`,
        tenantId,
        actorType: isAgent ? "AGENT" : "HUMAN",
        actorId: isAgent ? agentInstanceId! : adminUserId,
        action: actions[i % actions.length]!,
        entityType: actions[i % actions.length]!.split(".")[0]!,
        entityId: `seed-entity-${i + 1}`,
        createdAt: daysFromNow(-(20 - i)),
      },
    });
  }

  const notifications = [
    { type: "ALERT", title: "2 documentos vencidos", body: "Revisa la sección de Compliance." },
    { type: "APPROVAL", title: "Nueva solicitud de aprobación", body: "Un agente propuso una acción." },
    { type: "AGENT_ACTIVITY", title: "Recruiter Agent completó un análisis", body: "40 candidatos evaluados." },
    { type: "INFO", title: "Job order actualizada", body: "Forklift Operators — Night Shift cambió de estado." },
    { type: "ALERT", title: "3 documentos por vencer", body: "Vencen en los próximos 30 días." },
  ];

  for (const [i, n] of notifications.entries()) {
    await prisma.notification.upsert({
      where: { id: `notif-${String(i + 1).padStart(3, "0")}` },
      update: {},
      create: {
        id: `notif-${String(i + 1).padStart(3, "0")}`,
        tenantId,
        userId: adminUserId,
        type: n.type as never,
        title: n.title,
        body: n.body,
        readAt: i < 2 ? daysFromNow(-1) : null,
      },
    });
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log("Seeding AI Staffing OS (F0)...");

  const tenant = await seedTenant();
  const permissionIds = await seedPermissions();
  const roleMap = await seedRoles(tenant.id, permissionIds);
  const userMap = await seedUsers(tenant.id, roleMap);
  const industryMap = await seedIndustries();
  const categoryMap = await seedJobCategories(industryMap);
  const documentTypeMap = await seedDocumentTypes();
  await seedCompanies(industryMap);

  const { seeds } = await seedCandidates(tenant.id, categoryMap);
  const workers = await seedWorkers(tenant.id, seeds);
  await seedDocuments(tenant.id, workers, documentTypeMap, CATEGORY_SEED_CERTS);

  const jobOrders = await seedJobOrders(tenant.id, categoryMap);
  await seedProjectsAndAssignments(tenant.id, workers, jobOrders);

  await seedLaborBurden(tenant.id, categoryMap);
  await seedRateBenchmarks(tenant.id, categoryMap);
  await seedPricingScenarios(tenant.id, jobOrders);

  const definitionMap = await seedAgents(tenant.id);
  const recruiterInstance = await prisma.agentInstance.findUnique({
    where: { tenantId_definitionId: { tenantId: tenant.id, definitionId: definitionMap.get("recruiter")! } },
  });

  await seedAuditLogAndNotifications(tenant.id, userMap.get("Admin")!, recruiterInstance?.id ?? null);

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
