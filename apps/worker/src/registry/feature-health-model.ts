export function summarizeFeatureError(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 240);
    if (typeof error === "string") return error.slice(0, 240);
    try { return JSON.stringify(error).slice(0, 240); } catch { return "feature write failed"; }
  }
