import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const packageVersion = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")).version;
if (typeof packageVersion !== "string" || !SEMVER.test(packageVersion)) {
  throw new Error("root package.json has an invalid product version");
}

export const PRODUCT_VERSION = packageVersion;
