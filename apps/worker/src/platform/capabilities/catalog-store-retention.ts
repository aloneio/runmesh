import { CATALOG_LIMITS, type CatalogHead } from "../../contracts/catalog.js";

type SnapshotMetadata = { readonly profile_id: string; readonly digest: string; readonly bytes: number };

/** Plan before deleting: an unsuccessful reservation leaves every snapshot in
 * place. Current observed/approved versions on every profile are always kept;
 * unreferenced history expires oldest-first only when a budget requires it. */
export function catalogEvictions(sql: SqlStorage, profileId: string, incomingBytes: number,
  readHead: (id: string) => CatalogHead | undefined): readonly SnapshotMetadata[] | undefined {
  const budget = sql.exec<{ n: number; bytes: number; versions: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(CASE WHEN profile_id=? THEN 1 ELSE 0 END),0) AS versions FROM catalog_snapshots_v1", profileId).one();
  const fits = () => budget.n < CATALOG_LIMITS.snapshots && budget.bytes + incomingBytes <= CATALOG_LIMITS.storage_bytes
    && budget.versions < CATALOG_LIMITS.versions_per_profile;
  if (fits()) return [];
  const rows = sql.exec<SnapshotMetadata>(
    "SELECT profile_id,digest,bytes FROM catalog_snapshots_v1 ORDER BY rowid LIMIT ?", CATALOG_LIMITS.snapshots + 1).toArray();
  if (rows.length > CATALOG_LIMITS.snapshots || rows.length !== budget.n) return undefined;
  const heads = new Map<string, CatalogHead | undefined>(), selected = new Set<SnapshotMetadata>();
  const select = (row: SnapshotMetadata): void => {
    if (selected.has(row)) return;
    if (!heads.has(row.profile_id)) heads.set(row.profile_id, readHead(row.profile_id));
    const head = heads.get(row.profile_id);
    // An orphan has no trustworthy publication state. Leave it for explicit
    // storage recovery rather than treating damaged metadata as free space.
    if (!head || row.digest === head.observed_digest || row.digest === head.approved_digest) return;
    selected.add(row); budget.n--; budget.bytes -= row.bytes;
    if (row.profile_id === profileId) budget.versions--;
  };
  for (const row of rows) {
    if (budget.versions < CATALOG_LIMITS.versions_per_profile) break;
    if (row.profile_id === profileId) select(row);
  }
  for (const row of rows) {
    if (fits()) break;
    select(row);
  }
  return fits() ? [...selected] : undefined;
}
