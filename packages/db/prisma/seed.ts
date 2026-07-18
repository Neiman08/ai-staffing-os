import { PrismaClient, Prisma } from "@prisma/client";
import { ALL_PERMISSIONS } from "@ai-staffing-os/shared";
import {
  campaignAgent,
  ceoAgent,
  conversationAgent,
  marketIntelligenceAgent,
  outreachAgent,
  salesAgent,
} from "@ai-staffing-os/agents";

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
    update: {
      name: "Titan Staffing Group",
      slug: "titan",
      plan: "PRO",
      settings: {
        branding: { accentColor: "#7C5CFF" },
        timezone: "America/Chicago",
        activeIndustries: ["Construction", "Warehouse/Logistics"],
        aiMonthlyBudgetUsd: 50, // F2 §16: presupuesto aprobado, configurable en Settings
        prospectingSweepIntervalHours: 6, // F3 §6: cadencia aprobada, configurable en Settings
      },
    },
    create: {
      id: "tenant-titan",
      name: "Titan Staffing Group",
      slug: "titan",
      plan: "PRO",
      settings: {
        branding: { accentColor: "#7C5CFF" },
        timezone: "America/Chicago",
        activeIndustries: ["Construction", "Warehouse/Logistics"],
        aiMonthlyBudgetUsd: 50, // F2 §16: presupuesto aprobado, configurable en Settings
        prospectingSweepIntervalHours: 6, // F3 §6: cadencia aprobada, configurable en Settings
      },
    },
  });
}

