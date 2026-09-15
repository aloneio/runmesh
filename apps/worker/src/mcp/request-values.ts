

export function boundedReadParams(params: Record<string, unknown>, max: number): Record<string, unknown> {
  const requested = typeof params.limit === "number" ? params.limit : max;
  return { ...params, limit: Math.min(requested, max) };
}
