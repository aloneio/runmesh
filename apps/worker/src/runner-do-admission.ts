import {
  FENCED_ADMISSION, conservativeAdmission, restoreAdmission, sameAdmissionState, validAdmissionState,
  type AdmissionState,
} from "./domain/runner-admission.js";

const ADMISSION_STATE_KEY = "policy-admission-v1";

/** Durable admission state and serialized writes are owned together. A failed
 * persistent mutation must never expose an optimistic authorization grant. */
export class RunnerAdmissionStore {
  private cached: AdmissionState | undefined;
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly storage: Pick<DurableObjectStorage, "get" | "put" | "delete">) {}

  /** Synchronous, final pre-dispatch admission checks use this snapshot. */
  public snapshot(): AdmissionState | undefined { return this.cached; }

  public async read(): Promise<AdmissionState> {
    if (this.cached !== undefined) return this.cached;
    const stored = await this.storage.get<AdmissionState>(ADMISSION_STATE_KEY);
    // The cold read can overlap a newly admitted socket or a mutation fence.
    if (this.cached !== undefined) return this.cached;
    const recovered = restoreAdmission(stored);
    this.cached = recovered.state;
    if (recovered.changed) await this.storage.put(ADMISSION_STATE_KEY, recovered.state);
    return this.cached;
  }

  /** Only transport/mutation coordinators supply the side effects; this queue
   * serializes their persistent transitions and survives a rejected callback. */
  public exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  public async compareAndSet(expected: AdmissionState, next: AdmissionState): Promise<boolean> {
    return this.exclusive(async () => {
      if (!sameAdmissionState(await this.read(), expected)) return false;
      try {
        await this.storage.put(ADMISSION_STATE_KEY, next);
        this.cached = next;
      } catch (error) {
        // Unknown effects must remain fenced in this DO isolate.
        this.cached = conservativeAdmission(next);
        throw error;
      }
      return true;
    });
  }

  public async ensurePersistedFence(expected: AdmissionState): Promise<void> {
    if (!expected.fenced) throw new Error("unfenced admission retry");
    const stored = await this.storage.get(ADMISSION_STATE_KEY);
    if (!validAdmissionState(stored) || !sameAdmissionState(stored, expected)) {
      await this.storage.put(ADMISSION_STATE_KEY, expected);
    }
  }

  /** Fence in memory before an uncertain first mutation write can execute. */
  public async fenceAndPersist(next: AdmissionState): Promise<void> {
    if (!next.fenced) throw new Error("unfenced admission mutation");
    this.cached = next;
    await this.storage.put(ADMISSION_STATE_KEY, next);
  }

  /** Used only inside exclusive() while the caller retains its mutation fence. */
  public async persist(next: AdmissionState): Promise<void> {
    await this.storage.put(ADMISSION_STATE_KEY, next);
    this.cached = next;
  }

  public async deleteAndFence(): Promise<void> {
    await this.storage.delete(ADMISSION_STATE_KEY);
    this.cached = { ...FENCED_ADMISSION };
  }

  public fenceUncertainMutation(mutationId: string): void {
    const current = this.cached;
    if (current?.mutationId === mutationId) this.cached = conservativeAdmission(current);
  }
}
