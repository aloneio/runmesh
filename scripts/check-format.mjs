import { readFile } from "node:fs/promises";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("usage: check-format.mjs <file> [...]");
const errors = [];
for (const file of files) {
  const bytes = await readFile(file);
  const text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text, "utf8"))) errors.push(`${file}: invalid UTF-8`);
  if (text.includes("\r")) errors.push(`${file}: CR characters are not allowed`);
  if (!text.endsWith("\n")) errors.push(`${file}: missing final newline`);
  const trailingWhitespace = text.split("\n").findIndex((line) => /[ \t]+$/.test(line));
  if (trailingWhitespace >= 0) errors.push(`${file}:${trailingWhitespace + 1}: trailing whitespace`);
}
if (errors.length > 0) throw new Error(`format check failed:\n${errors.join("\n")}`);
console.log(`format check passed: ${files.length} files`);
