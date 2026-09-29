import { encodeBase64Url as encode, decodeBase64Url } from "../../contracts/base64url.js";
import { CATALOG_LIMITS, type CatalogCursorCodec } from "../../contracts/catalog.js";
import { catalogJson } from "../../contracts/catalog-json.js";
import { parseCatalogCursor } from "../../contracts/catalog-values.js";

const decode = (value: string): Uint8Array<ArrayBuffer> => {
  const bytes = decodeBase64Url(value, CATALOG_LIMITS.cursor_bytes);
  if (bytes === undefined) throw new Error("catalog_cursor_invalid");
  return bytes;
};
export const newCatalogCursorKey = (): string => encode(crypto.getRandomValues(new Uint8Array(32)));
export async function catalogSha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Key is owner-local, independent of credentials. MACs are not authorization:
 * every page still checks live identity, publications and all relevant revisions. */
export function createCatalogCursor(namespace: string, loadKey: () => string): CatalogCursorCodec {
  const key = async (): Promise<CryptoKey> => {
    const raw = decode(loadKey());
    try {
      if (raw.byteLength !== 32) throw new Error("catalog_cursor_key_invalid");
      return await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    } finally { raw.fill(0); }
  };
  const message = (body: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(`runmesh-catalog-cursor-v2:${namespace}:${body}`);
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
