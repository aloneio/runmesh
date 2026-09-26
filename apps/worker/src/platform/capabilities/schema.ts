type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** Namespace initialization only. Feature repositories own their own schemas. */
export class CentralSchema {
  private initialized = false;
  public constructor(private readonly storage: Storage) {}

  public initialize(): void {
    if (this.initialized) return;
    this.storage.transactionSync(() => {
      const tables = this.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__cf_%'").toArray();
      if (!tables.some(table => table.name === "capabilities_meta")) {
        if (tables.length !== 0) throw new Error("capabilities_schema_unsupported");
        this.storage.sql.exec("CREATE TABLE capabilities_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL)");
        this.storage.sql.exec("INSERT INTO capabilities_meta VALUES (1,1)");
      } else {
        const meta = this.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM capabilities_meta WHERE id=1").toArray();
        if (meta.length !== 1 || meta[0]?.schema_version !== 1) throw new Error("capabilities_schema_unsupported");
      }
    });
    this.initialized = true;
  }
}
