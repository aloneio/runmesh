import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// URL.pathname is not a valid native Windows path (it retains the leading
// slash before the drive letter). Convert the module URL before resolving so
// release tooling works on both POSIX and Windows hosts.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")).version;
if (typeof packageVersion !== "string" || !SEMVER.test(packageVersion)) {
  throw new Error("root package.json has an invalid product version");
}

export const PRODUCT_VERSION = packageVersion;
