import type {
  AgentTaskDetail,
  ImportCompaniesInput,
  ImportCompaniesResult,
  ProcessCompanyPipelineInput,
} from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { logActivity } from "../../core/activity-log";
import { AppError } from "../../core/errors";
import { createQueuedTask, runTaskAsync, toAgentTaskDetail } from "../agents/task-executor";

/**
 * F3 §4: importar es carga de datos, no una decisión del agente — crea
 * Company/Contact directamente, sin pasar por AgentTask/LLM. La IA entra
 * recién en el paso siguiente (processCompanyPipeline, disparado por el
 * scheduler o manualmente vía "Analizar ahora"). Contact solo se crea con
 * datos literales del archivo — nunca inventados (regla heredada de F2).
 */
export async function importCompanies(input: ImportCompaniesInput): Promise<ImportCompaniesResult> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const industries = await scopedDb.industry.findMany();
  const industryByName = new Map(industries.map((i) => [i.name.toLowerCase(), i]));

  const skipped: Array<{ row: number; reason: string }> = [];
  const companyIds: string[] = [];

  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i]!;
    const industry = industryByName.get(row.industryName.toLowerCase());
    if (!industry) {
      skipped.push({ row: i, reason: `Industria "${row.industryName}" no existe — no se inventa una nueva` });
      continue;
    }

    const existing = await scopedDb.company.findFirst({ where: { name: row.name, industryId: industry.id } });
    if (existing) {
      skipped.push({ row: i, reason: `Ya existe una empresa "${row.name}" en esa industria` });
      continue;
    }

    const company = await scopedDb.company.create({
      data: {
        tenantId: ctx.tenantId,
        name: row.name,
        industryId: industry.id,
        status: "LEAD",
        city: row.city,
        state: row.state,
        website: row.website,
        estimatedSize: row.estimatedSize,
        origin: "CSV_IMPORT", // F4.5: transparencia de origen
      },
    });
    await logActivity({ entityType: "company", entityId: company.id, type: "SYSTEM", subject: "Company imported" });

    if (row.contactFirstName && row.contactLastName) {
      const contact = await scopedDb.contact.create({
        data: {
          tenantId: ctx.tenantId,
          companyId: company.id,
          firstName: row.contactFirstName,
          lastName: row.contactLastName,
          email: row.contactEmail,
          title: row.contactTitle,
          isPrimary: true,
          // F24: un humano tipeó este contacto explícitamente en el CSV --
          // CONFIRMED (procedencia), nunca INFERRED (nunca fue scrapeado/
          // adivinado). Distinto de emailVerificationStatus (entregabilidad),
          // que sigue reservado exclusivamente a proveedores reales de
          // verificación -- ver contact-channel.ts.
          verificationStatus: row.contactEmail ? "CONFIRMED" : undefined,
        },
      });
      await logActivity({
        entityType: "company",
        entityId: company.id,
        type: "SYSTEM",
        subject: `Contact imported: ${contact.firstName} ${contact.lastName}`,
      });
    }

    companyIds.push(company.id);
  }

  return { importedCount: companyIds.length, skipped, companyIds };
}

/** "Analizar ahora" — dispara el pipeline completo para una empresa puntual. */
export async function triggerCompanyPipeline(input: ProcessCompanyPipelineInput): Promise<AgentTaskDetail> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const company = await scopedDb.company.findUnique({ where: { id: input.companyId } });
  if (!company) throw AppError.notFound("Company not found");

  const task = await createQueuedTask({
    agentKey: "prospecting",
    type: "process_company_pipeline",
    input: { companyId: input.companyId },
    triggeredBy: "USER",
  });

  runTaskAsync(task.id, ctx.tenantId, ctx.userId);

  return toAgentTaskDetail(task);
}
