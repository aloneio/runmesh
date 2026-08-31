import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Older builds emitted an ESM bundle at this path. Remove it before every
// package build so a stale, untested artifact cannot be included by `npm pack`.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await rm(resolve(repositoryRoot, "apps/runner/dist/index.bundle.js"), { force: true });
