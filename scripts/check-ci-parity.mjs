import { readFile } from "node:fs/promises";
import { validateCiWiring } from "./ci-policy.mjs";
const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
try { console.log(JSON.stringify(validateCiWiring(JSON.parse(await read("package.json")), await read(".github/workflows/ci.yml"), await read(".gitlab-ci.yml")))); }
catch (error) { console.error("CI execution contract failed:", error.message); process.exitCode = 1; }
