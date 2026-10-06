import { mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_VERSION } from "./product-version.mjs";
import { maintenanceRuntimeInputProblem } from "./architecture-policy.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
/** Common bundler. Stable callers keep the source version; the dev packager
 * explicitly supplies its validated prerelease plan without editing source. */
export async function bundleRunner(entry, output, format = "cjs", version = PRODUCT_VERSION) {
  if (format !== "cjs" && format !== "esm") throw new Error("Runner bundle format must be cjs or esm");
  if (version !== PRODUCT_VERSION && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.(0|[1-9]\d*)$/u.test(version)) throw new Error("Only a development prerelease may override the bundled source version");
  await mkdir(dirname(resolve(output)), { recursive: true });
  await rm(resolve(output), { force: true });
  const maintenance = /^maintenance-entry\.(?:[cm]?[jt]s|[jt]sx)$/u.test(basename(entry));
  const result = await build({
  entryPoints: [resolve(entry)],
  outfile: resolve(output),
  bundle: true,
  platform: "node",
  format,
  target: "node20",
  packages: "bundle",
  banner: { js: "" },
  define: { "process.env.RUNMESH_RUNNER_VERSION": JSON.stringify(version) },
  legalComments: "none",
  sourcemap: false,
  minify: false,
  metafile: maintenance,
  write: !maintenance,
  });
  if (maintenance) {
    // Inspect the actual bundle graph, including transitive adapters and
    // tree-shaken modules. A source-only rule cannot prove package isolation.
    for (const input of Object.keys(result.metafile.inputs)) {
      const path = relative(repositoryRoot, resolve(input)).replaceAll("\\", "/");
      const reason = maintenanceRuntimeInputProblem(path);
      const external = /(?:^|\/)node_modules\//u.test(path) && !/(?:^|\/)node_modules\/zod\//u.test(path);
      if (reason || external) throw new Error(`Maintenance bundle includes ${path}: ${reason ?? "unreviewed maintenance runtime dependency"}`);
    }
    for (const file of result.outputFiles) await writeFile(file.path, file.contents);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [entry = resolve(repositoryRoot, "apps/runner/src/runmesh-entry.ts"), output = resolve(repositoryRoot, "apps/runner/dist/runmesh.cjs"), format = "cjs"] = process.argv.slice(2);
  await bundleRunner(entry, output, format);
}
