import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { ImportCompanyRow } from "@ai-staffing-os/shared";

const KNOWN_SIZES = new Set(["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"]);

/**
 * F3 §4: sin backend de subida de archivos — todo el parseo pasa en el
 * navegador (CSV vía papaparse, Excel vía SheetJS); el backend solo
 * recibe el array ya normalizado como JSON.
 */
export function parseSpreadsheetFile(file: File): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    if (file.name.toLowerCase().endsWith(".csv")) {
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (result) => resolve(result.data),
        error: (err: Error) => reject(err),
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const workbook = XLSX.read(e.target?.result, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]!];
        const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet!, { defval: "" });
        resolve(rows);
      } catch (err) {
        reject(err as Error);
      }
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Mapeo de columnas por nombre de encabezado (case-insensitive) — sin UI
 * de mapeo interactivo en esta primera versión: si los encabezados del
 * archivo no coinciden con estos nombres, se renombran en la planilla
 * antes de subir. Filas sin name/industryName se descartan (no se
 * inventa ninguno de los dos).
 */
export function normalizeImportRow(raw: Record<string, string>): ImportCompanyRow | null {
  const get = (key: string): string => {
    const foundKey = Object.keys(raw).find((k) => k.trim().toLowerCase() === key.toLowerCase());
    return foundKey ? String(raw[foundKey] ?? "").trim() : "";
  };

  const name = get("name");
  const industryName = get("industryName");
  if (!name || !industryName) return null;

  const sizeRaw = get("estimatedSize").toUpperCase();

  return {
    name,
    industryName,
    city: get("city") || undefined,
    state: get("state") || undefined,
    website: get("website") || undefined,
    estimatedSize: KNOWN_SIZES.has(sizeRaw) ? (sizeRaw as ImportCompanyRow["estimatedSize"]) : undefined,
    contactFirstName: get("contactFirstName") || undefined,
    contactLastName: get("contactLastName") || undefined,
    contactEmail: get("contactEmail") || undefined,
    contactTitle: get("contactTitle") || undefined,
  };
}
