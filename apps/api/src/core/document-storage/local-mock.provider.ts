import { randomUUID } from "node:crypto";
import type { DocumentStorageAdapter, DocumentStorageInput, DocumentStorageResult } from "./adapter";

/**
 * F10.5: implementación mock -- NUNCA guarda bytes reales, nunca toca
 * disco/red. Genera una referencia abstracta con el prefijo `mock://`
 * (nunca confundible con una URL real navegable) para que un revisor
 * humano sepa de un vistazo que ese documento no fue subido de verdad
 * -- "storage adapter pending" es una realidad explícita del sistema,
 * no un bug oculto. Único adapter disponible hoy (ver adapter.ts).
 */
export class LocalMockDocumentStorageProvider implements DocumentStorageAdapter {
  async store(input: DocumentStorageInput): Promise<DocumentStorageResult> {
    const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    return {
      reference: `mock://pending-storage-adapter/${randomUUID()}/${safeName}`,
      status: "pending",
    };
  }
}

export const documentStorageAdapter: DocumentStorageAdapter = new LocalMockDocumentStorageProvider();
