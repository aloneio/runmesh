import { expect, it } from "vitest";
import { HistoryUploadScheduler, type HistoryUploadClock } from "../src/history-upload.js";

class Clock implements HistoryUploadClock {
  public readonly pending = new Map<number, { delay: number; callback: () => void }>();
  private next = 0;
  public schedule(delay: number, callback: () => void): () => void {
    const id = ++this.next; this.pending.set(id, { delay, callback }); return () => { this.pending.delete(id); };
  }
  public async tick(): Promise<void> {
    const item = this.pending.entries().next().value;
    if (item) { this.pending.delete(item[0]); item[1].callback(); }
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  public delay(): number | undefined { return this.pending.values().next().value?.delay; }
}

it("acknowledged idle history has no recurring timer or snapshot across 288 opportunities", async () => {
  const clock = new Clock(); let captures = 0;
  const scheduler = new HistoryUploadScheduler(async revision => { captures++; scheduler.acknowledge(revision); }, clock);
  scheduler.start(300_000); await clock.tick();
  for (let i = 0; i < 288; i++) await clock.tick();
  expect(captures).toBe(1); expect(clock.pending.size).toBe(0);
  expect(scheduler.status()).toEqual({ pending: false, scheduled: false, flushing: false, recovery: false });
});

it("many changes coalesce into one timer and acknowledgements cannot erase newer changes", async () => {
  const clock = new Clock(), revisions: number[] = [];
  const scheduler = new HistoryUploadScheduler(async revision => { revisions.push(revision); }, clock);
  scheduler.start(300_000); await clock.tick(); scheduler.acknowledge(revisions[0]!);
  for (let i = 0; i < 100; i++) scheduler.changed();
  expect(clock.pending.size).toBe(1); expect(clock.delay()).toBe(300_000);
  await clock.tick(); const sent = revisions.at(-1)!;
  scheduler.changed(); scheduler.acknowledge(sent);
  expect(scheduler.status().pending).toBe(true); await clock.tick();
  scheduler.acknowledge(revisions.at(-1)!); expect(clock.pending.size).toBe(0);
  expect(revisions).toHaveLength(3);
});

it("missing receipts retry with a capped backoff instead of an idle periodic scan", async () => {
  const clock = new Clock(), revisions: number[] = [];
  const scheduler = new HistoryUploadScheduler(async revision => { revisions.push(revision); }, clock);
  scheduler.start(300_000); await clock.tick(); expect(clock.delay()).toBe(300_000);
  await clock.tick(); expect(clock.delay()).toBe(600_000);
  await clock.tick(); expect(clock.delay()).toBe(1_200_000);
  for (let i = 0; i < 12; i++) await clock.tick();
  expect(clock.delay()).toBe(3_600_000); expect(new Set(revisions).size).toBe(1);
  scheduler.acknowledge(revisions[0]!); expect(clock.pending.size).toBe(0);
});

it("an old connection finishing a capture cannot restart its timer after reconnect or stop", async () => {
  const clock = new Clock(); let finish: (() => void) | undefined, captures = 0;
  const scheduler = new HistoryUploadScheduler(async () => { captures++; if (captures === 1) await new Promise<void>(resolve => { finish = resolve; }); }, clock);
  scheduler.start(300_000); await clock.tick(); scheduler.stop(); scheduler.start(60_000);
  finish?.(); await clock.tick(); expect(captures).toBe(2); expect(clock.pending.size).toBe(1);
  scheduler.stop(); for (let i = 0; i < 10; i++) await clock.tick(); expect(captures).toBe(2);
});

it("only unresolved recovered history keeps a reconciliation opportunity after acknowledgement", async () => {
  const clock = new Clock(); let captures = 0;
  const scheduler = new HistoryUploadScheduler(async revision => {
    captures++; scheduler.setRecoveryPending(captures < 3); scheduler.acknowledge(revision);
  }, clock);
  scheduler.start(300_000); await clock.tick(); expect(clock.delay()).toBe(300_000);
  await clock.tick(); await clock.tick(); expect(captures).toBe(3); expect(clock.pending.size).toBe(0);
});

it("stopped/off history never schedules work in response to changes", async () => {
  const clock = new Clock(); let captures = 0;
  const scheduler = new HistoryUploadScheduler(async () => { captures++; }, clock);
  for (let i = 0; i < 100; i++) scheduler.changed(); await clock.tick(); expect(captures).toBe(0);
  scheduler.start(60_000); scheduler.stop(); scheduler.changed(); await clock.tick(); expect(captures).toBe(0);
});

it("immediate mode does not postpone a newer change after an inline acknowledgement", async () => {
  const clock = new Clock(); let captures = 0;
  const scheduler = new HistoryUploadScheduler(async revision => {
    captures++; if (captures === 1) scheduler.changed(); scheduler.acknowledge(revision);
  }, clock);
  scheduler.start(300_000, true); await clock.tick(); expect(clock.delay()).toBe(0);
  await clock.tick(); expect(captures).toBe(2); expect(clock.pending.size).toBe(0);
});

it("new immediate activity replaces a recovery-only timer but never shortens an unacknowledged retry", async () => {
  const clock = new Clock(); let acknowledge = true;
  const scheduler = new HistoryUploadScheduler(async revision => {
    scheduler.setRecoveryPending(true); if (acknowledge) scheduler.acknowledge(revision);
  }, clock);
  scheduler.start(300_000, true); await clock.tick(); expect(clock.delay()).toBe(300_000);
  scheduler.changed(); expect(clock.delay()).toBe(0);
  acknowledge = false; await clock.tick(); expect(clock.delay()).toBe(300_000);
  scheduler.changed(); expect(clock.delay()).toBe(300_000);
  scheduler.stop();
});

it("a delayed receipt prioritizes newer immediate changes even while recovered processes remain", async () => {
  const clock = new Clock(); let captured = 0;
  const scheduler = new HistoryUploadScheduler(async revision => {
    captured = revision; scheduler.setRecoveryPending(true); scheduler.changed();
  }, clock);
  scheduler.start(300_000, true); await clock.tick(); expect(clock.delay()).toBe(300_000);
  scheduler.acknowledge(captured);
  expect(scheduler.status().pending).toBe(true); expect(clock.delay()).toBe(0);
  scheduler.stop();
});
