/**
 * F10.5: interfaz desacoplada de almacenamiento de documentos --
 * NINGÚN proveedor real de storage (S3/GCS/etc.) existe todavía en este
 * proyecto (confirmado por auditoría: `Document.fileUrl` siempre fue un
 * `String?` de texto libre, nunca hubo un endpoint de upload real de
 * bytes). Esta interfaz existe para que el día que se conecte un
 * proveedor real, solo haga falta una implementación nueva -- ningún
 * módulo de negocio cambia (mismo patrón ya usado por `AuthProvider`,
 * F0/F4.9).
 */

export interface DocumentStorageInput {
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface DocumentStorageResult {
  /** Referencia abstracta -- NUNCA una URL real navegable mientras el adapter sea el mock. */
  reference: string;
  /** "pending" -- explícito para que ningún caller asuma que el archivo ya está disponible para descarga real. */
  status: "pending";
}

export interface DocumentStorageAdapter {
  store(input: DocumentStorageInput): Promise<DocumentStorageResult>;
}
