

export function arrayField(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

export function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
