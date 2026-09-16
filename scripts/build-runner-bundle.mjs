import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_VERSION } from "./product-version.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
/** Common bundler. Stable callers keep the source version; the dev packager
 * explicitly supplies its validated prerelease plan without editing source. */
export async function bundleRunner(entry, output, format = "cjs", version = PRODUCT_VERSION) {
  if (format !== "cjs" && format !== "esm") throw new Error("Runner bundle format must be cjs or esm");
  if (version !== PRODUCT_VERSION && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.(0|[1-9]\d*)$/u.test(version)) throw new Error("Only a development prerelease may override the bundled source version");
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
  define: { "process.env.RUNMESH_RUNNER_VERSION": JSON.stringify(version) },
  legalComments: "none",
  sourcemap: false,
  minify: false,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [entry = resolve(repositoryRoot, "apps/runner/src/runmesh-entry.ts"), output = resolve(repositoryRoot, "apps/runner/dist/runmesh.cjs"), format = "cjs"] = process.argv.slice(2);
  await bundleRunner(entry, output, format);
}
