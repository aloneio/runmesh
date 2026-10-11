

export function report(output: (line: string) => void, json: boolean, value: unknown): void { output(json ? JSON.stringify(value) : human(value)); }

const reportedCliErrors = new WeakSet<object>();

/** Keep the original error identity, including frozen errors and subclasses. */
export function markCliErrorReported(error: unknown): unknown {
  const reported = error !== null && (typeof error === "object" || typeof error === "function")
    ? error : new Error(String(error), { cause: error });
  reportedCliErrors.add(reported);
  return reported;
}

export function isCliErrorReported(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function") && reportedCliErrors.has(error);
}

function human(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512); }

export function formatMode(mode: number | undefined): string { return mode === undefined ? "missing" : `0${mode.toString(8)}`; }
