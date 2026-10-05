/** Git ref-format rules for full names stored under refs/. Unicode is kept
 * byte-for-byte; Git's forbidden whitespace consists of ASCII bytes only. */
export function isGitRefName(value: string): boolean {
  return value.startsWith("refs/")
    && !/[\x00-\x20\x7f~^:?*\[\\]/u.test(value)
    && !value.includes("..") && !value.includes("@{") && !value.endsWith(".")
    && value.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function gitMetadataValue(value: string): string {
  // Do not use trim(): NBSP and Unicode line separators are legal ref bytes.
  return value.replace(/[\r\n]+$/u, "");
}

export function symbolicGitRef(value: string): string | undefined {
  if (!value.startsWith("ref:")) return undefined;
  const ref = value.slice(4).replace(/^[ \t]+/u, "");
  if (!isGitRefName(ref)) throw new Error("Git symbolic ref is malformed");
  return ref;
}
