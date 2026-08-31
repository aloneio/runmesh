import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_VERSION } from "./product-version.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const [entry = resolve(repositoryRoot, "apps/runner/src/coding-runner-entry.ts"), output = resolve(repositoryRoot, "apps/runner/dist/coding-runner.cjs"), format = "cjs"] = process.argv.slice(2);
if (format !== "cjs" && format !== "esm") throw new Error("Runner bundle format must be cjs or esm");
await mkdir(dirname(resolve(output)), { recursive: true });
await rm(resolve(output), { force: true });
await build({
  entryPoints: [resolve(entry)],
  outfile: resolve(output),
  bundle: true,
  platform: "node",
  format,
  target: "node20",
  packages: "bundle",
  banner: { js: "" },
  define: { "process.env.RUNMESH_RUNNER_VERSION": JSON.stringify(PRODUCT_VERSION) },
  legalComments: "none",
  sourcemap: false,
  minify: false,
});
