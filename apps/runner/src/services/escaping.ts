

export function escapeSystemdArgument(value: string): string { return escapeSystemdValue(value, true); }

export function escapeSystemdEnvironment(value: string): string { return escapeSystemdValue(value, false); }

/** Escape systemd unit-file values without allowing specifier or line injection. */
function escapeSystemdValue(value: string, escapeSpaces: boolean): string {
  let escaped = "";
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (character === "%") escaped += "%%";
    else if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += "\\\"";
    else if (character === " " && escapeSpaces) escaped += "\\x20";
    else if (code < 0x20 || code === 0x7f) escaped += `\\x${code.toString(16).padStart(2, "0")}`;
    else escaped += character;
  }
  return escaped;
}

export function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }

/**
 * Quote one argument for the command-line string consumed by a Windows
 * scheduled task.  Backslashes immediately before a quote (including the
 * closing quote) must be doubled according to CommandLineToArgvW rules;
 * otherwise a path such as `C:\\Program Files\\Runmesh\\` loses its final
 * separator or absorbs the closing quote. Empty arguments are quoted too.
 */
function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes);
    result += character;
    backslashes = 0;
  }
  // Escape backslashes before the terminating quote, which is itself
  // syntactically significant to the Windows command-line parser.
  result += "\\".repeat(backslashes * 2);
  return `${result}"`;
}

export function windowsArguments(values: readonly string[]): string { return values.map(quoteWindowsArgument).join(" "); }
