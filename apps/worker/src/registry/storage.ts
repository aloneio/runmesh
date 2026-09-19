/** The same DO storage owns every cross-domain transaction. This adapter does
 * not cache, retry, batch, schedule or convert synchronous SQL into promises. */
export interface RegistryStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(callback: () => T): T;
}
export function registryStorage(storage: Pick<DurableObjectStorage, "sql" | "transactionSync">): RegistryStorage {
  return {
    get sql() { return storage.sql; },
    transactionSync<T>(callback: () => T): T { return storage.transactionSync(callback); },
  };
}
