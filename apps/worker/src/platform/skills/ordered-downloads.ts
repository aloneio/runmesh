/** Run a bounded number of independent reads while retaining input order.
 * Failure cancels sibling requests and waits for their cleanup. There is no
 * asynchronous work left after a failed import or administrator cancellation. */
export async function mapOrderedBounded<T, R>(
  items: readonly T[], concurrency: number, signal: AbortSignal,
  read: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 6)
    throw new Error("invalid_source_concurrency");
  const group = new AbortController();
  const abort = () => group.abort();
  if (signal.aborted) group.abort();
  else signal.addEventListener("abort", abort, { once: true });
  const values = new Array<R>(items.length);
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const run = async () => {
    while (!group.signal.aborted && next < items.length) {
      const index = next++;
      try { values[index] = await read(items[index]!, group.signal); }
      catch (error) {
        if (failure === undefined) failure = { error };
        group.abort();
        return;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, run));
    if (failure !== undefined) throw failure.error;
    if (signal.aborted) throw new Error("source_aborted");
    return values;
  } finally {
    signal.removeEventListener("abort", abort);
    group.abort();
  }
}
