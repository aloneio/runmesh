import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const [entry = resolve(repositoryRoot, "apps/runner/src/cli.ts"), output = resolve(repositoryRoot, "apps/runner/dist/coding-runner.mjs")] = process.argv.slice(2);
await mkdir(dirname(resolve(output)), { recursive: true });
await rm(resolve(output), { force: true });
await build({
  entryPoints: [resolve(entry)],
  outfile: resolve(output),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  packages: "bundle",
  banner: { js: "" },
  define: { "process.env.RUNMESH_RUNNER_VERSION": JSON.stringify(process.env.RUNMESH_RUNNER_VERSION ?? "0.1.0-dev.1"), "process.env.RUNMESH_RUNNER_BUNDLE": JSON.stringify("1") },
  legalComments: "none",
  sourcemap: false,
  minify: false,
});
