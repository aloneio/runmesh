import { CATALOG_LIMITS, type CatalogCursorCodec } from "../../contracts/catalog.js";
import { catalogJson } from "../../contracts/catalog-json.js";
import { parseCatalogCursor } from "../../contracts/catalog-values.js";

const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const decode = (value: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > CATALOG_LIMITS.cursor_bytes) throw new Error("catalog_cursor_invalid");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error("catalog_cursor_invalid");
  return bytes;
};
export const newCatalogCursorKey = (): string => encode(crypto.getRandomValues(new Uint8Array(32)));
export async function catalogSha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Key is owner-local, independent of credentials. MACs are not authorization:
 * every page still checks live identity, grants and all relevant revisions. */
export function createCatalogCursor(namespace: string, loadKey: () => string): CatalogCursorCodec {
  const key = async (): Promise<CryptoKey> => {
    const raw = decode(loadKey());
    try {
      if (raw.byteLength !== 32) throw new Error("catalog_cursor_key_invalid");
      return await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    } finally { raw.fill(0); }
  };
  const message = (body: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(`runmesh-catalog-cursor-v1:${namespace}:${body}`);
  return {
    async seal(value) {
      const cursor = parseCatalogCursor(value), canonical = cursor === undefined ? undefined : catalogJson(cursor, 1024);
      if (canonical === undefined) throw new Error("catalog_cursor_invalid");
      const body = encode(new TextEncoder().encode(canonical));
      return body + "." + encode(new Uint8Array(await crypto.subtle.sign("HMAC", await key(), message(body))));
    },
    async open(value) {
      if (typeof value !== "string" || value.length > CATALOG_LIMITS.cursor_bytes || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value)) return undefined;
      const [body, signature] = value.split(".");
      let mac: Uint8Array<ArrayBuffer>, bytes: Uint8Array<ArrayBuffer>;
      try { mac = decode(signature!); bytes = decode(body!); } catch { return undefined; }
      if (!await crypto.subtle.verify("HMAC", await key(), mac, message(body!))) return undefined;
      try { return parseCatalogCursor(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
      catch { return undefined; }
    },
  };
}
