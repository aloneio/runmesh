import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
test("message keys, locales and format arguments are checked by the real compiler", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "runmesh-message-types-"));
  try {
    const specifier = file => { const path = relative(dir, join(root, file)); const value = path.replaceAll("\\", "/"); return isAbsolute(path) || value.startsWith(".") ? value : "./" + value; };
    const source = [
      `import { message } from ${JSON.stringify(specifier("apps/worker/src/i18n/messages.js"))};`,
      `import { formatMessage } from ${JSON.stringify(specifier("apps/worker/src/i18n/format-message.js"))};`,
      'message("action.delete", "en");',
      'formatMessage("count.connected", "zh-CN", { count: 2 });',
      '// @ts-expect-error Free-form labels are not stable message keys.',
      'message("Delete", "en");',
      '// @ts-expect-error Unsupported locale cannot silently enter the renderer.',
      'message("action.delete", "fr");',
      '// @ts-expect-error Parameter shape belongs to its message key.',
      'formatMessage("enrollment.validUntil", "en", { count: 2 });',
      '// @ts-expect-error Counts are not arbitrary strings.',
      'formatMessage("count.connected", "en", { count: "2" });',
    ].join("\n");
    const file = join(dir, "consumer.mts"); await writeFile(file, source);
    await promisify(execFile)(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", file], { cwd: root, timeout: 30000, maxBuffer: 1048576, windowsHide: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
