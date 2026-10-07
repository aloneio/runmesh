import type { ServicePlatform } from "./contracts.js";

export type ManifestOwner = "runner" | "maintenance";
const markers: Record<ManifestOwner, string> = { runner: "runmesh-runner-managed", maintenance: "runmesh-maintenance-managed" };

export function hashContent(content: string): string {
  let hash = 2166136261;
  for (const byte of Buffer.from(content, "utf8")) { hash ^= byte; hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Ownership is bound to the exact body and to one service, including on rollback. */
export function parseOwnedManifest(content: string, owner: ManifestOwner): { body: string; hash: string; newline: string } | undefined {
  const marker = markers[owner];
  const match = new RegExp(`^(?:#[ \\t]*${marker}:([0-9a-f]{8})[ \\t]*|<!--[ \\t]*${marker}:([0-9a-f]{8})[ \\t]*-->)(\\r?\\n)`, "u").exec(content);
  if (match === null) return undefined;
  const body = content.slice(match[0].length), hash = match[1] ?? match[2]!;
  return hashContent(body) === hash ? { body, hash, newline: match[3]! } : undefined;
}

export function ownedManifest(body: string, platform: ServicePlatform, owner: ManifestOwner, newline = "\n"): { content: string; hash: string } {
  const hash = hashContent(body), marker = `${markers[owner]}:${hash}`;
  return { hash, content: (platform === "linux" ? `# ${marker}` : `<!-- ${marker} -->`) + newline + body };
}