// F10.1: segundo tenant, alcance mínimo -- exclusivamente para que
// F10.11 pueda probar fuga real entre tenants vía HTTP (dev-bypass con
// x-dev-user de tenant-acme nunca debe ver datos de tenant-titan, ni al
// revés). Nunca se le agregan Candidates/Workers/JobOrders completos --
// alcance mínimo suficiente para el test de aislamiento (ver
// docs/F10_PLAN.md §1.2/§2), evita inflar el seed innecesariamente.
async function seedSecondTenant() {
  return prisma.tenant.upsert({
    where: { id: "tenant-acme" },
    update: { name: "Acme Staffing Client Co", slug: "acme" },
    create: {
      id: "tenant-acme",
      name: "Acme Staffing Client Co",
      slug: "acme",
      plan: "STARTER",
      settings: { timezone: "America/Chicago" },
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

// F10.1: todo rol autenticado (interno o de portal) tiene su propia
// bandeja de notificaciones -- se agrega al final de cada array de rol
// en vez de duplicarlo en los 15 roles.
const NOTIFICATION_KEYS = ["notifications.view", "notifications.markRead"];

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
    "assignments.view", // F5.4: visibilidad de las colocaciones de sus candidatos
    "contacts.view",
    "companies.view",
    "jobOrders.view",
    "documents.view",
    "documents.create",
    "agents.view",
    "matching.view", // F6.1
    "matching.run", // F6.1
    ...NOTIFICATION_KEYS,
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
    "assignments.view", // F5.4: necesita ver a quién está asignado un worker para evaluar compliance
    "companies.view",
    "contacts.view",
    "jobOrders.view",
    "agents.view",
    "matching.view", // F6.1: solo vista — nunca matching.run
    "incidents.view", // F9.10
    "incidents.create", // F9.10: SAFETY/COMPLIANCE_ISSUE son tipos frecuentes desde este rol
    "incidents.update", // F9.10
    ...NOTIFICATION_KEYS,
  ],
  Payroll: [
    "timeEntries.view",
    "timeEntries.create",
    "timeEntries.update",
    "timeEntries.delete",
    "payroll.approve",
    "payrollRuns.view", // F5.7
    "payrollRuns.create", // F5.7
    "payrollRuns.update", // F5.7
    "workers.view",
    "assignments.view", // F5.4: payRate/billRate snapshot de la Assignment alimenta el cálculo de nómina
    "jobOrders.view",
    "companies.view",
    "pricingScenarios.view",
    "agents.view",
    "shifts.view", // F9.6: necesita ver el Shift programado para evaluar discrepancyFlag
    ...NOTIFICATION_KEYS,
  ],
  Sales: [
    "companies.view",
    "companies.create",
    "companies.update",
    "contacts.view",
    "contacts.create",
    "contacts.update",
    "contacts.delete",
    "leads.view",
    "leads.create",
    "leads.update",
    "leads.delete",
    "opportunities.view",
    "opportunities.create",
    "opportunities.update",
    "opportunities.delete",
    "followUps.view",
    "followUps.create",
    "followUps.update",
    "followUps.delete",
    "jobOrders.view",
    "pricingScenarios.view",
    "agents.view",
    "agents.execute", // F2: Sales invoca al Sales Agent
    "approvals.decide", // F2: Sales decide sobre sus propios borradores de outreach
    "campaigns.view", // F4
    "campaigns.create", // F4
    "campaigns.update", // F4
    "campaigns.delete", // F4
    "missions.view", // F4
    "missions.create", // F4
    "missions.update", // F4 — pausar/cancelar/cerrar; missions.delete no se asigna a ningún rol (ver plan §addendum)
    "clientJobs.view", // F10.3: Sales también participa de la revisión de solicitudes de cliente
    "clientJobs.approve", // F10.3
    ...NOTIFICATION_KEYS,
  ],
  Operations: [
    "jobOrders.view",
    "jobOrders.create",
    "jobOrders.update",
    "workers.view",
    "workers.update",
    "assignments.view", // F5.4: Operations ejecuta el ciclo completo de asignación
    "assignments.create",
    "assignments.update",
    "companies.view",
    "contacts.view",
    "timeEntries.view",
    "agents.view",
    "matching.view", // F6.1: solo vista — nunca matching.run
    "shifts.view", // F9.6
    "shifts.create", // F9.6: Operations programa turnos
    "shifts.update", // F9.6
    "incidents.view", // F9.10
    "incidents.create", // F9.10: Operations reporta la mayoría de incidentes operativos
    "incidents.update", // F9.10
    "clientJobs.view", // F10.3: Operations convierte solicitudes aprobadas en JobOrder real
    "clientJobs.approve", // F10.3
    ...NOTIFICATION_KEYS,
  ],
  Marketing: [
    "companies.view",
    "contacts.view",
    "candidates.view",
    "leads.view",
    "opportunities.view",
    "agents.view",
    ...NOTIFICATION_KEYS,
  ],
  HR: [
    "candidates.view",
    "workers.view",
    "documents.view",
    "documents.create",
    "documents.update",
    "agents.view",
    "incidents.view", // F9.10
    "incidents.create", // F9.10: WORKER_COMPLAINT/ATTENDANCE son tipos frecuentes desde este rol
    ...NOTIFICATION_KEYS,
  ],
  Accounting: [
    "timeEntries.view",
    "payrollRuns.view",
    "pricingScenarios.view",
    "companies.view",
    "agents.view",
    "invoices.view", // F5.8
    "invoices.create", // F5.8
    "invoices.update", // F5.8
    "invoices.send", // F5.8
    ...NOTIFICATION_KEYS,
  ],
  Manager: [
    "companies.view",
    "contacts.view",
    "candidates.view",
    "workers.view",
    "jobOrders.view",
    "assignments.view", // F5.4
    "documents.view",
    "timeEntries.view",
    "pricingScenarios.view",
    "leads.view",
    "opportunities.view",
    "followUps.view",
    "agents.view",
    "invoices.view", // F5.8
    "matching.view", // F6.1: solo vista — nunca matching.run
    "shifts.view", // F9.6
    "incidents.view", // F9.10
    "auditLogs.view", // F10.9: visibilidad amplia ya establecida en Manager para el resto de los dominios
    ...NOTIFICATION_KEYS,
  ],
  // ================= F10.1: Roles de portal =================
  // CLIENT_ADMIN/CLIENT_MANAGER/WORKER/CANDIDATE nunca reciben ningún
  // permiso *interno* de CRUD amplio (assignments.view, timeEntries.view,
  // documents.view, etc.) -- esos gatean endpoints internos SIN filtro de
  // ownership (devuelven todo el tenant). En su lugar usan los recursos
  // `portal*` dedicados (F10.1 §2 / docs/F10_PLAN.md), cuyo service layer
  // siempre aplica el filtro de ownership real (ctx.companyId/workerId/
  // candidateId), nunca confía en el query param.
  CLIENT_ADMIN: [
    "portalProfile.view",
    "portalProfile.update",
    "clientJobs.view",
    "clientJobs.create",
    "clientJobs.update", // editar/cancelar sus propias solicitudes (nunca clientJobs.approve -- eso es revisión interna)
    "portalAssignments.view",
    "portalTimeEntries.view",
    "portalTimeEntries.update", // aprobar/rechazar horas de su propia Company
    "portalIncidents.view",
    "auditLogs.view", // acotado a su Company en el service, nunca tenant-wide
    ...NOTIFICATION_KEYS,
  ],
  CLIENT_MANAGER: [
    "portalProfile.view",
    "portalProfile.update",
    "clientJobs.view",
    "clientJobs.create", // puede enviar solicitudes, pero no editar/cancelar las de otros (sin clientJobs.update)
    "portalAssignments.view",
    "portalTimeEntries.view", // solo lectura -- sin aprobar horas (menos permisos que CLIENT_ADMIN, pedido explícito)
    "portalIncidents.view",
    ...NOTIFICATION_KEYS,
  ],
  WORKER: [
    "portalProfile.view",
    "portalProfile.update",
    "portalDocuments.view",
    "portalDocuments.update", // F10.5: enviar (SUBMITTED) un item del checklist propio
    "portalAssignments.view",
    "portalAssignments.create", // F10.6: crear una ScheduleChangeRequest -- nunca muta el Assignment en sí
    "portalTimeEntries.view",
    "portalTimeEntries.create",
    "portalTimeEntries.update", // solo mientras DRAFT -- validado en el service, no en RBAC
    "portalIncidents.view",
    "auditLogs.view", // acotado a su propio historial
    ...NOTIFICATION_KEYS,
  ],
  CANDIDATE: [
    "portalProfile.view",
    "portalProfile.update",
    "portalDocuments.view",
    "portalDocuments.update", // F10.5: enviar (SUBMITTED) un item del checklist propio
    "auditLogs.view", // acotado a su propio historial
    ...NOTIFICATION_KEYS,
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

// F10.1: usuarios de portal reales para tenant-titan -- deterministas
// (`x-dev-user` header) para que dev-bypass, e2e y verificación manual
// puedan simular cada persona de portal sin credenciales de Clerk. Se
// enlazan a fixtures YA existentes del seed (company-01, worker-01,
// candidate-029) en vez de inventar registros nuevos -- reutiliza antes
// de duplicar (docs/F10_PLAN.md §2). Se llama DESPUÉS de que Companies/
// Workers/Candidates ya existen (ver orden en main()).
const PORTAL_USERS: Array<{
  role: string;
  email: string;
  firstName: string;
  lastName: string;
  companyId?: string;
  workerId?: string;
  candidateId?: string;
}> = [
  { role: "CLIENT_ADMIN", email: "client-admin@titan.dev", firstName: "Patricia", lastName: "Alvarado", companyId: "company-01" },
  { role: "CLIENT_MANAGER", email: "client-manager@titan.dev", firstName: "Ramón", lastName: "Escobar", companyId: "company-01" },
  { role: "WORKER", email: "worker-portal@titan.dev", firstName: "Marcus", lastName: "Reyes", workerId: "worker-01" },
  { role: "CANDIDATE", email: "candidate-portal@titan.dev", firstName: "Daniela", lastName: "Ortiz", candidateId: "candidate-029" },
];

async function seedPortalUsers(tenantId: string, roleMap: Map<string, string>) {
  for (const u of PORTAL_USERS) {
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId, email: u.email } },
      update: {
        firstName: u.firstName,
        lastName: u.lastName,
        roleId: roleMap.get(u.role)!,
        companyId: u.companyId ?? null,
        workerId: u.workerId ?? null,
        candidateId: u.candidateId ?? null,
      },
      create: {
        tenantId,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        roleId: roleMap.get(u.role)!,
        companyId: u.companyId,
        workerId: u.workerId,
        candidateId: u.candidateId,
      },
    });
  }
}

