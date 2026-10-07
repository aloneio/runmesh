/** Stop a maintenance retry wait promptly; the caller still owns recovery. */
export function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolveWait => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolveWait(); };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
