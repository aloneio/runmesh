import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const patterns = ["*.ts", "*.mjs", "*.json", "*.jsonc", "*.md", "*.yml", "*.yaml", ".gitattributes", "LICENSE", "NOTICE"];
const requestedFiles = process.argv.slice(2);
const files = requestedFiles.length > 0
  ? requestedFiles
  : execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...patterns], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const errors = [];
for (const file of files) {
  const bytes = await readFile(file);
  const rawText = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(rawText, "utf8"))) errors.push(`${file}: invalid UTF-8`);
  // Git may materialize checked-in LF files as CRLF on Windows. Normalize
  // that platform line ending while still rejecting lone carriage returns.
  const text = rawText.replaceAll("\r\n", "\n");
  if (text.includes("\r")) errors.push(`${file}: stray CR character`);
  if (!text.endsWith("\n")) errors.push(`${file}: missing final newline`);
  const trailingWhitespace = text.split("\n").findIndex((line) => /[ \t]+$/.test(line));
  if (trailingWhitespace >= 0) errors.push(`${file}:${trailingWhitespace + 1}: trailing whitespace`);
}
if (errors.length > 0) throw new Error(`format check failed:\n${errors.join("\n")}`);
console.log(`format check passed: ${files.length} files`);
