import { fileURLToPath } from "node:url";
import { writeBrowserAssets } from "./generate-browser-assets.mjs";
import "./generate-build-provenance.mjs";

// Wrangler invokes this from either supported working directory. Preserve
// provenance failure and do not bundle a missing or stale browser module.
if (!process.exitCode) await writeBrowserAssets(fileURLToPath(new URL("../", import.meta.url)));
