/** Shared observation types, without filesystem or process dependencies. */
export interface ContextStorageLimits { readonly maxBytes: number; readonly maxRecords: number; readonly maxContexts: number }

export type Stamp = { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number };

export interface ContextStorageFile { readonly contextId: string; readonly revision: number; readonly stamp: Stamp }

export interface ContextStorageInventory {
  readonly exists: boolean; readonly files: readonly ContextStorageFile[]; readonly contexts: number;
  readonly bytes: number; readonly metadataBytes: number; readonly pending: boolean; readonly digest: string;
}
