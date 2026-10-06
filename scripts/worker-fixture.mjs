import { setTimeout as delay } from "node:timers/promises";

/** Wait for Wrangler's bound port over IPC, then probe the application under
 * one deadline. The child owns its port from bind(0) until fixture teardown. */
export function waitForWorker(child, timeout, detail = () => "") {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false, checking = false;
    const finish = (error, origin) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      controller.abort();
      if (error) reject(error); else resolve(origin);
    };
    const failure = message => {
      const output = detail();
      return new Error(`${message}${output ? `\n${output}` : ""}`);
    };
    const onExit = (code, signal) => finish(failure(`Worker exited before readiness (code=${code}, signal=${signal})`));
    const onError = error => finish(failure(`Worker failed to start: ${error.message}`));
    const onMessage = message => {
      if (checking) return;
      if (typeof message === "string") {
        try { message = JSON.parse(message); } catch { return; }
      }
      if (message?.event !== "DEV_SERVER_READY") return;
      if (message.ip !== "127.0.0.1" || !Number.isInteger(message.port) || message.port < 1 || message.port > 65_535) {
        finish(failure("Worker reported an invalid loopback readiness address")); return;
      }
      checking = true;
      const origin = `http://127.0.0.1:${message.port}`;
      void (async () => {
        while (!controller.signal.aborted) {
          try {
            const response = await fetch(`${origin}/health`, { signal: controller.signal });
            await response.body?.cancel();
            if (response.ok) { finish(undefined, origin); return; }
          } catch (error) { if (controller.signal.aborted) throw error; }
          await delay(100, undefined, { signal: controller.signal });
        }
      })().catch(error => finish(error));
    };
    const timer = setTimeout(() => finish(failure(`timed out after ${timeout}ms`)), timeout);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}
