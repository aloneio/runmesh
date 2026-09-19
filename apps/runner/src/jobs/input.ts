import type { Writable } from "node:stream";

/** One stdin delivery, not proof that the child consumed or acted on the data.
 * Keep lifecycle handling out of JobManager state/cancellation coordination. */
export function deliverJobInput(stdin: Writable, data: string | undefined, closeStdin: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      stdin.removeListener("error", onError);
      stdin.removeListener("close", onClose);
    };
    const settle = (error?: Error | null, errorEventPending = false): void => {
      if (settled) return;
      settled = true;
      // Node calls write/end callbacks before emitting the stream error. Keep
      // the error observer until error/close, including asynchronous destroy,
      // so a rejected input cannot turn into an uncaught Runner-level error.
      if (!errorEventPending) cleanup();
      if (error != null) reject(error); else resolve();
    };
    const onError = (error: Error): void => { cleanup(); settle(error); };
    const onClose = (): void => { cleanup(); settle(new Error("job input stream closed before delivery completed")); };
    const ended = (error?: Error | null): void => { settle(error, error != null); };
    const end = (): void => {
      if (stdin.destroyed || stdin.writableEnded) { settle(new Error("job does not accept input")); return; }
      try { stdin.end(ended); } catch (error) { settle(error instanceof Error ? error : new Error("job input failed")); }
    };
    const written = (error?: Error | null): void => {
      if (settled) return;
      if (error != null) { settle(error, true); return; }
      if (closeStdin) end(); else settle();
    };
    stdin.once("error", onError);
    stdin.once("close", onClose);
    try {
      if (stdin.destroyed || stdin.writableEnded) { settle(new Error("job does not accept input")); return; }
      // The callback confirms this write even when write() returns true.
      // Waiting only for drain both misses buffered-write errors and can wait
      // forever when the stream closes without another drain event.
      if (data !== undefined && data.length > 0) stdin.write(data, "utf8", written);
      else if (closeStdin) end();
      else settle();
    } catch (error) { settle(error instanceof Error ? error : new Error("job input failed")); }
  });
}