// F10.1: Company + CLIENT_ADMIN mínimos para tenant-acme -- exclusivo
// para el test de fuga real entre tenants de F10.11, ver
// seedSecondTenant() más arriba.
async function seedAcmeCompanyAndClientAdmin(tenantId: string, roleMap: Map<string, string>, industryMap: Map<string, string>) {
  const company = await prisma.company.upsert({
    where: { id: "company-acme-01" },
    update: { name: "Acme Manufacturing (tenant-acme)" },
    create: {
      id: "company-acme-01",
      tenantId,
      name: "Acme Manufacturing (tenant-acme)",
      industryId: industryMap.get("Manufacturing")!,
      status: "CLIENT",
      city: "Milwaukee",
      state: "WI",
      origin: "DEMO_SEED",
    },
  });

  await prisma.user.upsert({
    where: { tenantId_email: { tenantId, email: "client-admin@acme.dev" } },
    update: { roleId: roleMap.get("CLIENT_ADMIN")!, companyId: company.id },
    create: {
      tenantId,
      email: "client-admin@acme.dev",
      firstName: "Nicolás",
      lastName: "Ferreira",
      roleId: roleMap.get("CLIENT_ADMIN")!,
      companyId: company.id,
    },
  });
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
    estimatedSize: "LARGE",
    commercialScore: 85,
    possibleCategories: ["Journeyman Electrician", "Apprentice Electrician"],
    contacts: [
      { firstName: "Robert", lastName: "Hayes", title: "Project Director", decisionRole: "PROJECT_MANAGER", linkedinUrl: "https://linkedin.com/in/robert-hayes-mdcb" },
    ],
  },
  {
    id: "company-02",
    name: "Lakeshore Electrical Contractors",
    industry: "Construction",
    status: "CLIENT",
    city: "Aurora",
    state: "IL",
    estimatedSize: "MEDIUM",
    commercialScore: 78,
    possibleCategories: ["Journeyman Electrician", "Apprentice Electrician"],
    contacts: [
      { firstName: "Patricia", lastName: "Nguyen", title: "Operations Manager", decisionRole: "OPERATIONS_MANAGER", linkedinUrl: "https://linkedin.com/in/patricia-nguyen-lec" },
      { firstName: "Tom", lastName: "Iverson", title: "Site Supervisor", decisionRole: "OTHER", linkedinUrl: null },
    ],
  },
  {
    id: "company-03",
    name: "ChiTown Logistics",
    industry: "Warehouse/Logistics",
    status: "CLIENT",
    city: "Cicero",
    state: "IL",
    estimatedSize: "LARGE",
    commercialScore: 90,
    possibleCategories: ["Warehouse Worker", "Forklift Operator"],
    contacts: [
      { firstName: "Angela", lastName: "Marsh", title: "Warehouse Manager", decisionRole: "OPERATIONS_MANAGER", linkedinUrl: "https://linkedin.com/in/angela-marsh-chitown" },
    ],
  },
  {
    id: "company-04",
    name: "Hoosier Distribution Partners",
    industry: "Warehouse/Logistics",
    status: "CLIENT",
    city: "Gary",
    state: "IN",
    estimatedSize: "ENTERPRISE",
    commercialScore: 88,
    possibleCategories: ["Warehouse Worker", "Forklift Operator"],
    contacts: [
      { firstName: "Michael", lastName: "Brantley", title: "Distribution Center Manager", decisionRole: "OPERATIONS_MANAGER", linkedinUrl: "https://linkedin.com/in/michael-brantley-hdp" },
      { firstName: "Sara", lastName: "Whitfield", title: "HR Coordinator", decisionRole: "HR", linkedinUrl: null },
    ],
  },
  {
    id: "company-05",
    name: "Prairie Manufacturing Co.",
    industry: "Manufacturing",
    status: "PROSPECT",
    city: "Elgin",
    state: "IL",
    estimatedSize: "MEDIUM",
    commercialScore: 65,
    possibleCategories: ["General Labor"],
    contacts: [
      { firstName: "Daniel", lastName: "Ochoa", title: "Plant Manager", decisionRole: "PLANT_MANAGER", linkedinUrl: "https://linkedin.com/in/daniel-ochoa-prairie" },
    ],
  },
  {
    id: "company-06",
    name: "Summit Warehouse Solutions",
    industry: "Warehouse/Logistics",
    status: "PROSPECT",
    city: "Hammond",
    state: "IN",
    estimatedSize: "SMALL",
    commercialScore: 55,
    possibleCategories: ["Warehouse Worker"],
    contacts: [
      { firstName: "Karen", lastName: "Delgado", title: "Procurement Lead", decisionRole: "OTHER", linkedinUrl: null },
    ],
  },
  {
    id: "company-07",
    name: "Union Build Group",
    industry: "Construction",
    status: "LEAD",
    city: "Joliet",
    state: "IL",
    estimatedSize: "MEDIUM",
    commercialScore: 40,
    possibleCategories: ["Apprentice Electrician", "General Labor"],
    contacts: [
      { firstName: "Brian", lastName: "Kowalski", title: "Superintendent", decisionRole: "PROJECT_MANAGER", linkedinUrl: null },
    ],
  },
  {
    id: "company-08",
    name: "Northern Steel Fabricators",
    industry: "Manufacturing",
    status: "LEAD",
    city: "Merrillville",
    state: "IN",
    estimatedSize: "SMALL",
    commercialScore: 35,
    possibleCategories: ["General Labor"],
    contacts: [
      { firstName: "Elena", lastName: "Ramos", title: "Facilities Manager", decisionRole: "OPERATIONS_MANAGER", linkedinUrl: null },
    ],
  },
];

