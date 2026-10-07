/** Only values interpreted as data by read-only Git inspection are projected.
 * Includes, paths, commands, helpers, filters and optional extensions never
 * become configuration in the isolated repository. Unknown keys stay inert. */
const coreValues: Readonly<Record<string, readonly string[] | "boolean">> = {
  autocrlf: ["true", "false", "input"], eol: ["lf", "crlf", "native"],
  filemode: "boolean", ignorecase: "boolean", symlinks: "boolean", precomposeunicode: "boolean",
};

/** Lexical boundaries matter even for ignored values: a continued or quoted
 * helper must never be mistaken for a new section or an allowlisted setting. */
function configLines(text: string): string[] {
  if (text.includes("\0")) throw new Error("Git config contains invalid bytes");
  const source = text.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  const lines: string[] = [];
  let line = "", quoted = false, comment = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (comment && char !== "\n") continue;
    if (char === "\n") {
      if (quoted) throw new Error("Git config has an unterminated quoted value");
      lines.push(line); line = ""; comment = false;
    } else if (char === "\\") {
      const next = source[++index];
      if (next === undefined) throw new Error("Git config has an unterminated escape");
      if (next !== "\n") line += char + next;
    } else if (char === '"') { quoted = !quoted; line += char; }
    else if (!quoted && (char === "#" || char === ";")) comment = true;
    else line += char;
  }
  if (quoted) throw new Error("Git config has an unterminated quoted value");
  lines.push(line);
  return lines;
}

function configValue(raw: string | undefined): string {
  if (raw === undefined) return "true"; // A bare key is Git's implicit boolean true.
  let value = "", spaces = "", quoted = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === '"') { value += spaces; spaces = ""; quoted = !quoted; }
    else if (char === "\\") {
      const escaped = raw[++index], decoded = escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "b" ? "\b"
        : escaped === "\\" || escaped === '"' ? escaped : undefined;
      if (decoded === undefined) throw new Error("Git config has an unsupported escape");
      value += spaces + decoded; spaces = "";
    } else if (!quoted && (char === " " || char === "\t")) spaces += char;
    else { value += spaces + char; spaces = ""; }
  }
  if (quoted || value.length > 64) throw new Error("Git inspection config value is invalid");
  return value;
}

function booleanValue(value: string): string | undefined {
  if (["true", "yes", "on"].includes(value.toLowerCase())) return "true";
  if (["false", "no", "off", ""].includes(value.toLowerCase())) return "false";
  // Git's integer booleans use base-0 numbers and optional binary unit suffixes.
  // Preserve safe tokens: Git/libc versions differ on binary prefixes and the
  // signed lower bound, so normalization could hide a native rejection.
  const integer = /^[ \t\n\r\f\v]*([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)$/u.exec(value);
  if (!integer) return undefined;
  const digits = integer[2]!, radix = /^0[0-7]+$/u.test(digits) ? "0o" + digits.slice(1) : digits;
  const units = integer[3]!.toLowerCase(), shift = units === "k" ? 10n : units === "m" ? 20n : units === "g" ? 30n : 0n;
  const number = BigInt(radix) * (integer[1] === "-" ? -1n : 1n) * (1n << shift);
  if (number < -2_147_483_648n || number > 2_147_483_647n) return undefined;
  return integer[1]! + digits + integer[3]!;
}

/** Parse local config as bounded text, never ask Git to load the source config.
 * Section names, comments, quoting, continuations and last-value precedence
 * follow Git syntax; relevant invalid values fail closed instead of defaulting. */
export function isolatedGitConfig(text: string, windows: boolean): string {
  const values = new Map<string, string>([["filemode", windows ? "false" : "true"], ["ignorecase", windows ? "true" : "false"]]);
  let section = "", format = "sha1";
  for (let line of configLines(text)) {
    line = line.replace(/^[ \t]+|[ \t]+$/gu, "");
    if (!line) continue;
    if (line.startsWith("[")) {
      const header = /^\[([A-Za-z0-9.-]+)([ \t]+"(?:[^"\\]|\\.)*")?\][ \t]*/u.exec(line);
      if (!header) throw new Error("Git config section is invalid");
      section = header[2] === undefined ? header[1]!.toLowerCase() : "";
      line = line.slice(header[0].length);
      if (!line) continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*(?:=[ \t]*(.*))?$/u.exec(line);
    if (!entry) throw new Error("Git config entry is invalid");
    const key = entry[1]!.toLowerCase();
    if (section === "extensions" && key === "objectformat") {
      format = configValue(entry[2]);
      if (format !== "sha1" && format !== "sha256") throw new Error("Git object format is unsupported");
    } else if (section === "core" && Object.hasOwn(coreValues, key)) {
      const raw = configValue(entry[2]), allowed = coreValues[key]!;
      const value = allowed === "boolean" || key === "autocrlf" && raw !== "input" ? booleanValue(raw) : allowed.includes(raw) ? raw : undefined;
      if (value === undefined) throw new Error(`Git core.${key} value is unsupported`);
      values.set(key, value);
    }
  }
  return `[core]\n\trepositoryformatversion = ${format === "sha256" ? 1 : 0}\n\tbare = false\n`
    + [...values].map(([key, value]) => `\t${key} = ${value}\n`).join("")
    + (format === "sha256" ? "[extensions]\n\tobjectFormat = sha256\n" : "");
}