async function seedCompanies(industryMap: Map<string, string>, categoryMap: Map<string, string>) {
  const map = new Map<string, string>();
  for (const c of COMPANIES) {
    const possibleCategoryIds = c.possibleCategories.map((name) => categoryMap.get(name)!);
    const company = await prisma.company.upsert({
      where: { id: c.id },
      update: {
        name: c.name,
        industryId: industryMap.get(c.industry)!,
        status: c.status as never,
        address: { city: c.city, state: c.state },
        city: c.city,
        state: c.state,
        estimatedSize: c.estimatedSize as never,
        commercialScore: c.commercialScore,
        possibleCategories: { set: possibleCategoryIds.map((id) => ({ id })) },
        // F4.5: corrige empresas ya sembradas que quedaron en el default
        // MANUAL de la migración — toda empresa de este seed es DEMO_SEED.
        origin: "DEMO_SEED",
      },
      create: {
        id: c.id,
        tenantId: "tenant-titan",
        name: c.name,
        industryId: industryMap.get(c.industry)!,
        status: c.status as never,
        address: { city: c.city, state: c.state },
        city: c.city,
        state: c.state,
        estimatedSize: c.estimatedSize as never,
        commercialScore: c.commercialScore,
        possibleCategories: { connect: possibleCategoryIds.map((id) => ({ id })) },
        origin: "DEMO_SEED",
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
          decisionRole: contact.decisionRole as never,
          linkedinUrl: contact.linkedinUrl,
        },
        create: {
          id: contactId,
          tenantId: "tenant-titan",
          companyId: company.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          title: contact.title,
          decisionRole: contact.decisionRole as never,
          linkedinUrl: contact.linkedinUrl,
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
// 8.5 Commercial pipeline (F1): Leads, Opportunities, FollowUps
// ============================================================

const LEADS = [
  { id: "lead-01", industry: "Construction", city: "Naperville", state: "IL", source: "web", priority: "MEDIUM", status: "NEW", companyId: null, ownerRole: "Sales", agedDays: 1 },
  { id: "lead-02", industry: "Warehouse/Logistics", city: "Bolingbrook", state: "IL", source: "cold-outreach", priority: "HIGH", status: "CONTACTED", companyId: null, ownerRole: "Sales", agedDays: 6 },
  { id: "lead-03", industry: "Manufacturing", city: "Waukegan", state: "IL", source: "indeed", priority: "MEDIUM", status: "INTERESTED", companyId: null, ownerRole: "Sales", agedDays: 9 },
  { id: "lead-04", industry: "General Labor", city: "Chicago", state: "IL", source: "referral", priority: "HIGH", status: "QUALIFIED", companyId: null, ownerRole: "CEO", agedDays: 4 },
  { id: "lead-05", industry: "Warehouse/Logistics", city: "Hammond", state: "IN", source: "referral", priority: "LOW", status: "NEW", companyId: "company-06", ownerRole: "Sales", agedDays: 8 },
  { id: "lead-06", industry: "Construction", city: "Joliet", state: "IL", source: "web", priority: "MEDIUM", status: "CONTACTED", companyId: "company-07", ownerRole: "Sales", agedDays: 3 },
  { id: "lead-07", industry: "Construction", city: "Rockford", state: "IL", source: "cold-outreach", priority: "LOW", status: "UNQUALIFIED", companyId: null, ownerRole: "Sales", agedDays: 15, notes: "Budget too small for our minimum engagement." },
  { id: "lead-08", industry: "Warehouse/Logistics", city: "Portage", state: "IN", source: "job-board", priority: "HIGH", status: "QUALIFIED", companyId: null, ownerRole: "Sales", agedDays: 5 },
  { id: "lead-09", industry: "Manufacturing", city: "Schaumburg", state: "IL", source: "web", priority: "MEDIUM", status: "NEW", companyId: null, ownerRole: "Marketing", agedDays: 7 },
  { id: "lead-10", industry: "Construction", city: "Naperville", state: "IL", source: "referral", priority: "MEDIUM", status: "INTERESTED", companyId: null, ownerRole: "Sales", agedDays: 10 },
  { id: "lead-11", industry: "General Labor", city: "Cicero", state: "IL", source: "cold-outreach", priority: "LOW", status: "CONTACTED", companyId: null, ownerRole: "Sales", agedDays: 12 },
  { id: "lead-12", industry: "Warehouse/Logistics", city: "Elgin", state: "IL", source: "web", priority: "HIGH", status: "NEW", companyId: null, ownerRole: "Sales", agedDays: 14 },
];

async function seedLeads(tenantId: string, industryMap: Map<string, string>, userMap: Map<string, string>) {
  const map = new Map<string, string>();
  for (const l of LEADS) {
    const lead = await prisma.lead.upsert({
      where: { id: l.id },
      update: {
        status: l.status as never,
        priority: l.priority as never,
      },
      create: {
        id: l.id,
        tenantId,
        companyId: l.companyId,
        industryId: industryMap.get(l.industry)!,
        city: l.city,
        state: l.state,
        source: l.source,
        priority: l.priority as never,
        status: l.status as never,
        ownerId: userMap.get(l.ownerRole)!,
        notes: l.notes ?? null,
        createdAt: daysFromNow(-l.agedDays),
      },
    });
    map.set(l.id, lead.id);
  }
  return map;
}

const OPPORTUNITIES = [
  { id: "opp-01", companyId: "company-01", title: "Additional electricians for Phase 3", category: "Journeyman Electrician", stage: "NEGOTIATION", estimatedWorkers: 6, payRate: 34, billRate: 50, revenue: 180000, probability: 70, closeInDays: 20 },
  { id: "opp-02", companyId: "company-03", title: "Forklift operators — peak season", category: "Forklift Operator", stage: "WON", estimatedWorkers: 12, payRate: 21, billRate: 32, revenue: 95000, probability: 100, closeInDays: -5 },
  { id: "opp-03", companyId: "company-04", title: "Warehouse ramp-up Q4", category: "Warehouse Worker", stage: "PROPOSAL_SENT", estimatedWorkers: 25, payRate: 19, billRate: 29, revenue: 220000, probability: 55, closeInDays: 30 },
  { id: "opp-04", companyId: "company-05", title: "General labor pilot program", category: "General Labor", stage: "MEETING_SCHEDULED", estimatedWorkers: 8, payRate: 18, billRate: 27, revenue: 60000, probability: 35, closeInDays: 25 },
  { id: "opp-05", companyId: "company-06", title: "Warehouse staffing trial", category: "Warehouse Worker", stage: "MEETING_SCHEDULED", estimatedWorkers: 10, payRate: 19, billRate: 28, revenue: 70000, probability: 30, closeInDays: 28 },
  { id: "opp-06", companyId: "company-02", title: "Apprentice electricians — spring build", category: "Apprentice Electrician", stage: "LOST", estimatedWorkers: 4, payRate: 24, billRate: 36, revenue: 40000, probability: 0, closeInDays: -10 },
  { id: "opp-07", companyId: "company-01", title: "Data center Phase 4 (early talks)", category: "Journeyman Electrician", stage: "MEETING_SCHEDULED", estimatedWorkers: 10, payRate: 35, billRate: 52, revenue: 250000, probability: 20, closeInDays: 60 },
  { id: "opp-08", companyId: "company-04", title: "Night shift warehouse expansion", category: "Warehouse Worker", stage: "NEGOTIATION", estimatedWorkers: 15, payRate: 20, billRate: 30, revenue: 140000, probability: 65, closeInDays: 15 },
];

async function seedOpportunities(tenantId: string, categoryMap: Map<string, string>, userMap: Map<string, string>) {
  const map = new Map<string, string>();
  for (const o of OPPORTUNITIES) {
    const opportunity = await prisma.opportunity.upsert({
      where: { id: o.id },
      update: { stage: o.stage as never },
      create: {
        id: o.id,
        tenantId,
        companyId: o.companyId,
        title: o.title,
        stage: o.stage as never,
        categoryId: categoryMap.get(o.category)!,
        estimatedWorkers: o.estimatedWorkers,
        estimatedPayRate: decimal(o.payRate),
        estimatedBillRate: decimal(o.billRate),
        estimatedRevenue: decimal(o.revenue),
        probability: o.probability,
        expectedCloseDate: daysFromNow(o.closeInDays),
        ownerId: userMap.get("Sales")!,
      },
    });
    map.set(o.id, opportunity.id);
  }
  return map;
}

const FOLLOW_UPS = [
  { id: "followup-01", entityType: "company", entityId: "company-05", type: "CALL", dueInDays: 2, priority: "HIGH", status: "PENDING", notes: "Follow up on pilot proposal" },
  { id: "followup-02", entityType: "company", entityId: "company-06", type: "EMAIL", dueInDays: 5, priority: "MEDIUM", status: "PENDING", notes: "Send updated rate sheet" },
  { id: "followup-03", entityType: "lead", entityId: "lead-01", type: "CALL", dueInDays: -2, priority: "HIGH", status: "PENDING", notes: "Discovery call" },
  { id: "followup-04", entityType: "opportunity", entityId: "opp-04", type: "MEETING", dueInDays: 7, priority: "HIGH", status: "PENDING", notes: "Site visit with plant manager" },
  { id: "followup-05", entityType: "company", entityId: "company-07", type: "LINKEDIN", dueInDays: 1, priority: "LOW", status: "PENDING", notes: "Connect + intro message" },
  { id: "followup-06", entityType: "lead", entityId: "lead-05", type: "CALL", dueInDays: -5, priority: "MEDIUM", status: "PENDING", notes: "Check on decision timeline" },
  { id: "followup-07", entityType: "opportunity", entityId: "opp-01", type: "MEETING", dueInDays: 10, priority: "HIGH", status: "PENDING", notes: "Contract negotiation call" },
  { id: "followup-08", entityType: "company", entityId: "company-01", type: "EMAIL", dueInDays: -10, priority: "LOW", status: "DONE", notes: "Sent Q3 recap" },
  { id: "followup-09", entityType: "lead", entityId: "lead-08", type: "CALL", dueInDays: 3, priority: "HIGH", status: "PENDING", notes: "Qualify budget" },
  { id: "followup-10", entityType: "company", entityId: "company-03", type: "MEETING", dueInDays: 14, priority: "MEDIUM", status: "PENDING", notes: "Quarterly business review" },
];

async function seedFollowUps(tenantId: string, userMap: Map<string, string>) {
  for (const f of FOLLOW_UPS) {
    await prisma.followUp.upsert({
      where: { id: f.id },
      update: { status: f.status as never },
      create: {
        id: f.id,
        tenantId,
        entityType: f.entityType,
        entityId: f.entityId,
        type: f.type as never,
        dueDate: daysFromNow(f.dueInDays),
        priority: f.priority as never,
        assignedToId: userMap.get("Sales")!,
        status: f.status as never,
        notes: f.notes,
        completedAt: f.status === "DONE" ? daysFromNow(f.dueInDays) : null,
      },
    });
  }
}

// A handful of Activity rows so Revenue Intelligence has something to show:
// recent contact on 3 CLIENT companies (not dormant), none on company-04
// (dormant — its only Activity is 90 days old).
const COMMERCIAL_ACTIVITIES = [
  { id: "commercial-activity-01", entityType: "company", entityId: "company-01", type: "CALL", subject: "Quarterly check-in call", agedDays: 5 },
  { id: "commercial-activity-02", entityType: "company", entityId: "company-02", type: "EMAIL", subject: "Sent updated markup proposal", agedDays: 3 },
  { id: "commercial-activity-03", entityType: "company", entityId: "company-03", type: "MEETING", subject: "On-site walkthrough", agedDays: 8 },
  { id: "commercial-activity-04", entityType: "company", entityId: "company-04", type: "EMAIL", subject: "Initial onboarding email", agedDays: 90 },
];

async function seedCommercialActivities(tenantId: string, userMap: Map<string, string>) {
  for (const a of COMMERCIAL_ACTIVITIES) {
    await prisma.activity.upsert({
      where: { id: a.id },
      update: {},
      create: {
        id: a.id,
        tenantId,
        type: a.type as never,
        subject: a.subject,
        entityType: a.entityType,
        entityId: a.entityId,
        performedById: userMap.get("Sales")!,
        createdAt: daysFromNow(-a.agedDays),
      },
    });
  }
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
// 17. Agent definitions (12) + instances (6)
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
  // F4: graduates from stub — interprets daily directives and orchestrates the Daily Revenue Mission
  { key: "ceo", name: "CEO Agent", description: "Interprets daily revenue directives and orchestrates Campaign, Sales, Outreach, and Market Intelligence Agents to execute them." },
  { key: "admin", name: "Admin Agent", description: "Assists with tenant configuration and user management." },
  // F1: groundwork for F2's AI Sales Agent (packages/agents/src/tools/sales-tools.ts — stubs, no OpenAI yet)
  { key: "market_intelligence", name: "Market Intelligence Agent", description: "Analyzes industries, detects growth, and generates commercial signals." },
  { key: "revenue", name: "Revenue Agent", description: "Scores opportunities and suggests follow-ups to protect pipeline health." },
  // F3: orchestrates the full company pipeline (score → lead → opportunity → follow-up → draft)
  { key: "prospecting", name: "Prospecting Agent", description: "Discovers and processes companies end-to-end into qualified pipeline." },
  // F4: Autonomous Outreach Engine
  { key: "campaign", name: "Campaign Agent", description: "Creates campaigns, selects target companies, measures results, and suggests optimizations." },
  { key: "outreach", name: "Outreach Agent", description: "Plans sequences, personalizes messages just-in-time, and suggests the next step after a reply." },
  { key: "conversation", name: "Conversation Agent", description: "Classifies manually-logged replies into an intent category and recommends the next step." },
  // F4.5A: External Discovery Pilot
  { key: "discovery", name: "Discovery Agent", description: "Finds real companies in public external sources, deduplicates against the CRM, and creates them with full provenance." },
  // F4.6: Contact Intelligence Agent
  { key: "contact_intelligence", name: "Contact Intelligence Agent", description: "Finds real decision-maker contacts for newly discovered companies — never sends anything, only enriches the CRM." },
];

const AGENT_PROMPTS: Record<string, string> = {
  sales: salesAgent.systemPromptTemplate!,
  market_intelligence: marketIntelligenceAgent.systemPromptTemplate ?? "",
  campaign: campaignAgent.systemPromptTemplate!,
  outreach: outreachAgent.systemPromptTemplate!,
  conversation: conversationAgent.systemPromptTemplate!,
  ceo: ceoAgent.systemPromptTemplate!,
};

async function seedAgents(tenantId: string) {
  const definitionMap = new Map<string, string>();

  for (const def of AGENT_DEFINITIONS) {
    // F2/F3: solo los agentes con LLM real tienen un systemPromptTemplate —
    // versionado en código junto a sus tools (ver ../src/definitions en
    // packages/agents), no copiado a mano acá. Los demás siguen "" (stubs).
    const systemPromptTemplate = AGENT_PROMPTS[def.key] ?? "";
    const definition = await prisma.agentDefinition.upsert({
      where: { key: def.key },
      update: { name: def.name, description: def.description, systemPromptTemplate },
      create: { key: def.key, name: def.name, description: def.description, systemPromptTemplate },
    });
    definitionMap.set(def.key, definition.id);
  }

  // F4 (01_ARQUITECTURA_v1.1.md §3.5): agentes que ya ejecutan acciones
  // internas automáticamente y solo gatean lo externo con ApprovalRequest
  // se declaran SEMI_AUTO (Nivel 2) — no ASSISTED (Nivel 1), que describe
  // "nunca ejecuta". Es una corrección de nomenclatura, sin cambio de
  // comportamiento (ver F4_AUTONOMOUS_OUTREACH_PLAN.md, addendum). El CEO
  // Agent se queda ASSISTED: interpreta y reporta, no escribe registros de
  // negocio directamente — eso lo hacen los agentes a los que delega.
  const SEMI_AUTO_AGENT_KEYS = new Set([
    "sales",
    "market_intelligence",
    "prospecting",
    "campaign",
    "outreach",
    "conversation",
    "discovery",
    "contact_intelligence",
  ]);

  for (const key of [
    "recruiter",
    "compliance",
    "assistant",
    "sales",
    "market_intelligence",
    "revenue",
    "prospecting",
    "campaign",
    "outreach",
    "conversation",
    "ceo",
    "discovery",
    "contact_intelligence",
  ]) {
    const definitionId = definitionMap.get(key)!;
    const autonomyLevel = SEMI_AUTO_AGENT_KEYS.has(key) ? "SEMI_AUTO" : "ASSISTED";
    await prisma.agentInstance.upsert({
      where: { tenantId_definitionId: { tenantId, definitionId } },
      update: { autonomyLevel },
      create: {
        tenantId,
        definitionId,
        autonomyLevel,
        isActive: true,
        metrics: { tasksCompleted: 0, costUsdThisMonth: 0, budgetExceeded: false },
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

// F4.7.5 §2: Production Mode — el seed de demo nunca debe poder correr
// contra una base marcada como producción. `packages/db` no depende de
// apps/api/src/core/env.ts (paquetes separados), así que se lee la
// misma variable directo de process.env — mismo nombre y mismo default
// (false) para que nunca haya dos criterios distintos de "estamos en
// producción" en el monorepo.
function assertSeedAllowed(): void {
  const productionMode = process.env.PRODUCTION_MODE === "true";
  if (productionMode) {
    console.error(
      "PRODUCTION_MODE=true — el seed de demo está bloqueado. Nunca se ejecuta contra una base de producción real.",
    );
    process.exit(1);
  }
}

async function main() {
  assertSeedAllowed();
  console.log("Seeding AI Staffing OS (F0)...");

  const tenant = await seedTenant();
  const acmeTenant = await seedSecondTenant(); // F10.1: segundo tenant, alcance mínimo (ver docs/F10_PLAN.md §1.2/§2)
  const permissionIds = await seedPermissions();
  const roleMap = await seedRoles(tenant.id, permissionIds);
  const acmeRoleMap = await seedRoles(acmeTenant.id, permissionIds);
  const userMap = await seedUsers(tenant.id, roleMap);
  const industryMap = await seedIndustries();
  const categoryMap = await seedJobCategories(industryMap);
  const documentTypeMap = await seedDocumentTypes();
  await seedCompanies(industryMap, categoryMap);
  await seedAcmeCompanyAndClientAdmin(acmeTenant.id, acmeRoleMap, industryMap); // F10.1
  await seedLeads(tenant.id, industryMap, userMap);
  await seedOpportunities(tenant.id, categoryMap, userMap);
  await seedFollowUps(tenant.id, userMap);
  await seedCommercialActivities(tenant.id, userMap);

  const { seeds } = await seedCandidates(tenant.id, categoryMap);
  const workers = await seedWorkers(tenant.id, seeds);
  await seedDocuments(tenant.id, workers, documentTypeMap, CATEGORY_SEED_CERTS);
  await seedPortalUsers(tenant.id, roleMap); // F10.1: depende de company-01/worker-01/candidate-029 ya existentes

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
